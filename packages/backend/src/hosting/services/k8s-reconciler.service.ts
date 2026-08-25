import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  HostedServer,
  HostedServerObservedStatus,
  HostedServerStatus,
} from '../../database/entities/hosted-server.entity';
import { K8sControlPlaneService, ObservedState } from './k8s-control-plane.service';

/**
 * Writes real, cluster-observed state back onto hosted_servers rows.
 *
 * This is the piece that did not exist before. Previously `status` was set to
 * 'running' the instant a GitOps commit succeeded and then never touched
 * again, so a pod in CrashLoopBackOff or ImagePullBackOff reported 'running'
 * forever and the status endpoint invented replica counts from that string.
 *
 * ---------------------------------------------------------------------------
 * WHY POLL RATHER THAN WATCH
 * ---------------------------------------------------------------------------
 * A Kubernetes watch is the more "correct-looking" option and was rejected:
 *
 *  - A watch is a long-lived HTTP stream that must be re-established on every
 *    disconnect, and must handle 410 Gone when its resourceVersion ages out of
 *    the API server's window. Getting that wrong fails SILENTLY: the stream
 *    just stops delivering and every row freezes at its last observed value -
 *    which is the exact failure mode (stale status nobody notices) this
 *    service exists to eliminate. Any watch implementation therefore still
 *    needs a periodic full resync as a backstop, i.e. it needs this poller
 *    anyway, plus the watch machinery on top.
 *  - Drift detection needs a full resync regardless. If someone deletes a
 *    Deployment with kubectl while the backend is restarting, no event is
 *    ever delivered to us; only a list-based pass notices it is gone.
 *  - Event volume is adverse. A CrashLoopBackOff pod generates a steady
 *    stream of status updates; a watch would turn each into a DB write. The
 *    poller naturally coalesces all of that into one write per interval, and
 *    only when something actually changed (see hasChanged()).
 *  - Cost does not scale with server count. One pass is exactly two API calls
 *    (list Deployments + list Pods, both label-filtered) no matter how many
 *    servers are hosted.
 *  - It is deterministically testable. reconcileOnce() is a plain method over
 *    mocked API responses, with no timers, sockets or reconnect state.
 *
 * The tradeoff is latency: status is up to K8S_RECONCILE_INTERVAL_MS stale
 * (default 10s). That is acceptable for a deployment-status UI and is a strict
 * improvement over "never updates at all".
 */
