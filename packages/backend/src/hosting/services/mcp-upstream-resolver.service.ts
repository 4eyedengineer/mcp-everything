import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HostedServer } from '../../database/entities/hosted-server.entity';
import { LocalDockerHostingService } from './local-docker-hosting.service';
import { MCP_SERVICE_PORT, objectNameFor } from './manifest-generator.service';

/**
 * Path every generated MCP server serves Streamable HTTP on. Fixed by the
 * generated server template (and by the reference server used to verify this
 * gateway), not configurable per server.
 */
export const MCP_UPSTREAM_PATH = '/mcp';

/**
 * Works out the real network address of a hosted MCP server's process, for the
 * gateway to forward to.
 *
 * This exists because `HostedServer.endpointUrl` is no longer the upstream:
 * since the gateway landed, `endpointUrl` is the *public, platform-fronted*
 * URL handed to users (`/api/hosting/servers/:serverId/mcp`). The address of
 * the actual pod/container is an internal detail that must be recomputed here,
 * and deliberately never leaves the backend.
 */
@Injectable()
export class McpUpstreamResolver {
  private readonly logger = new Logger(McpUpstreamResolver.name);
  private readonly defaultNamespace: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly localDockerHostingService: LocalDockerHostingService,
  ) {
    this.defaultNamespace = this.configService.get<string>('K8S_NAMESPACE', 'mcp-servers');
  }

  /**
   * Full upstream URL (including `/mcp`) for a hosted server.
   *
   * @throws ServiceUnavailableException when the server is not in a state that
   *         can serve traffic, or is hosted over a transport that has no HTTP
   *         endpoint at all. Never returns a URL that is known not to work.
   */
  resolve(server: HostedServer): string {
    if (server.status !== 'running') {
      throw new ServiceUnavailableException(
        `Hosted server '${server.serverId}' is not running (status: ${server.status}` +
          `${server.statusMessage ? ` - ${server.statusMessage}` : ''}). ` +
          'Start it before sending MCP requests.',
      );
    }

    return `${this.resolveBase(server)}${MCP_UPSTREAM_PATH}`;
  }

  /** Origin only (scheme://host:port), no path. Split out for logging/tests. */
  resolveBase(server: HostedServer): string {
    return this.isDockerRunServer(server)
      ? this.resolveDockerRunBase(server)
      : this.resolveKubernetesBase(server);
  }

  private isDockerRunServer(server: HostedServer): boolean {
    return (server.config as Record<string, unknown> | null)?.mode === 'docker-run';
  }

  /**
   * Kubernetes: the per-server ClusterIP Service that
   * `ManifestGeneratorService.buildService` creates. The object name comes from
   * `objectNameFor()` and the port from `MCP_SERVICE_PORT` - both imported
   * rather than re-spelled, so a rename of either cannot silently desynchronise
   * the gateway from the manifests.
   *
   * The fully-qualified `.svc.cluster.local` form is used rather than the bare
   * service name because the backend may run in a different namespace than the
   * hosted servers (`K8S_NAMESPACE` defaults to `mcp-servers`), which makes the
   * short name resolve to the wrong thing or not at all.
   */
  private resolveKubernetesBase(server: HostedServer): string {
    const namespace = server.k8sNamespace || this.defaultNamespace;
    const serviceName = server.k8sDeploymentName || objectNameFor(server.serverId);
    return `http://${serviceName}.${namespace}.svc.cluster.local:${MCP_SERVICE_PORT}`;
  }

  /**
   * docker-run: a container published on a deterministic loopback port.
   *
   * `httpHostPortFor()` is a pure function of `serverId`, which is exactly why
   * it can be recomputed here instead of being read back off the row.
   *
   * A docker-run server deployed over stdio has no socket to forward to at
   * all - that is a permanent property of how it was launched, not a transient
   * outage, so it gets its own explicit message rather than a generic failure.
   */
  private resolveDockerRunBase(server: HostedServer): string {
    if (!this.isHttpTransport(server)) {
      throw new ServiceUnavailableException(
        `Hosted server '${server.serverId}' was deployed with the stdio transport and has ` +
          'no HTTP endpoint, so it cannot be reached through the MCP gateway. ' +
          'Redeploy it with MCP_TRANSPORT=http.',
      );
    }

    const port = this.localDockerHostingService.httpHostPortFor(server.serverId);
    // 127.0.0.1, not `localhost`: on a dual-stack host `localhost` can resolve
    // to ::1 first while `docker run -p` bound only the IPv4 address, which
    // surfaces as an intermittent ECONNREFUSED.
    return `http://127.0.0.1:${port}`;
  }

  /**
   * Whether a docker-run server is actually listening on HTTP.
   *
   * Preferred source is `config.transportEnv.MCP_TRANSPORT`, which
   * `HostingService.persistDeployEnv` records precisely so a restart can
   * reproduce the transport. Rows written before that existed fall back to the
   * shape of the stored `endpointUrl`, which used to be the literal upstream
   * (`http://localhost:<port>` for HTTP, `docker-exec://...` for stdio).
   */
  private isHttpTransport(server: HostedServer): boolean {
    const config = (server.config || {}) as Record<string, unknown>;
    const transportEnv = (config.transportEnv as Record<string, string> | undefined) || {};
    const transport = transportEnv.MCP_TRANSPORT;

    if (typeof transport === 'string') {
      return transport.toLowerCase() === 'http';
    }

    return typeof server.endpointUrl === 'string' && /^https?:\/\//i.test(server.endpointUrl);
  }
}
