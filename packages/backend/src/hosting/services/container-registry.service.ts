import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

const execAsync = promisify(exec);

/** Whether `GHCR_OWNER` names a GitHub user account or an organisation. */
type GhcrOwnerType = 'user' | 'org';

function normalizeOwnerType(raw: string | undefined): GhcrOwnerType | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'org' || value === 'orgs' || value === 'organization') return 'org';
  if (value === 'user' || value === 'users') return 'user';
  return undefined;
}

@Injectable()
export class ContainerRegistryService {
  private readonly logger = new Logger(ContainerRegistryService.name);
  private readonly registry: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly localRegistry: string = 'localhost:5000';
  /**
   * Path/name of the docker CLI to invoke. Defaults to 'docker' (found on
   * PATH in normal Linux/CI environments). On this WSL2 dev box there is no
   * docker CLI installed in the distro at all - only Windows Docker Desktop's
   * client binary, reachable via the Windows filesystem mount - so DOCKER_BIN
   * can be pointed at that path instead. See DEPLOYMENT.md "local hosting on
   * WSL2".
   */
  private readonly dockerBin: string;
  /**
   * Explicitly configured owner type, if the operator set `GHCR_OWNER_TYPE`.
   * Left undefined to mean "ask GitHub" - see `resolveOwnerType`.
   */
  private readonly configuredOwnerType?: GhcrOwnerType;
  /** Memoized result of `resolveOwnerType` - GHCR_OWNER never changes at runtime. */
  private resolvedOwnerType?: GhcrOwnerType;

  constructor(private readonly configService: ConfigService) {
    this.registry = this.configService.get<string>('GHCR_REGISTRY', 'ghcr.io');
    this.owner = this.configService.get<string>('GHCR_OWNER');
    this.repo = this.configService.get<string>('GHCR_REPO', 'mcp-servers');
    this.dockerBin = this.configService.get<string>('DOCKER_BIN', 'docker');
    this.configuredOwnerType = normalizeOwnerType(
      this.configService.get<string>('GHCR_OWNER_TYPE'),
    );
  }

  /**
   * Which GitHub Packages API family owns `GHCR_OWNER`'s container packages.
   *
   * This matters because the two are different endpoints and the wrong one
   * always 404s:
   *   - a user's own packages live under `/user/packages/...`
   *   - an organisation's live under `/orgs/{org}/packages/...`
   *
   * Every GHCR call here previously hardcoded `/user/packages/...`, so with an
   * organisation `GHCR_OWNER` (the normal setup for a hosted product) deletes
   * always 404'd - and `deleteImage` downgrades 404 to a warning, so image
   * cleanup silently never happened and every deleted server leaked its image.
   *
   * Resolution order: explicit `GHCR_OWNER_TYPE` config, then a single
   * `GET /users/{owner}` lookup (`type` is `"Organization"` or `"User"`),
   * then a conservative default of `'user'` - which is also why the callers
   * below retry against the other endpoint on a 404 rather than trusting this
   * answer blindly.
   */
  private async resolveOwnerType(token: string): Promise<GhcrOwnerType> {
    if (this.configuredOwnerType) return this.configuredOwnerType;
    if (this.resolvedOwnerType) return this.resolvedOwnerType;

    try {
      const response = await axios.get(
        `https://api.github.com/users/${encodeURIComponent(this.owner)}`,
        { headers: this.githubHeaders(token) },
      );
      const type = (response.data as { type?: string })?.type;
      this.resolvedOwnerType = type === 'Organization' ? 'org' : 'user';
      this.logger.log(`Resolved GHCR_OWNER '${this.owner}' as a GitHub ${this.resolvedOwnerType}`);
    } catch (error) {
      this.logger.warn(
        `Could not determine whether GHCR_OWNER '${this.owner}' is a user or an organisation ` +
          `(${error instanceof Error ? error.message : 'unknown error'}); assuming 'user'. ` +
          `Set GHCR_OWNER_TYPE=org explicitly if this is an organisation.`,
      );
      this.resolvedOwnerType = 'user';
    }

    return this.resolvedOwnerType;
  }

  /**
   * Base URL for a container package, for a given owner type. `'user'` uses
   * the authenticated-user form (`/user/packages/...`) rather than
   * `/users/{username}/packages/...` because deleting another user's package
   * requires site-admin rights, whereas `GHCR_OWNER` is expected to be the
   * identity behind `GITHUB_TOKEN`.
   */
  private packageUrl(ownerType: GhcrOwnerType, packageName: string): string {
    const encoded = encodeURIComponent(packageName);
    return ownerType === 'org'
      ? `https://api.github.com/orgs/${encodeURIComponent(this.owner)}/packages/container/${encoded}`
      : `https://api.github.com/user/packages/container/${encoded}`;
  }

