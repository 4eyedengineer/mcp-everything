import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HostedServer } from '../../database/entities/hosted-server.entity';
import { K8sReconcilerService } from './k8s-reconciler.service';
import { K8sControlPlaneService, ObservedState } from './k8s-control-plane.service';

describe('K8sReconcilerService', () => {
  let service: K8sReconcilerService;
  let repo: { find: jest.Mock; save: jest.Mock };
  let controlPlane: { observeAll: jest.Mock; isEnabled: jest.Mock; namespace: string };

  function server(overrides: Partial<HostedServer> = {}): HostedServer {
    return {
      id: '1',
      serverId: 'srv-1',
      serverName: 'stripe-mcp',
      status: 'deploying',
      desiredState: 'running',
      observedStatus: null,
      observedMessage: null,
      observedAt: null,
      observedReplicas: null,
      observedReadyReplicas: null,
      k8sDeploymentName: 'mcp-srv-1',
      config: null,
      deployedAt: new Date('2026-01-01T00:00:00Z'),
      lastStatusChange: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    } as HostedServer;
  }

  function observed(overrides: Partial<ObservedState> = {}): ObservedState {
    return {
      serverId: 'srv-1',
      status: 'running',
      message: '1/1 replica(s) ready',
      replicas: 1,
      readyReplicas: 1,
      observedAt: new Date('2026-02-01T00:00:00Z'),
      ...overrides,
    };
  }

  beforeEach(async () => {
    repo = { find: jest.fn().mockResolvedValue([]), save: jest.fn(async (e) => e) };
    controlPlane = {
      observeAll: jest.fn().mockResolvedValue(new Map()),
      isEnabled: jest.fn().mockReturnValue(true),
      namespace: 'mcp-servers',
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        K8sReconcilerService,
        { provide: getRepositoryToken(HostedServer), useValue: repo },
        { provide: K8sControlPlaneService, useValue: controlPlane },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue) },
        },
      ],
    }).compile();

    service = module.get<K8sReconcilerService>(K8sReconcilerService);
  });

  afterEach(() => service.onModuleDestroy());

  describe('reconcileOnce', () => {
    it('writes real observed state and replica counts back to the row', async () => {
      const row = server();
      repo.find.mockResolvedValue([row]);
      controlPlane.observeAll.mockResolvedValue(new Map([['srv-1', observed()]]));

      await service.reconcileOnce();

      expect(repo.save).toHaveBeenCalledTimes(1);
      const saved = repo.save.mock.calls[0][0];
      expect(saved.observedStatus).toBe('running');
      expect(saved.observedReplicas).toBe(1);
      expect(saved.observedReadyReplicas).toBe(1);
      expect(saved.observedAt).toEqual(new Date('2026-02-01T00:00:00Z'));
      // Legacy column stays in sync so the existing UI keeps working.
      expect(saved.status).toBe('running');
    });

    it('flips a server the deploy path optimistically left as deploying to failed on CrashLoopBackOff', async () => {
      // This is the exact bug being fixed: the old code wrote 'running' on
      // git-commit success and nothing ever revisited it.
      const row = server({ status: 'deploying' });
      repo.find.mockResolvedValue([row]);
      controlPlane.observeAll.mockResolvedValue(
        new Map([
          [
            'srv-1',
            observed({
              status: 'failed',
              message: 'CrashLoopBackOff: back-off 5m0s restarting failed container',
              readyReplicas: 0,
            }),
          ],
        ]),
      );

      await service.reconcileOnce();

      const saved = repo.save.mock.calls[0][0];
      expect(saved.status).toBe('failed');
      expect(saved.observedStatus).toBe('failed');
      expect(saved.observedMessage).toContain('CrashLoopBackOff');
      expect(saved.observedReadyReplicas).toBe(0);
    });

    it('surfaces ImagePullBackOff as failed', async () => {
      repo.find.mockResolvedValue([server({ status: 'running' })]);
      controlPlane.observeAll.mockResolvedValue(
        new Map([
          [
            'srv-1',
            observed({
              status: 'failed',
              message: 'ImagePullBackOff: Back-off pulling image',
              readyReplicas: 0,
            }),
          ],
        ]),
      );

      await service.reconcileOnce();

      expect(repo.save.mock.calls[0][0].status).toBe('failed');
    });

    it('writes nothing when nothing changed', async () => {
      const row = server({
        status: 'running',
        observedStatus: 'running',
        observedMessage: '1/1 replica(s) ready',
        observedReplicas: 1,
        observedReadyReplicas: 1,
      });
      repo.find.mockResolvedValue([row]);
      controlPlane.observeAll.mockResolvedValue(new Map([['srv-1', observed()]]));

      await service.reconcileOnce();

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('leaves the last observation alone when the cluster is unreachable', async () => {
      const row = server({ status: 'running', observedStatus: 'running' });
      repo.find.mockResolvedValue([row]);
      controlPlane.observeAll.mockResolvedValue(
        new Map([['srv-1', observed({ status: 'unknown', message: 'ECONNREFUSED' })]]),
      );

      await service.reconcileOnce();

      expect(repo.save).not.toHaveBeenCalled();
      expect(row.status).toBe('running');
    });

    it('skips docker-run servers, which have no Kubernetes objects', async () => {
      repo.find.mockResolvedValue([server({ config: { mode: 'docker-run' } })]);

      await service.reconcileOnce();

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('skips servers that have not been applied to the cluster yet', async () => {
      // Still building the image - no Deployment exists, and stomping this
      // with 'missing'/'failed' would be wrong.
      repo.find.mockResolvedValue([server({ status: 'building', k8sDeploymentName: null as never })]);

      await service.reconcileOnce();

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('does not run two overlapping passes', async () => {
      repo.find.mockResolvedValue([server()]);
      let release: () => void = () => undefined;
      controlPlane.observeAll.mockImplementation(
        () => new Promise((resolve) => {
          release = () => resolve(new Map([['srv-1', observed()]]));
        }),
      );

      const first = service.reconcileOnce();
      // Let the first pass get past its repo.find() await and into the
      // (deliberately hanging) observeAll call before racing a second one.
      await new Promise((resolve) => setImmediate(resolve));

      await service.reconcileOnce(); // should return immediately
      expect(controlPlane.observeAll).toHaveBeenCalledTimes(1);

      release();
      await first;
    });
  });

  describe('missing Deployment handling', () => {
    it('treats a just-deployed server absent from the cluster as still progressing', async () => {
      repo.find.mockResolvedValue([server({ deployedAt: new Date() })]);
      controlPlane.observeAll.mockResolvedValue(new Map()); // not listed at all

      await service.reconcileOnce();

      const saved = repo.save.mock.calls[0][0];
      expect(saved.observedStatus).toBe('progressing');
      expect(saved.status).toBe('deploying');
    });

    it('treats a long-deployed server that has vanished as failed', async () => {
      repo.find.mockResolvedValue([
        server({ deployedAt: new Date('2020-01-01T00:00:00Z'), status: 'running' }),
      ]);
      controlPlane.observeAll.mockResolvedValue(new Map());

      await service.reconcileOnce();

      const saved = repo.save.mock.calls[0][0];
      expect(saved.observedStatus).toBe('missing');
      expect(saved.status).toBe('failed');
    });
  });

  describe('deriveLegacyStatus', () => {
    it('lets user intent win for stopped and deleted', () => {
      expect(
        service.deriveLegacyStatus(server({ desiredState: 'stopped' }), observed({ status: 'running' })),
      ).toBe('stopped');
      expect(
        service.deriveLegacyStatus(server({ desiredState: 'deleted' }), observed({ status: 'running' })),
      ).toBe('deleted');
    });

    it('maps observed states onto the legacy union the frontend understands', () => {
      const running = server();
      expect(service.deriveLegacyStatus(running, observed({ status: 'running' }))).toBe('running');
      expect(service.deriveLegacyStatus(running, observed({ status: 'progressing' }))).toBe('deploying');
      expect(service.deriveLegacyStatus(running, observed({ status: 'failed' }))).toBe('failed');
      expect(service.deriveLegacyStatus(running, observed({ status: 'missing' }))).toBe('failed');
      expect(service.deriveLegacyStatus(running, observed({ status: 'stopped' }))).toBe('deploying');
    });

    it('calls a degraded-but-serving server running, and a degraded-with-nothing-ready one deploying', () => {
      const running = server();
      expect(
        service.deriveLegacyStatus(running, observed({ status: 'degraded', readyReplicas: 1 })),
      ).toBe('running');
      expect(
        service.deriveLegacyStatus(running, observed({ status: 'degraded', readyReplicas: 0 })),
      ).toBe('deploying');
    });

    it('only ever produces values the frontend HostedServerStatus union contains', () => {
      const legacyUnion = [
        'pending',
        'building',
        'pushing',
        'deploying',
        'running',
        'stopped',
        'failed',
        'deleted',
      ];

      for (const status of ['running', 'progressing', 'stopped', 'degraded', 'failed', 'missing'] as const) {
        for (const desiredState of ['running', 'stopped', 'deleted'] as const) {
          const derived = service.deriveLegacyStatus(
            server({ desiredState }),
            observed({ status }),
          );
          expect(legacyUnion).toContain(derived);
        }
      }
    });
  });

  describe('lifecycle', () => {
    it('does not start a timer when there is no usable Kubernetes configuration', () => {
      controlPlane.isEnabled.mockReturnValue(false);

      service.onModuleInit();

      expect((service as unknown as { timer: unknown }).timer).toBeNull();
    });
  });
});