@Injectable()
export class K8sReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(K8sReconcilerService.name);
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  /** Guards against overlapping passes when a cluster is slow to respond. */
  private running = false;

  /**
   * How long after a deploy a server may report 'missing' before that is
   * treated as a real failure. Covers the window between the API accepting the
   * Deployment and the reconciler's list call observing it.
   */
  private static readonly MISSING_GRACE_MS = 60_000;

  constructor(
    @InjectRepository(HostedServer)
    private readonly hostedServerRepo: Repository<HostedServer>,
    private readonly controlPlane: K8sControlPlaneService,
    private readonly configService: ConfigService,
  ) {
    this.intervalMs = Number(this.configService.get('K8S_RECONCILE_INTERVAL_MS', 10_000));
    // Never reconcile when hosting is not backed by Kubernetes at all -
    // HOSTING_MODE=docker-run servers are managed by LocalDockerHostingService
    // and have no cluster objects to observe.
    this.enabled =
      this.configService.get<string>('HOSTING_MODE', 'kubernetes') !== 'docker-run' &&
      this.configService.get<string>('K8S_RECONCILE_ENABLED', 'true') !== 'false';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Reconciler disabled (HOSTING_MODE=docker-run or K8S_RECONCILE_ENABLED=false)');
      return;
    }

    if (!this.controlPlane.isEnabled()) {
      this.logger.warn(
        'Reconciler not started: no usable Kubernetes configuration. ' +
          'Hosted server status will not be updated.',
      );
      return;
    }

    // A plain timer rather than @nestjs/schedule: this needs no cron
    // expression, and wiring ScheduleModule.forRoot() into AppModule would be
    // a broader change than one interval justifies. unref() so the timer never
    // holds the process open during shutdown or in tests.
    this.timer = setInterval(() => {
      void this.reconcileOnce().catch((error) => {
        this.logger.error(
          `Reconcile pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.intervalMs);
    this.timer.unref?.();

    this.logger.log(`Reconciler started (every ${this.intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One full reconcile pass. Public so it can be driven directly by tests and
   * by any future on-demand refresh, with no timer involved.
   */
  async reconcileOnce(): Promise<void> {
    if (this.running) {
      this.logger.debug('Previous reconcile pass still running; skipping this tick');
      return;
    }
    this.running = true;

    try {
      const servers = await this.loadReconcilableServers();
      if (servers.length === 0) {
        return;
      }

      const observedByServerId = await this.controlPlane.observeAll();

      for (const server of servers) {
        const observed =
          observedByServerId.get(server.serverId) ?? this.missingState(server.serverId);
        await this.applyObservation(server, observed);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Rows worth observing: Kubernetes-backed, not deleted, and far enough
   * through deployment that cluster objects should exist.
   *
   * `k8sDeploymentName` is the gate. HostingService sets it only once
   * applyServer() has actually succeeded, so a server still in 'pending' or
   * 'building' (image not pushed yet) is never observed - which is what stops
   * the reconciler from stomping a legitimate in-progress build status with
   * 'missing'.
   */
  private async loadReconcilableServers(): Promise<HostedServer[]> {
    const candidates = await this.hostedServerRepo.find({
      where: { desiredState: Not(In(['deleted'])) },
    });

    return candidates.filter(
      (server) =>
        !!server.k8sDeploymentName &&
        server.status !== 'deleted' &&
        // docker-run servers have no Kubernetes objects at all.
        (server.config as Record<string, unknown> | null)?.mode !== 'docker-run',
    );
  }

  /**
   * Persist an observation, and re-derive the legacy `status` column from it.
   * Writes nothing when nothing changed, so a steady-state cluster produces no
   * database traffic.
   */
  private async applyObservation(server: HostedServer, observed: ObservedState): Promise<void> {
    // 'unknown' means we failed to reach the cluster, not that the server is
    // in a bad state. Recording it would flap the UI on every transient
    // network blip, so the previous observation is left in place.
    if (observed.status === 'unknown') {
      this.logger.debug(`Skipping ${server.serverId}: ${observed.message}`);
      return;
    }

    const effectiveObserved = this.applyMissingGrace(server, observed);
    const derivedStatus = this.deriveLegacyStatus(server, effectiveObserved);

    if (!this.hasChanged(server, effectiveObserved, derivedStatus)) {
      return;
    }

    server.observedStatus = effectiveObserved.status as HostedServerObservedStatus;
    server.observedMessage = effectiveObserved.message;
    server.observedAt = effectiveObserved.observedAt;
    server.observedReplicas = effectiveObserved.replicas;
    server.observedReadyReplicas = effectiveObserved.readyReplicas;

    if (server.status !== derivedStatus) {
      this.logger.log(
        `${server.serverId}: ${server.status} -> ${derivedStatus} (observed ${effectiveObserved.status}: ${effectiveObserved.message})`,
      );
      server.status = derivedStatus;
      server.lastStatusChange = effectiveObserved.observedAt;
    }
    server.statusMessage = effectiveObserved.message;

    await this.hostedServerRepo.save(server);
  }

  /**
   * A Deployment that was applied seconds ago and is not in the list yet is
   * still rolling out, not failed. Without this the first pass after a deploy
   * would flip a healthy server to 'failed' and back.
   */
  private applyMissingGrace(server: HostedServer, observed: ObservedState): ObservedState {
    if (observed.status !== 'missing') {
      return observed;
    }

    const appliedAt = server.deployedAt || server.lastStatusChange;
    const age = appliedAt ? Date.now() - new Date(appliedAt).getTime() : Number.MAX_SAFE_INTEGER;

    if (age < K8sReconcilerService.MISSING_GRACE_MS) {
      return {
        ...observed,
        status: 'progressing',
        message: 'Waiting for the Deployment to appear in the cluster',
      };
    }

    return observed;
  }

  /**
   * Collapse (desired, observed) back onto the legacy `status` union the
   * frontend already understands, so the UI keeps working unchanged.
   *
   * Intent wins for the two terminal intents: a server the user stopped reads
   * 'stopped' even while its last pod is still terminating, and a deleted one
   * stays 'deleted'.
   */
  deriveLegacyStatus(server: HostedServer, observed: ObservedState): HostedServerStatus {
    if (server.desiredState === 'deleted') {
      return 'deleted';
    }
    if (server.desiredState === 'stopped') {
      return 'stopped';
    }

    switch (observed.status) {
      case 'running':
        return 'running';
      case 'degraded':
        // Still serving on at least one replica - 'running' is the honest
        // answer for a user asking "can I call this?"; observedStatus carries
        // the nuance.
        return observed.readyReplicas > 0 ? 'running' : 'deploying';
      case 'failed':
        return 'failed';
      case 'missing':
        // Desired running, but nothing exists in the cluster past the grace
        // window: something deleted it out from under us.
        return 'failed';
      case 'stopped':
        // Desired running but scaled to 0 - a scale-up is presumably in
        // flight, or drifted. Either way it is not serving yet.
        return 'deploying';
      case 'progressing':
      default:
        return 'deploying';
    }
  }

  private hasChanged(
    server: HostedServer,
    observed: ObservedState,
    derivedStatus: HostedServerStatus,
  ): boolean {
    return (
      server.status !== derivedStatus ||
      server.observedStatus !== observed.status ||
      server.observedMessage !== observed.message ||
      server.observedReplicas !== observed.replicas ||
      server.observedReadyReplicas !== observed.readyReplicas
    );
  }

  private missingState(serverId: string): ObservedState {
    return {
      serverId,
      status: 'missing',
      message: `No Deployment for ${serverId} in namespace ${this.controlPlane.namespace}`,
      replicas: 0,
      readyReplicas: 0,
      observedAt: new Date(),
    };
  }
}
