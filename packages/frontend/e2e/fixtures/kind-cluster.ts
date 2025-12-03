import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface KindClusterStatus {
  clusterRunning: boolean;
  registryRunning: boolean;
  ingressReady: boolean;
  argoCDHealthy: boolean;
  namespaceExists: boolean;
}

export interface ServerEndpointResult {
  status: number;
  body: any;
  responseTime: number;
}

export class KindClusterFixture {
  private namespace = process.env.K8S_NAMESPACE || 'mcp-servers';
  private domain = process.env.MCP_HOSTING_DOMAIN || 'mcp.localhost';

  /**
   * Check if KinD cluster is running
   */
  async isClusterRunning(): Promise<boolean> {
    try {
      await execAsync('kubectl cluster-info --context kind-mcp-local');
      return true;
    } catch (error: any) {
      if (error.message?.includes('command not found')) {
        throw new Error(
          'kubectl not found. Please install kubectl: https://kubernetes.io/docs/tasks/tools/'
        );
      }
      return false;
    }
  }

  /**
   * Check if local Docker registry is running
   */
  async isRegistryRunning(): Promise<boolean> {
    try {
      const { stdout } = await execAsync("docker ps --format '{{.Names}}'");
      return stdout.includes('kind-registry');
    } catch (error: any) {
      if (error.message?.includes('command not found')) {
        throw new Error(
          'docker not found. Please install Docker: https://docs.docker.com/get-docker/'
        );
      }
      return false;
    }
  }

  /**
   * Check if nginx ingress controller is ready
   */
  async isIngressReady(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        "kubectl get pods -n ingress-nginx -l app.kubernetes.io/component=controller -o jsonpath='{.items[0].status.phase}'"
      );
      return stdout.replace(/'/g, '').trim() === 'Running';
    } catch {
      return false;
    }
  }

  /**
   * Check if ArgoCD server is healthy
   */
  async isArgoCDHealthy(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        "kubectl get pods -n argocd -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].status.phase}'"
      );
      return stdout.replace(/'/g, '').trim() === 'Running';
    } catch {
      return false;
    }
  }

  /**
   * Check if mcp-servers namespace exists
   */
  async isNamespaceExists(): Promise<boolean> {
    try {
      await execAsync(`kubectl get namespace ${this.namespace}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get full cluster status
   */
  async getClusterStatus(): Promise<KindClusterStatus> {
    const [clusterRunning, registryRunning, ingressReady, argoCDHealthy, namespaceExists] =
      await Promise.all([
        this.isClusterRunning(),
        this.isRegistryRunning(),
        this.isIngressReady(),
        this.isArgoCDHealthy(),
        this.isNamespaceExists(),
      ]);

    return {
      clusterRunning,
      registryRunning,
      ingressReady,
      argoCDHealthy,
      namespaceExists,
    };
  }

  /**
   * Wait for a deployment to be ready
   * @param serverId - The server ID (used as deployment name)
   * @param timeout - Timeout in milliseconds (default 120000)
   */
  async waitForDeployment(serverId: string, timeout = 120000): Promise<boolean> {
    const timeoutSeconds = Math.floor(timeout / 1000);
    try {
      await execAsync(
        `kubectl wait --namespace ${this.namespace} --for=condition=ready pod --selector=app=${serverId} --timeout=${timeoutSeconds}s`
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Test server endpoint via ingress with Host header
   * Based on pattern from scripts/kind/test-e2e.sh
   * @param serverId - The server ID
   * @param path - The path to test (default '/health')
   */
  async testServerEndpoint(serverId: string, path = '/health'): Promise<ServerEndpointResult> {
    const hostname = `${serverId}.${this.domain}`;
    const startTime = Date.now();

    try {
      const { stdout } = await execAsync(
        `curl -s -w '\\n%{http_code}\\n%{time_total}' -H "Host: ${hostname}" "http://127.0.0.1${path}"`
      );

      const lines = stdout.trim().split('\n');
      const responseTime = parseFloat(lines.pop() || '0') * 1000;
      const status = parseInt(lines.pop() || '0', 10);
      const bodyText = lines.join('\n');

      let body: any;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }

      return { status, body, responseTime };
    } catch (error: any) {
      return {
        status: 0,
        body: { error: error.message },
        responseTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Get pod logs for debugging
   * @param serverId - The server ID
   * @param lines - Number of lines (default 100)
   */
  async getPodLogs(serverId: string, lines = 100): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `kubectl logs -n ${this.namespace} -l app=${serverId} --tail=${lines}`
      );
      return stdout;
    } catch (error: any) {
      return `Error fetching logs: ${error.message}`;
    }
  }

  /**
   * Get K8s resources for a server
   */
  async getServerResources(
    serverId: string
  ): Promise<{ deployment: any; service: any; ingress: any }> {
    const [deploymentResult, serviceResult, ingressResult] = await Promise.all([
      execAsync(
        `kubectl get deployment ${serverId} -n ${this.namespace} -o json`
      ).catch(() => ({ stdout: '{}' })),
      execAsync(`kubectl get service ${serverId} -n ${this.namespace} -o json`).catch(() => ({
        stdout: '{}',
      })),
      execAsync(`kubectl get ingress ${serverId} -n ${this.namespace} -o json`).catch(() => ({
        stdout: '{}',
      })),
    ]);

    return {
      deployment: JSON.parse(deploymentResult.stdout || '{}'),
      service: JSON.parse(serviceResult.stdout || '{}'),
      ingress: JSON.parse(ingressResult.stdout || '{}'),
    };
  }

  /**
   * Cleanup test server resources
   */
  async cleanupTestServer(serverId: string): Promise<void> {
    try {
      await execAsync(
        `kubectl delete deployment,service,ingress -n ${this.namespace} -l app=${serverId} --ignore-not-found`
      );
    } catch (error: any) {
      console.warn(`Warning: Failed to cleanup test server ${serverId}: ${error.message}`);
    }
  }

  /**
   * List all servers in namespace
   */
  async listServers(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        `kubectl get deployments -n ${this.namespace} -o jsonpath='{.items[*].metadata.name}'`
      );
      const names = stdout.replace(/'/g, '').trim();
      return names ? names.split(' ') : [];
    } catch {
      return [];
    }
  }

  /**
   * Ensure cluster is running, throw with setup instructions if not
   */
  async ensureClusterReady(): Promise<void> {
    const isRunning = await this.isClusterRunning();
    if (!isRunning) {
      throw new Error(
        'KinD cluster is not running. Please run: ./scripts/kind/setup.sh'
      );
    }
  }
}
