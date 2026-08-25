import { Controller, Get, Logger, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { HostedServerSourceService } from './hosted-server-source.service';
import {
  HostedServerSourceGuard,
  RequestWithHostedServerSourceAuth,
} from './guards/hosted-server-source.guard';
import { HostedServerSourceRoute } from '../auth/decorators/hosted-server-source.decorator';

/**
 * A pod fetches its source once per start. Even a pod stuck in
 * CrashLoopBackOff is backed off to roughly one start every five minutes, so
 * 20/min per IP is far above any legitimate pattern and still caps how fast a
 * stolen token can be used to pull source repeatedly. The global default is
 * 100/min.
 */
const SOURCE_RATE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/**
 * Serves a hosted MCP server's generated source to its own pod.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT EXISTS
 * ---------------------------------------------------------------------------
 * Generated source was reachable in exactly one place: the backend pod's local
 * `GENERATED_SERVERS_DIR`, an `emptyDir`. A second pod cannot read another
 * pod's `emptyDir`, so no other component - a builder, a runner image, a CI
 * job - could ever get at the source of a server the platform had generated.
 * Every hosting architecture that is not "build in-process on the backend pod"
 * was blocked on that.
 *
 * The fix is not new storage. The source has always been durably in Postgres
 * on the conversation row (`state.generatedCode`); it simply had no reader
 * outside the backend process. This endpoint is that reader.
 * ---------------------------------------------------------------------------
 *
 * ROUTING NOTE: this controller shares the `api/hosting` prefix with
 * `HostingController` (control plane) and `McpGatewayController` (data plane)
 * but owns exactly one path, `servers/:serverId/source`. It is a third
 * controller rather than a method on `HostingController` because every route
 * there is authenticated as a USER via the global guard and `@CurrentUser()`,
 * while this one is authenticated as a SERVER and must have no user in scope -
 * keeping them in separate files is what stops a future edit from casually
 * adding `@CurrentUser()` to a route that will never have one.
 */
@Controller('api/hosting')
export class HostedServerSourceController {
  private readonly logger = new Logger(HostedServerSourceController.name);

  constructor(private readonly sourceService: HostedServerSourceService) {}

  /**
   * `GET /api/hosting/servers/:serverId/source`
   *
   *   200 application/gzip - a .tar.gz of the server's generated files, at the
   *       archive root, so `tar -xzf` into an empty directory yields a
   *       buildable project.
   *   401 - missing, malformed, expired, revoked, or wrong-server token.
   *   404 - unknown server, or source no longer available.
   *
   * `@Res()` is used WITHOUT `passthrough: true`, matching
   * `McpGatewayController.proxyMcp`: it hands this method exclusive ownership
   * of the response so Nest never tries to serialise a return value onto it,
   * which is what allows the archive to be piped out as it is generated rather
   * than buffered. Returning a value from here would reintroduce exactly the
   * buffering this endpoint avoids.
   */
  @Throttle(SOURCE_RATE_LIMIT)
  @HostedServerSourceRoute()
  @UseGuards(HostedServerSourceGuard)
  @Get('servers/:serverId/source')
  async getSource(
    @Param('serverId') serverId: string,
    @Req() req: RequestWithHostedServerSourceAuth,
    @Res() res: Response,
  ): Promise<void> {
    // Throws 404 before anything is written to the response.
    const archive = await this.sourceService.getSourceArchive(serverId);

    this.logger.debug(
      `Source fetch for ${serverId} authorised by token ${req.hostedServerSourceAuth?.sourceTokenId}`,
    );

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    // No Content-Length: the gzipped size is not known until the stream ends,
    // and guessing it would truncate or hang the transfer. Express falls back
    // to chunked transfer encoding, which every HTTP client handles.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Source-File-Count', String(archive.fileCount));

    archive.stream.on('error', (error: Error) => {
      this.logger.error(`Source stream failed for ${serverId}: ${error.message}`);
      // Headers are already sent by the time the stream can fail, so there is
      // no status code left to change. Destroying the socket is what makes the
      // client see a truncated transfer and fail loudly, instead of silently
      // extracting a partial archive.
      res.destroy(error);
    });

    archive.stream.pipe(res);
  }
}
