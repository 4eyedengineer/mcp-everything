import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { IsNull, Repository } from 'typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HostedServerSourceToken } from '../database/entities/hosted-server-source-token.entity';
import { HostedServer } from '../database/entities/hosted-server.entity';

export interface MintedSourceToken {
  /**
   * The full plaintext token. Returned exactly once, here. Only its SHA-256
   * hash is persisted, so this value is unrecoverable afterwards.
   *
   * MUST NOT be logged, returned in an API response to a human, or placed in a
   * URL. Its only legitimate destination is the pod's environment (which lands
   * in a Kubernetes Secret).
   */
  token: string;
  /** Non-secret metadata, safe to log and to report on a deploy result. */
  id: string;
  tokenPrefix: string;
  expiresAt: Date;
}

/**
 * Mints and verifies the credential a hosted server's pod uses to fetch its own
 * source.
 *
 * ===========================================================================
 * DESIGN DECISION 1: REUSABLE UNTIL EXPIRY, NOT SINGLE-USE
 * ===========================================================================
 * The obvious precedent in this codebase is `StreamTicketService`: a 60-second,
 * single-use ticket, consumed on redemption. It is the right shape there and
 * the WRONG shape here, and the difference is worth being explicit about
 * because the surface similarity is misleading.
 *
 * A stream ticket is minted by a browser that is about to redeem it, once,
 * within a second, and can trivially mint another. A source token is minted by
 * the deploy path and redeemed by a Kubernetes pod, and a pod is not a browser:
 *
 *   - Pods restart. CrashLoopBackOff, OOMKill, a failed liveness probe, a node
 *     drain, an eviction under memory pressure - the kubelet restarts the
 *     container and the entrypoint fetches source AGAIN. Nothing re-mints in
 *     between; there is no component watching for "pod restarted, issue a new
 *     credential". A single-use token means the SECOND start 401s, forever,
 *     and the workload is wedged in a crash loop whose cause is a spent
 *     credential rather than anything in the server's own code.
 *   - Deployments scale. `replicas: 2` is two pods fetching the same source
 *     from the same spec. A single-use token means exactly one of them starts
 *     and the other is permanently broken, non-deterministically.
 *   - Rollouts replace pods. Every `kubectl rollout restart`, every image bump,
 *     every spec change creates fresh pods that fetch again from the same
 *     Secret.
 *
 * So: redeemable an unbounded number of times, until it expires or is revoked.
 * The safety property that single-use would have bought is instead bought by
 * (a) narrow scope - one server, read-only, source only, (b) a hard expiry,
 * and (c) `useCount`/`lastUsedAt`, which make abnormal reuse visible in a way
 * a single-use counter never could.
 *
 * ===========================================================================
 * DESIGN DECISION 2: WHY THE TTL IS DAYS, NOT MINUTES
 * ===========================================================================
 * "Shortest lifetime that actually works" is the right instinct, and for this
 * credential the binding constraint is decision 1: the token must still be
 * valid at an arbitrary, unpredictable future moment, because that is when the
 * pod will restart. A 10-minute token works perfectly through the initial
 * deploy and then silently converts any restart after minute 10 into an
 * unrecoverable crash loop - strictly worse than a longer-lived token, because
 * the failure is delayed, rare, and looks like an application bug.
 *
 * Making it genuinely short would require a component that re-mints on pod
 * restart. That component does not exist, and building it is out of scope here
 * (the manifest/control-plane side is owned by a concurrent change). So the
 * honest choice is a bounded, redeploy-refreshed lifetime:
 *
 *   DEFAULT_TTL_DAYS = 30, overridable via HOSTED_SERVER_SOURCE_TOKEN_TTL_DAYS.
 *
 * 30 days bounds the blast radius of a leak, and every redeploy mints a fresh
 * token, so an actively maintained server's credential is routinely rotated.
 * The residual risk is a server left running untouched for over a month, whose
 * pod then restarts: it will fail to fetch and report `401` in its own logs.
 * That is a loud, diagnosable failure, and it is the failure mode we chose over
 * an unbounded credential.
 *
 * ===========================================================================
 * DESIGN DECISION 3: ONE LIVE TOKEN PER SERVER
 * ===========================================================================
 * `mintToken()` revokes the server's existing live tokens. A deploy fully
 * replaces the workload, so the previous generation's credential has no
 * legitimate future reader, and the invariant "at most one live source token
 * per hosted server" makes the blast radius of a leak trivially bounded and
 * `revokeAllForServer` unambiguous.
 *
 * Caveat, stated rather than hidden: during a rolling update, old pods coexist
 * with new ones. An OLD pod that happens to restart after the new token is
 * minted but before it is terminated will 401. It is being torn down either
 * way, and its replacement carries the new token - so the cost is a few
 * seconds of noise in a pod that is already going away, which is a better
 * trade than leaving superseded credentials live.
 */
