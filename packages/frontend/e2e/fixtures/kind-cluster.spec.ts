import { KindClusterFixture, KindClusterStatus, ServerEndpointResult } from './kind-cluster';

// Mock child_process exec
jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

import { exec } from 'child_process';

const mockExec = exec as jest.MockedFunction<typeof exec>;

// Helper to create mock exec implementation
function mockExecSuccess(stdout: string): void {
  mockExec.mockImplementation((cmd, callback: any) => {
    callback(null, { stdout, stderr: '' });
    return {} as any;
  });
}

function mockExecError(message: string): void {
  mockExec.mockImplementation((cmd, callback: any) => {
    const error = new Error(message);
    callback(error, { stdout: '', stderr: message });
    return {} as any;
  });
}

describe('KindClusterFixture', () => {
  let fixture: KindClusterFixture;

  beforeEach(() => {
    fixture = new KindClusterFixture();
    jest.clearAllMocks();
  });

  describe('isClusterRunning', () => {
    it('should return true when cluster is running', async () => {
      mockExecSuccess('Kubernetes control plane is running at https://127.0.0.1:6443');
      const result = await fixture.isClusterRunning();
      expect(result).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(
        'kubectl cluster-info --context kind-mcp-local',
        expect.any(Function)
      );
    });

    it('should return false when cluster is not running', async () => {
      mockExecError('error: context "kind-mcp-local" does not exist');
      const result = await fixture.isClusterRunning();
      expect(result).toBe(false);
    });

    it('should throw when kubectl is not found', async () => {
      mockExecError('command not found: kubectl');
      await expect(fixture.isClusterRunning()).rejects.toThrow(
        'kubectl not found. Please install kubectl'
      );
    });
  });

  describe('isRegistryRunning', () => {
    it('should return true when registry container is running', async () => {
      mockExecSuccess('kind-registry\nsome-other-container');
      const result = await fixture.isRegistryRunning();
      expect(result).toBe(true);
    });

    it('should return false when registry is not running', async () => {
      mockExecSuccess('some-other-container');
      const result = await fixture.isRegistryRunning();
      expect(result).toBe(false);
    });

    it('should throw when docker is not found', async () => {
      mockExecError('command not found: docker');
      await expect(fixture.isRegistryRunning()).rejects.toThrow(
        'docker not found. Please install Docker'
      );
    });
  });

  describe('isIngressReady', () => {
    it('should return true when ingress controller is Running', async () => {
      mockExecSuccess("'Running'");
      const result = await fixture.isIngressReady();
      expect(result).toBe(true);
    });

    it('should return false when ingress controller is not Running', async () => {
      mockExecSuccess("'Pending'");
      const result = await fixture.isIngressReady();
      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      mockExecError('not found');
      const result = await fixture.isIngressReady();
      expect(result).toBe(false);
    });
  });

  describe('isArgoCDHealthy', () => {
    it('should return true when ArgoCD is Running', async () => {
      mockExecSuccess("'Running'");
      const result = await fixture.isArgoCDHealthy();
      expect(result).toBe(true);
    });

    it('should return false when ArgoCD is not Running', async () => {
      mockExecSuccess("'CrashLoopBackOff'");
      const result = await fixture.isArgoCDHealthy();
      expect(result).toBe(false);
    });
  });

  describe('isNamespaceExists', () => {
    it('should return true when namespace exists', async () => {
      mockExecSuccess('NAME          STATUS   AGE\nmcp-servers   Active   10d');
      const result = await fixture.isNamespaceExists();
      expect(result).toBe(true);
    });

    it('should return false when namespace does not exist', async () => {
      mockExecError('Error from server (NotFound): namespaces "mcp-servers" not found');
      const result = await fixture.isNamespaceExists();
      expect(result).toBe(false);
    });
  });

  describe('getClusterStatus', () => {
    it('should return full cluster status', async () => {
      // Mock all methods to return true
      let callCount = 0;
      mockExec.mockImplementation((cmd, callback: any) => {
        callCount++;
        if ((cmd as string).includes('docker ps')) {
          callback(null, { stdout: 'kind-registry', stderr: '' });
        } else if ((cmd as string).includes('ingress-nginx')) {
          callback(null, { stdout: "'Running'", stderr: '' });
        } else if ((cmd as string).includes('argocd')) {
          callback(null, { stdout: "'Running'", stderr: '' });
        } else {
          callback(null, { stdout: 'success', stderr: '' });
        }
        return {} as any;
      });

      const status = await fixture.getClusterStatus();
      expect(status).toEqual({
        clusterRunning: true,
        registryRunning: true,
        ingressReady: true,
        argoCDHealthy: true,
        namespaceExists: true,
      });
    });
  });

  describe('waitForDeployment', () => {
    it('should return true when deployment becomes ready', async () => {
      mockExecSuccess('pod/test-server-xxx condition met');
      const result = await fixture.waitForDeployment('test-server');
      expect(result).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('kubectl wait --namespace mcp-servers'),
        expect.any(Function)
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('--selector=app=test-server'),
        expect.any(Function)
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('--timeout=120s'),
        expect.any(Function)
      );
    });

    it('should return false on timeout', async () => {
      mockExecError('error: timed out waiting for the condition');
      const result = await fixture.waitForDeployment('test-server', 30000);
      expect(result).toBe(false);
    });

    it('should use custom timeout', async () => {
      mockExecSuccess('pod/test-server-xxx condition met');
      await fixture.waitForDeployment('test-server', 60000);
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('--timeout=60s'),
        expect.any(Function)
      );
    });
  });

  describe('testServerEndpoint', () => {
    it('should return parsed response on success', async () => {
      mockExecSuccess('{"status":"ok"}\n200\n0.025');
      const result = await fixture.testServerEndpoint('test-server');
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ status: 'ok' });
      expect(result.responseTime).toBe(25);
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('-H "Host: test-server.mcp.localhost"'),
        expect.any(Function)
      );
    });

    it('should handle non-JSON response', async () => {
      mockExecSuccess('OK\n200\n0.010');
      const result = await fixture.testServerEndpoint('test-server');
      expect(result.status).toBe(200);
      expect(result.body).toBe('OK');
    });

    it('should use custom path', async () => {
      mockExecSuccess('{"healthy":true}\n200\n0.015');
      await fixture.testServerEndpoint('test-server', '/api/status');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('"http://127.0.0.1/api/status"'),
        expect.any(Function)
      );
    });

    it('should return error result on failure', async () => {
      mockExecError('Connection refused');
      const result = await fixture.testServerEndpoint('test-server');
      expect(result.status).toBe(0);
      expect(result.body.error).toContain('Connection refused');
    });
  });

  describe('getPodLogs', () => {
    it('should return pod logs', async () => {
      mockExecSuccess('2024-01-01 Server started\n2024-01-01 Listening on port 3000');
      const logs = await fixture.getPodLogs('test-server');
      expect(logs).toContain('Server started');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('--tail=100'),
        expect.any(Function)
      );
    });

    it('should use custom line count', async () => {
      mockExecSuccess('log line');
      await fixture.getPodLogs('test-server', 50);
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('--tail=50'),
        expect.any(Function)
      );
    });

    it('should return error message on failure', async () => {
      mockExecError('pod not found');
      const logs = await fixture.getPodLogs('test-server');
      expect(logs).toContain('Error fetching logs');
    });
  });

  describe('getServerResources', () => {
    it('should return all server resources', async () => {
      mockExec.mockImplementation((cmd, callback: any) => {
        if ((cmd as string).includes('deployment')) {
          callback(null, { stdout: '{"kind":"Deployment","metadata":{"name":"test"}}', stderr: '' });
        } else if ((cmd as string).includes('service')) {
          callback(null, { stdout: '{"kind":"Service","metadata":{"name":"test"}}', stderr: '' });
        } else if ((cmd as string).includes('ingress')) {
          callback(null, { stdout: '{"kind":"Ingress","metadata":{"name":"test"}}', stderr: '' });
        }
        return {} as any;
      });

      const resources = await fixture.getServerResources('test-server');
      expect(resources.deployment.kind).toBe('Deployment');
      expect(resources.service.kind).toBe('Service');
      expect(resources.ingress.kind).toBe('Ingress');
    });

    it('should return empty objects on missing resources', async () => {
      mockExecError('not found');
      const resources = await fixture.getServerResources('test-server');
      expect(resources.deployment).toEqual({});
      expect(resources.service).toEqual({});
      expect(resources.ingress).toEqual({});
    });
  });

  describe('cleanupTestServer', () => {
    it('should delete server resources', async () => {
      mockExecSuccess('deployment.apps "test-server" deleted');
      await fixture.cleanupTestServer('test-server');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('kubectl delete deployment,service,ingress'),
        expect.any(Function)
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('-l app=test-server'),
        expect.any(Function)
      );
    });

    it('should not throw on cleanup failure', async () => {
      mockExecError('resource not found');
      await expect(fixture.cleanupTestServer('test-server')).resolves.not.toThrow();
    });
  });

  describe('listServers', () => {
    it('should return list of server names', async () => {
      mockExecSuccess("'server1 server2 server3'");
      const servers = await fixture.listServers();
      expect(servers).toEqual(['server1', 'server2', 'server3']);
    });

    it('should return empty array when no servers', async () => {
      mockExecSuccess("''");
      const servers = await fixture.listServers();
      expect(servers).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockExecError('namespace not found');
      const servers = await fixture.listServers();
      expect(servers).toEqual([]);
    });
  });

  describe('ensureClusterReady', () => {
    it('should not throw when cluster is running', async () => {
      mockExecSuccess('Kubernetes control plane is running');
      await expect(fixture.ensureClusterReady()).resolves.not.toThrow();
    });

    it('should throw with setup instructions when cluster is not running', async () => {
      mockExecError('context not found');
      await expect(fixture.ensureClusterReady()).rejects.toThrow(
        'KinD cluster is not running. Please run: ./scripts/kind/setup.sh'
      );
    });
  });
});
