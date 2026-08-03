import { SetMetadata } from '@nestjs/common';

export const IS_HOSTED_SERVER_SOURCE_KEY = 'isHostedServerSource';

/**
 * Marks the hosted-server source-download route so the global `JwtAuthGuard`
 * will step aside for a per-server source token (`mcpsrc_`) instead of
 * rejecting it.
 *
 * Exactly the same shape, and exactly the same caveat, as
 * `@HostedServerGatewayRoute()` - deliberately NOT `@Public()`. `@Public()`
 * disables authentication outright; this only *defers* it, and only for a
 * request that actually presents an `mcpsrc_`-prefixed bearer token:
 *
 *   - `mcpsrc_...` bearer -> the global guard returns true WITHOUT setting
 *     `request.user`, and `HostedServerSourceGuard` (which is mandatory on the
 *     route) verifies the token against that specific server.
 *   - anything else -> the global guard behaves exactly as it does everywhere
 *     else, so a caller with no credential gets the ordinary 401.
 *
 * A separate metadata key from the gateway's, rather than a reuse of it,
 * because the two accept different credential prefixes for different
 * authority: a gateway key must not open the source endpoint, and a source
 * token must not open the MCP gateway. One shared key would make both guards'
 * deferrals fire for both prefixes and leave the distinction resting entirely
 * on the route-level guard.
 *
 * The security of this arrangement rests on the route-level guard always being
 * present. Applying this decorator without `@UseGuards(HostedServerSourceGuard)`
 * would leave `mcpsrc_` requests unauthenticated - so it has exactly one
 * intended consumer, `HostedServerSourceController`.
 */
export const HostedServerSourceRoute = () => SetMetadata(IS_HOSTED_SERVER_SOURCE_KEY, true);