@Injectable()
export class HostedServerSourceTokenService {
  private readonly logger = new Logger(HostedServerSourceTokenService.name);

  /**
   * Prefix on every issued token: `mcpsrc_` = MCP *source* credential.
   *
   * Deliberately distinct from `mcps_` (per-server API key) and `mcpe_`
   * (user-level platform key). Note that `mcpsrc_` is NOT a string prefix of
   * `mcps_` and vice versa - `'mcpsrc_x'.startsWith('mcps_')` is false,
   * because the 5th character is `r` and not `_`. That is load-bearing:
   * `JwtAuthGuard` routes credentials by prefix, so an overlap would let a
   * source token be mistaken for a gateway key. It is asserted by
   * `hosted-server-source-token.service.spec.ts`.
   */
  static readonly TOKEN_PREFIX = 'mcpsrc_';

  /** Bytes of randomness per token. 32 bytes = 256 bits of entropy. */
  static readonly TOKEN_RANDOM_BYTES = 32;

  /** Chars of the random portion retained in the non-secret display prefix. */
  static readonly DISPLAY_PREFIX_RANDOM_CHARS = 6;

  /** See DESIGN DECISION 2. */
  static readonly DEFAULT_TTL_DAYS = 30;

  /** Refuse absurd configured values rather than mint a decade-long token. */
  static readonly MAX_TTL_DAYS = 365;

  private readonly ttlDays: number;

  constructor(
    @InjectRepository(HostedServerSourceToken)
    private readonly tokenRepository: Repository<HostedServerSourceToken>,
    @InjectRepository(HostedServer)
    private readonly hostedServerRepository: Repository<HostedServer>,
    private readonly configService: ConfigService,
  ) {
    this.ttlDays = this.resolveTtlDays();
  }

  /**
   * Mint a token for one hosted server, revoking any it already had.
   *
   * Takes the hosted server's UUID primary key, not its URL-safe `serverId`:
   * the only caller is the deploy path, which is holding the row it just
   * saved and has already established ownership. There is deliberately no
   * user-facing mint endpoint - this credential is infrastructure, and a human
   * who wants their source has `GET /api/conversations/:id` and the download
   * action in the UI.
   */
  async mintToken(hostedServerId: string): Promise<MintedSourceToken> {
    const revoked = await this.revokeAllForServer(hostedServerId);

    const token = this.generateRawToken();
    const expiresAt = new Date(Date.now() + this.ttlDays * 24 * 60 * 60 * 1000);

    const saved = await this.tokenRepository.save(
      this.tokenRepository.create({
        hostedServerId,
        tokenHash: this.hashToken(token),
        tokenPrefix: this.derivePrefix(token),
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        useCount: 0,
      }),
    );

    // Logs the non-secret prefix only - never the token.
    this.logger.log(
      `Minted source token ${saved.id} (${saved.tokenPrefix}...) for hosted server ` +
        `${hostedServerId}, expires ${expiresAt.toISOString()}` +
        (revoked > 0 ? ` (superseded ${revoked} live token(s))` : ''),
    );

    return {
      token,
      id: saved.id,
      tokenPrefix: saved.tokenPrefix,
      expiresAt: saved.expiresAt,
    };
  }

