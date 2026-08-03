import { SetMetadata } from '@nestjs/common';

export const IS_HOSTED_SERVER_GATEWAY_KEY = 'isHostedServerGateway';

/**
 * Marks the hosted-MCP gateway route so the global `JwtAuthGuard` will step
 * aside for a per-server (`mcps_`) API key instead of rejecting it.
 *
 * This is deliberately NOT `@Public()`. `@Public()` disables authentication
 * outright; this decorator only *defers* it, and only for a request that
 * actually presents an `mcps_`-prefixed bearer token:
 *
 *   - `mcps_...` bearer  -> the global guard returns true WITHOUT setting
 *     `request.user`, and `HostedServerGatewayGuard` (which is mandatory on
 *     the route) verifies the key against that specific server.
 *   - anything else (a normal session JWT, or an `mcpe_` platform key) -> the
 *     global guard behaves exactly as it does everywhere else, so
 *     `request.user` is populated by the established path and the route guard
 *     only has to check ownership.
 *
 * The security of this arrangement rests on the route-level guard always being
 * present. Applying this decorator without `@UseGuards(HostedServerGatewayGuard)`
 * would leave `mcps_` requests unauthenticated - so it has exactly one intended
 * consumer, `McpGatewayController`, and should not be reused casually.
 */
export const HostedServerGatewayRoute = () =>
  SetMetadata(IS_HOSTED_SERVER_GATEWAY_KEY, true);