  /**
   * Both candidate URLs, most-likely first. Callers try the second only when
   * the first 404s, so a misconfigured/undetectable `GHCR_OWNER_TYPE` degrades
   * to one extra request instead of a silent no-op.
   */
  private packageUrlCandidates(ownerType: GhcrOwnerType, packageName: string): string[] {
    const other: GhcrOwnerType = ownerType === 'org' ? 'user' : 'org';
    return [this.packageUrl(ownerType, packageName), this.packageUrl(other, packageName)];
  }

  private githubHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /**
   * Quote a path/argument for safe interpolation into the shell command
   * string used by `exec()`. Needed because DOCKER_BIN may be a Windows path
   * containing spaces (e.g. ".../Docker Desktop/.../docker.exe").
   */
  private quote(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  /**
   * Check if running in local development mode
   */
  private isLocalDev(): boolean {
    return this.configService.get<string>('LOCAL_DEV') === 'true';
  }

  /**
   * Get the registry to use (local or GHCR)
   */
  private getRegistry(): string {
    if (this.isLocalDev()) {
      return this.localRegistry;
    }
    return this.registry;
  }

  /**
   * Get full image name for a server
   *
   * @throws when GHCR_OWNER is not configured and we are not in LOCAL_DEV
   *         mode - previously this silently built a tag like
   *         `ghcr.io/undefined/mcp-servers/...`, which `docker build` would
   *         accept and only fail confusingly on push (or worse, succeed
   *         locally and fail only when actually pushed).
   */
  getImageName(serverId: string, tag: string = 'latest'): string {
    if (this.isLocalDev()) {
      // Local registry: localhost:5000/server-id:tag
      return `${this.localRegistry}/${serverId}:${tag}`;
    }
    if (!this.owner) {
      throw new Error(
        'GHCR_OWNER is not configured. Set GHCR_OWNER (or LOCAL_DEV=true / ' +
          "HOSTING_MODE=docker-run for local development) - without it the image tag " +
          "would contain the literal string 'undefined'.",
      );
    }
    // GHCR: ghcr.io/owner/repo/server-id:tag
    return `${this.registry}/${this.owner}/${this.repo}/${serverId}:${tag}`;
  }

  /**
   * Login to GHCR using GitHub token
   * Skipped in LOCAL_DEV mode (local registry has no auth)
   */
  async login(): Promise<void> {
    if (this.isLocalDev()) {
      this.logger.log('LOCAL_DEV mode - skipping registry login (local registry has no auth)');
      return;
    }

    const token = this.configService.get<string>('GITHUB_TOKEN');
    if (!token) {
      this.logger.warn('GITHUB_TOKEN not configured - GHCR login skipped');
      return;
    }

    if (!this.owner) {
      this.logger.warn('GHCR_OWNER not configured - GHCR login skipped');
      return;
    }

    try {
      // Use stdin for password to avoid shell escaping issues
      await execAsync(
        `echo "${token}" | ${this.quote(this.dockerBin)} login ${this.registry} -u ${this.owner} --password-stdin`,
      );
      this.logger.log(`Logged in to GHCR (${this.registry}) as ${this.owner}`);
    } catch (error) {
      this.logger.error(`Failed to login to GHCR: ${error.message}`);
      throw error;
    }
  }

  /**
   * Build the image locally, without pushing.
   *
   * Split out of `buildAndPush` so callers can report the build and the push
   * as the distinct stages they actually are. `HostedServer.status` has always
   * had a `'pushing'` value and the deploy-progress UI has always rendered it
   * as stage 3 of 5, but with a single combined call there was no moment at
   * which anything could set it - the bar jumped `building` -> `deploying` and
   * a real stage was permanently invisible.
   *
   * @returns the full image reference (registry/owner/repo/serverId:tag)
   */
  async buildImage(serverDir: string, serverId: string, tag: string = 'latest'): Promise<string> {
    const imageName = this.getImageName(serverId, tag);
    const targetRegistry = this.isLocalDev() ? 'local registry (localhost:5000)' : 'GHCR';

    this.logger.log(`Building image: ${imageName} for ${targetRegistry}`);
    try {
      const { stdout: buildOutput } = await execAsync(
        `${this.quote(this.dockerBin)} build -t ${imageName} ${this.quote(serverDir)}`,
        { maxBuffer: 10 * 1024 * 1024 }, // 10MB buffer for build output
      );
      this.logger.debug(`Build output: ${buildOutput}`);
    } catch (error) {
      this.logger.error(`Failed to build image: ${error.message}`);
      throw new Error(`Docker build failed: ${error.message}`);
    }

    return imageName;
  }

  /**
   * Push an already-built image reference to its registry.
   *
   * @param imageName full reference as returned by `buildImage`/`getImageName`
   */
  async pushImage(imageName: string): Promise<void> {
    this.logger.log(`Pushing image: ${imageName}`);
    try {
      const { stdout: pushOutput } = await execAsync(
        `${this.quote(this.dockerBin)} push ${imageName}`,
      );
      this.logger.debug(`Push output: ${pushOutput}`);
    } catch (error) {
      this.logger.error(`Failed to push image: ${error.message}`);
      throw new Error(`Docker push failed: ${error.message}`);
    }

    this.logger.log(`Successfully pushed image: ${imageName}`);
  }

  /**
   * Build and push Docker image to registry (GHCR or local).
   *
   * Convenience wrapper over `buildImage` + `pushImage` for callers that have
   * no separate status to report between the two.
   */
  async buildAndPush(serverDir: string, serverId: string, tag: string = 'latest'): Promise<string> {
    const imageName = await this.buildImage(serverDir, serverId, tag);
    await this.pushImage(imageName);
    return imageName;
  }

  /**
   * Delete image from registry (GHCR or local)
   */
  async deleteImage(serverId: string): Promise<void> {
    if (this.isLocalDev()) {
      // For local registry, delete via Docker CLI
      const imageName = this.getImageName(serverId);
      try {
        await execAsync(`${this.quote(this.dockerBin)} rmi ${imageName} 2>/dev/null || true`);
        this.logger.log(`Deleted local image: ${serverId}`);
      } catch (error) {
        this.logger.warn(`Failed to delete local image (may not exist): ${error.message}`);
      }
      return;
    }

    const token = this.configService.get<string>('GITHUB_TOKEN');
    if (!token) {
      throw new Error('GITHUB_TOKEN not configured');
    }

    // GHCR package name includes the repo path
    const packageName = `${this.repo}/${serverId}`;
    const ownerType = await this.resolveOwnerType(token);
    const urls = this.packageUrlCandidates(ownerType, packageName);

    // Try the endpoint for the resolved owner type first; a 404 there is
    // ambiguous (wrong endpoint family vs genuinely absent package), so try
    // the other family before concluding the image isn't there. Only after
    // BOTH 404 is "not found" an honest answer rather than a silently
    // swallowed misconfiguration.
    for (let i = 0; i < urls.length; i++) {
      try {
        await axios.delete(urls[i], { headers: this.githubHeaders(token) });
        this.logger.log(`Deleted image from GHCR: ${serverId}`);
        return;
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          continue;
        }
        this.logger.error(`Failed to delete image: ${error.message}`);
        throw new Error(`Failed to delete image from GHCR: ${error.message}`);
      }
    }

    this.logger.warn(
      `Image not found in GHCR under either the ${ownerType} or the alternate packages API ` +
        `for owner '${this.owner}': ${serverId}`,
    );
  }

