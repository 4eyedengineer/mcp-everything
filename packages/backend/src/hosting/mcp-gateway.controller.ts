import {
  All,
  Controller,
  Logger,
  MethodNotAllowedException,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { HostingService } from './hosting.service';
import { McpProxyService } from './services/mcp-proxy.service';
import { McpUpstreamResolver } from './services/mcp-upstream-resolver.service';
import {
  HostedServerGatewayGuard,
  RequestWithHostedServerAuth,
} from './guards/hosted-server-gateway.guard';
import { HostedServerGatewayRoute } from '../auth/decorators/hosted-server-gateway.decorator';

/**
 * Methods MCP Streamable HTTP actually uses:
 *   POST   - client -> server JSON-RPC (may be answered with SSE)
 *   GET    - open the server -> client notification stream
 *   DELETE - explicit session teardown
 * OPTIONS is handled by the CORS middleware before routing and never reaches here.
 */
const ALLOWED_METHODS = ['POST', 'GET', 'DELETE'];

/**
 * MCP traffic is the product's data plane, not a control operation: an agent
 * doing real work makes many calls per minute, so the control-plane limits used
 * for deploys (5/min) would be crippling. This is set to catch a runaway loop,
 * not to shape normal use. The global default is 100/min.
 */
const GATEWAY_RATE_LIMIT = { default: { limit: 600, ttl: 60_000 } };

/**
 * The hosted-MCP gateway: the single public origin through which every hosted
 * MCP server is reached.
 *
 * ---------------------------------------------------------------------------
 * WHY A GATEWAY AT ALL
 * ---------------------------------------------------------------------------
 * Hosted servers used to be addressed directly as `https://<serverId>.<domain>`,
 * which put the platform nowhere in the request path. Three things followed
 * from that, all of which this controller fixes:
 *
 *   1. No authentication. `HostedServerApiKeyService.verifyKey()` existed and
 *      was well tested but had no caller, so a hosted server answered anyone who
 *      knew its URL. `HostedServerGatewayGuard` is now that caller.
 *   2. No usage data. `HostingService.trackRequest()` had no caller either, so
 *      `requestCount`/`lastRequestAt` were permanently 0/null - no quota
 *      enforcement and no way to spot an idle server. This route calls it.
 *   3. Nothing to route to. Per-server public origins need wildcard DNS, a
 *      per-server Ingress and a Let's Encrypt certificate each - and the rate
 *      limit of 50 certificates per domain per week means 50 deploys would kill
 *      hosting for a week. `ManifestGeneratorService` correspondingly emits only
 *      a ClusterIP Service, so the old `endpointUrl` pointed at nothing. One
 *      origin needs one certificate, forever.
 * ---------------------------------------------------------------------------
 */
@Controller('api/hosting')
export class McpGatewayController {
  private readonly logger = new Logger(McpGatewayController.name);

  constructor(
    private readonly hostingService: HostingService,
    private readonly upstreamResolver: McpUpstreamResolver,
    private readonly mcpProxyService: McpProxyService,
  ) {}

  /**
   * Forward one MCP Streamable HTTP request to the hosted server's process.
   *
   * `@Res()` is used WITHOUT `passthrough: true` deliberately: it hands this
   * method exclusive ownership of the response so Nest never tries to serialise
   * a return value onto it. That is what makes true streaming possible - see
   * the extended rationale on `McpProxyService.proxy()`. Returning a value from
   * here (or using an interceptor that maps the response) would reintroduce
   * exactly the buffering this endpoint exists to avoid.
   */
  @Throttle(GATEWAY_RATE_LIMIT)
  @HostedServerGatewayRoute()
  @UseGuards(HostedServerGatewayGuard)
  @All('servers/:serverId/mcp')
  async proxyMcp(
    @Param('serverId') serverId: string,
    @Req() req: RequestWithHostedServerAuth,
    @Res() res: Response,
  ): Promise<void> {
    if (!ALLOWED_METHODS.includes(req.method)) {
      throw new MethodNotAllowedException(
        `${req.method} is not supported by the MCP gateway. Use ${ALLOWED_METHODS.join(', ')}.`,
      );
    }

    // The guard already proved the caller may reach this server, so an
    // unscoped lookup here leaks nothing.
    const server = await this.hostingService.getServer(serverId);

    // Throws 503 with a specific reason when the server is not running or has
    // no HTTP endpoint at all, rather than letting the proxy hang on a dial.
    const upstreamUrl = this.upstreamResolver.resolve(server);

    // Counted before forwarding, so a request that reaches a crashing server is
    // still counted as usage - it consumed platform resources either way. This
    // buffers in memory and returns immediately; it never adds a database
    // round-trip to the request path. See HostingService.trackRequest.
    void this.hostingService.trackRequest(serverId);

    this.logger.debug(
      `MCP ${req.method} -> ${serverId} (${req.hostedServerAuth?.kind}) upstream=${upstreamUrl}`,
    );

    await this.mcpProxyService.proxy(req, res, upstreamUrl, serverId);
  }
}