  /**
   * Verify a presented token against the live tokens of ONE hosted server,
   * identified by its URL-safe `serverId` (the value in the request path).
   *
   * Returns the matching row, or null when the token is unknown, revoked,
   * expired, or issued for a different server. All four collapse to `null` on
   * purpose, exactly as in `HostedServerApiKeyService.verifyKey`: a caller who
   * can tell "no such token" from "token for another server" has an oracle for
   * enumerating other users' server ids.
   */
  async verifyToken(
    serverId: string,
    presentedToken: string,
  ): Promise<HostedServerSourceToken | null> {
    if (!presentedToken) {
      return null;
    }

    const server = await this.hostedServerRepository.findOne({
      where: { serverId },
      select: ['id', 'status'],
    });

    // A deleted server's credentials are dead with it, even though the rows
    // survive the soft delete.
    if (!server || server.status === 'deleted') {
      return null;
    }

    const candidates = await this.tokenRepository.find({
      where: { hostedServerId: server.id, revokedAt: IsNull() },
    });

    const presentedDigest = Buffer.from(this.hashToken(presentedToken), 'hex');
    const now = new Date();

    let match: HostedServerSourceToken | null = null;

    for (const candidate of candidates) {
      // Timing-safe digest comparison. A plain `===` on the hex strings would
      // short-circuit at the first differing character, leaking how much of a
      // guessed token was correct.
      const storedDigest = Buffer.from(candidate.tokenHash ?? '', 'hex');
      if (storedDigest.length !== presentedDigest.length) {
        continue;
      }

      const digestsEqual = timingSafeEqual(storedDigest, presentedDigest);

      // No early `break`: the loop does the same work regardless of which
      // candidate matched.
      if (digestsEqual && !this.isExpired(candidate, now)) {
        match = candidate;
      }
    }

    if (!match) {
      return null;
    }

    try {
      await this.tokenRepository.update(
        { id: match.id },
        { lastUsedAt: now, useCount: (match.useCount ?? 0) + 1 },
      );
      match.lastUsedAt = now;
      match.useCount = (match.useCount ?? 0) + 1;
    } catch (error) {
      // A bookkeeping failure must never deny an otherwise-valid token - that
      // would turn a transient database hiccup into a pod that cannot start.
      this.logger.warn(`Failed to record use of source token ${match.id}: ${error}`);
    }

    return match;
  }

  /**
   * Revoke every live token of a server. Returns how many were revoked.
   *
   * Called on mint (see DESIGN DECISION 3) and available for teardown. Note
   * that deleting a server does not need this: `verifyToken` refuses a server
   * whose status is 'deleted', and the FK is ON DELETE CASCADE for a hard
   * delete - this is defence in depth, not the only line.
   */
  async revokeAllForServer(hostedServerId: string): Promise<number> {
    const result = await this.tokenRepository.update(
      { hostedServerId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    return result.affected ?? 0;
  }

  /** Configured token lifetime in days, after validation. */
  get tokenTtlDays(): number {
    return this.ttlDays;
  }

  // --- Helpers ---

  private resolveTtlDays(): number {
    const raw = this.configService.get<string | number>('HOSTED_SERVER_SOURCE_TOKEN_TTL_DAYS');

    if (raw === undefined || raw === null || raw === '') {
      return HostedServerSourceTokenService.DEFAULT_TTL_DAYS;
    }

    const parsed = typeof raw === 'number' ? raw : Number.parseFloat(raw);

    if (
      !Number.isFinite(parsed) ||
      parsed <= 0 ||
      parsed > HostedServerSourceTokenService.MAX_TTL_DAYS
    ) {
      // Loud, not silent: a typo here is a security-relevant misconfiguration,
      // and falling back quietly to the default would hide it.
      throw new BadRequestException(
        `HOSTED_SERVER_SOURCE_TOKEN_TTL_DAYS must be a number in (0, ` +
          `${HostedServerSourceTokenService.MAX_TTL_DAYS}]; got '${raw}'`,
      );
    }

    return parsed;
  }

  /**
   * `mcpsrc_` + 32 random bytes base64url-encoded (43 chars, 256 bits).
   * base64url keeps the token safe in an HTTP header with no escaping.
   */
  private generateRawToken(): string {
    return `${HostedServerSourceTokenService.TOKEN_PREFIX}${randomBytes(
      HostedServerSourceTokenService.TOKEN_RANDOM_BYTES,
    ).toString('base64url')}`;
  }

  /** SHA-256 hex - see the rationale on HostedServerSourceToken.tokenHash. */
  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /** `mcpsrc_` + the first few chars of the random portion, for logs only. */
  private derivePrefix(rawToken: string): string {
    return rawToken.slice(
      0,
      HostedServerSourceTokenService.TOKEN_PREFIX.length +
        HostedServerSourceTokenService.DISPLAY_PREFIX_RANDOM_CHARS,
    );
  }

  private isExpired(token: HostedServerSourceToken, now: Date): boolean {
    return token.expiresAt ? token.expiresAt.getTime() <= now.getTime() : false;
  }
}