  /**
   * Check if an image exists in registry (GHCR or local)
   */
  async imageExists(serverId: string, tag: string = 'latest'): Promise<boolean> {
    if (this.isLocalDev()) {
      // Check local Docker images
      const imageName = this.getImageName(serverId, tag);
      try {
        await execAsync(`${this.quote(this.dockerBin)} image inspect ${imageName}`);
        return true;
      } catch {
        return false;
      }
    }

    const token = this.configService.get<string>('GITHUB_TOKEN');
    if (!token) {
      return false;
    }

    const packageName = `${this.repo}/${serverId}`;
    const ownerType = await this.resolveOwnerType(token);
    // Same user-vs-org endpoint ambiguity as deleteImage: a 404 on the first
    // candidate does not prove the package is absent.
    const urls = this.packageUrlCandidates(ownerType, packageName).map((u) => `${u}/versions`);

    for (const url of urls) {
      try {
        const response = await axios.get(url, { headers: this.githubHeaders(token) });

        // Check if the specific tag exists
        const versions = response.data as Array<{ metadata?: { container?: { tags?: string[] } } }>;
        return versions.some((v) => v.metadata?.container?.tags?.includes(tag));
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          continue;
        }
        throw error;
      }
    }

    return false;
  }

  /**
   * Tag an existing image with a new tag
   */
  async tagImage(serverId: string, sourceTag: string, targetTag: string): Promise<string> {
    const sourceImage = this.getImageName(serverId, sourceTag);
    const targetImage = this.getImageName(serverId, targetTag);

    try {
      await execAsync(`${this.quote(this.dockerBin)} tag ${sourceImage} ${targetImage}`);
      await execAsync(`${this.quote(this.dockerBin)} push ${targetImage}`);
      this.logger.log(`Tagged ${sourceImage} as ${targetImage}`);
      return targetImage;
    } catch (error) {
      this.logger.error(`Failed to tag image: ${error.message}`);
      throw new Error(`Failed to tag image: ${error.message}`);
    }
  }
}
