import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';

/**
 * Lowercase-alphanumeric-only random suffix generator for serverId, built on
 * Node's built-in `crypto` rather than the `nanoid` package this file used
 * to import for the same purpose, for two reasons:
 *
 * 1. nanoid's default alphabet includes `-` and `_`, so a suffix could
 *    (rarely) start/end with a separator, producing a serverId that was an
 *    invalid Docker image tag component ("invalid reference format") AND an
 *    invalid Kubernetes DNS-1123 label/ingress host (used verbatim as
 *    `mcp-${serverId}` resource names and `${serverId}.${domain}` in
 *    manifest-generator.service.ts) - a latent bug in both hosting modes
 *    that simply hadn't been hit yet because hosting had never been
 *    exercised end-to-end before.
 * 2. The installed nanoid major version is ESM-only, which this project's
 *    Jest config (ts-jest, CommonJS, no node_modules transform) cannot
 *    import - hosting.service.ts had zero test coverage specifically
 *    because a spec file importing it would fail to even parse. Not
 *    depending on it here removes that blocker without changing the
 *    project's Jest/ESM configuration.
 */
const SUFFIX_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
function generateSuffix(length = 8): string {
  const bytes = randomBytes(length);
  let suffix = '';
  for (let i = 0; i < length; i++) {
    suffix += SUFFIX_ALPHABET[bytes[i] % SUFFIX_ALPHABET.length];
  }
  return suffix;
}
import { HostedServer, HostedServerStatus } from '../database/entities/hosted-server.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { ContainerRegistryService } from './services/container-registry.service';
import { ManifestGeneratorService, objectNameFor } from './services/manifest-generator.service';
import { K8sControlPlaneService } from './services/k8s-control-plane.service';
import { LocalDockerHostingService } from './services/local-docker-hosting.service';
import { TokenEncryptionService } from '../common/token-encryption/token-encryption.service';
import { ConfigService } from '@nestjs/config';

/**
 * Env vars that are pure operational/transport configuration rather than
 * secrets, and are therefore safe to persist in cleartext on the
 * `HostedServer` row (`config.transportEnv`).
 *
 * These are the ones a restart absolutely cannot lose: `MCP_TRANSPORT`
 * decides whether the container publishes a port at all, and `PORT` decides
 * which one, so dropping them turns a running HTTP server into one that is
 * unreachable at the `http://localhost:<port>` endpointUrl its own record
 * still advertises. Everything else (API keys and the like) only survives a
 * restart when `TOKEN_ENCRYPTION_KEY` is configured - see
 * `HostedServer.deployEnvEncrypted`.
 */
const NON_SECRET_ENV_VAR_NAMES = ['MCP_TRANSPORT', 'PORT'] as const;

export interface DeploymentResult {
  success: boolean;
  serverId: string;
  endpointUrl: string;
  status: HostedServerStatus;
  error?: string;
}

/**
 * 'kubernetes' (default): build+push to a registry (GHCR or a local
 * registry:5000 in LOCAL_DEV) and then create the Deployment/Service/Secret
 * directly against the Kubernetes API (K8sControlPlaneService). Status is NOT
 * assumed - K8sReconcilerService observes the cluster and writes back what is
 * actually happening.
 *
 * 'docker-run': build the image locally and actually run it as a Docker
 * container on this host, verifying it's a real, responding MCP server via
 * the initialize/tools-list handshake - over stdio or Streamable HTTP,
 * whichever transport the caller-supplied `MCP_TRANSPORT` env var selects -
 * before ever reporting 'running'. No registry, no cluster - see
 * LocalDockerHostingService and DEPLOYMENT.md "local hosting on WSL2" for why
 * this exists and exactly what it does and does not prove.
 */
type HostingMode = 'kubernetes' | 'docker-run';

@Injectable()
export class HostingService {
  private readonly logger = new Logger(HostingService.name);
  private readonly domain: string;
  private readonly namespace: string;
  private readonly hostingMode: HostingMode;

  constructor(
    @InjectRepository(HostedServer)
    private hostedServerRepo: Repository<HostedServer>,
    @InjectRepository(Deployment)
    private deploymentRepo: Repository<Deployment>,
    private containerRegistryService: ContainerRegistryService,
    private manifestGeneratorService: ManifestGeneratorService,
    private k8sControlPlane: K8sControlPlaneService,
    private localDockerHostingService: LocalDockerHostingService,
    private tokenEncryptionService: TokenEncryptionService,
    private configService: ConfigService,
  ) {
    this.domain = this.configService.get('MCP_HOSTING_DOMAIN', 'mcp.example.com');
    this.namespace = this.configService.get('K8S_NAMESPACE', 'mcp-servers');
    this.hostingMode = this.configService.get<HostingMode>('HOSTING_MODE', 'kubernetes');
  }

  private isDockerRunMode(): boolean {
    return this.hostingMode === 'docker-run';
  }

  /** True for a HostedServer row that was deployed via HOSTING_MODE=docker-run. */
  private isDockerRunServer(server: HostedServer): boolean {
    return (server.config as Record<string, unknown> | null)?.mode === 'docker-run';
  }

  /**
   * Deploy a generated MCP server to the K8s cluster
   *
   * @param userId owner of the deployment; when supplied the underlying
   *               deployment must belong to this user and the resulting hosted
   *               server is recorded as owned by them
   */
  async deployToCloud(
    conversationId: string,
    userId?: string,
    envVars?: Record<string, string>,
  ): Promise<DeploymentResult> {
    // 1. Get deployment info from conversation (scoped to the owner)
    const deployment = await this.deploymentRepo.findOne({
      where: userId ? { conversationId, userId } : { conversationId },
      order: { createdAt: 'DESC' },
    });

    if (!deployment) {
      throw new NotFoundException(`No deployment found for conversation ${conversationId}`);
    }

    if (!deployment.serverName) {
      throw new BadRequestException(
        'Deployment does not have server metadata (serverName required)',
      );
    }

    // 2. Generate unique server ID
    const serverId = this.generateServerId(deployment.serverName);
    // docker-run + MCP_TRANSPORT=http gets a real, dialable URL (the port
    // LocalDockerHostingService will publish is a pure function of serverId,
    // so it's safe to compute here before the container actually starts);
    // docker-run + stdio has no network endpoint at all, so `docker-exec://`
    // stays an honest (if fake-scheme) placeholder rather than a URL nothing
    // can actually connect to.
    const endpointUrl = this.isDockerRunMode()
      ? envVars?.MCP_TRANSPORT?.toLowerCase() === 'http'
        ? `http://localhost:${this.localDockerHostingService.httpHostPortFor(serverId)}`
        : `docker-exec://${this.localDockerHostingService.containerNameFor(serverId)}`
      : `https://${serverId}.${this.domain}`;

    // 3. Create hosted server record
    const hostedServer = this.hostedServerRepo.create({
      conversationId,
      userId: userId ?? deployment.userId,
      serverName: deployment.serverName,
      serverId,
      description: deployment.description,
      dockerImage: '', // Will be set after build
      endpointUrl,
      status: 'pending',
      tools: deployment.tools,
      envVarNames: deployment.envVars?.map((e) => e.name) || [],
      // Copied off the Deployment rather than referenced, because Deployment
      // is ON DELETE CASCADE from conversations while this row is only
      // SET NULL - deleting the chat must not destroy a live hosted server's
      // only pointer to its own source. See HostedServer.localPath.
      localPath: deployment.localPath ?? null,
    });

    await this.hostedServerRepo.save(hostedServer);

    const serverDir = deployment.localPath; // Path to generated server files
    if (!serverDir) {
      await this.updateStatus(hostedServer, 'failed', 'Deployment does not have localPath');
      return {
        success: false,
        serverId,
        endpointUrl,
        status: 'failed',
        error: 'Deployment does not have localPath',
      };
    }

    if (this.isDockerRunMode()) {
      return this.deployToLocalDocker(hostedServer, serverDir, envVars);
    }

    return this.deployToKubernetes(hostedServer, deployment, serverDir, envVars);
  }

  /**
   * Production path: build+push to a registry, then create the
   * Deployment/Service/Secret directly against the Kubernetes API.
   *
   * Two behaviour changes worth calling out, both deliberate:
   *
   * 1. This NO LONGER reports 'running'. It reports 'deploying' and hands off
   *    to K8sReconcilerService, which observes the cluster and writes the real
   *    status back. The old code set 'running' on GitOps-commit success, which
   *    meant a pod stuck in ImagePullBackOff read 'running' forever. A
   *    successful return from here now means "the cluster accepted the
   *    objects", which is all this method can honestly claim.
   *
   * 2. `envVars` are now passed through. They previously stopped at
   *    deployToCloud and never reached the K8s path at all - which was
   *    accidentally masking a security bug, because the manifest generator
   *    would have inlined them as literal `value:` entries and GitOpsService
   *    would have committed them to a GitHub repo in plaintext. They now go
   *    into a Kubernetes Secret referenced via envFrom, so passing them
   *    through is safe.
   */
  private async deployToKubernetes(
    hostedServer: HostedServer,
    deployment: Deployment,
    serverDir: string,
    envVars?: Record<string, string>,
  ): Promise<DeploymentResult> {
    const serverId = hostedServer.serverId;
    const endpointUrl = hostedServer.endpointUrl;

    try {
      if (!this.k8sControlPlane.isEnabled()) {
        throw new Error(
          'Kubernetes hosting is not available: no usable kubeconfig and not running in-cluster. ' +
            'Set KUBECONFIG, deploy the backend into the cluster, or use HOSTING_MODE=docker-run.',
        );
      }

      // 4. Build the image, then push it - reported as the two distinct
      // stages they are. 'pushing' is a real HostedServerStatus that the
      // deploy-progress UI renders as stage 3 of 5; before the build/push
      // split in ContainerRegistryService nothing could ever set it, so the
      // progress bar jumped straight from 'building' to 'deploying' past a
      // stage users were being shown.
      await this.updateStatus(hostedServer, 'building', 'Building Docker image...');

      const dockerImage = await this.containerRegistryService.buildImage(
        serverDir,
        serverId,
        'latest',
      );

      hostedServer.dockerImage = dockerImage;
      await this.hostedServerRepo.save(hostedServer);

      await this.updateStatus(hostedServer, 'pushing', `Pushing image to registry: ${dockerImage}`);
      await this.containerRegistryService.pushImage(dockerImage);

      // 5. Create/patch the Deployment, Service and (if needed) env Secret
      await this.updateStatus(
        hostedServer,
        'deploying',
        'Applying Kubernetes Deployment, Service and Secret...',
      );

      await this.k8sControlPlane.applyServer({
        serverId,
        serverName: deployment.serverName,
        // Already `registry/owner/repo/serverId:tag` - buildImage returns the
        // complete reference. Do NOT also pass a tag; see
        // ManifestConfig.dockerImage.
        dockerImage,
        envVars,
        replicas: 1,
      });

      // 6. Record intent + where the objects live, then let the reconciler
      //    decide when this is actually 'running'.
      hostedServer.deployedAt = new Date();
      hostedServer.k8sDeploymentName = objectNameFor(serverId);
      hostedServer.k8sNamespace = this.namespace;
      hostedServer.desiredState = 'running';
      hostedServer.observedStatus = null;
      hostedServer.observedMessage = null;
      hostedServer.observedAt = null;
      hostedServer.observedReplicas = null;
      hostedServer.observedReadyReplicas = null;
      await this.hostedServerRepo.save(hostedServer);

      await this.updateStatus(
        hostedServer,
        'deploying',
        'Applied to cluster; waiting for pods to become ready',
      );

      this.logger.log(`Applied MCP server ${serverId} to ${this.namespace} (endpoint ${endpointUrl})`);

      return {
        success: true,
        serverId,
        endpointUrl,
        status: 'deploying',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.updateStatus(hostedServer, 'failed', errorMessage);
      this.logger.error(`Deployment failed for ${serverId}: ${errorMessage}`);

      return {
        success: false,
        serverId,
        endpointUrl,
        status: 'failed',
        error: errorMessage,
      };
    }
  }

  /**
   * HOSTING_MODE=docker-run path: build the image locally, run it as a real
   * container, and only report 'running' once the MCP handshake (initialize
   * + tools/list) has actually succeeded against it - over stdio or
   * Streamable HTTP, whichever transport `envVars.MCP_TRANSPORT` selects
   * (see LocalDockerHostingService.startAndVerify).
   */
  private async deployToLocalDocker(
    hostedServer: HostedServer,
    serverDir: string,
    envVars?: Record<string, string>,
  ): Promise<DeploymentResult> {
    const serverId = hostedServer.serverId;
    const endpointUrl = hostedServer.endpointUrl;

    try {
      await this.updateStatus(hostedServer, 'building', 'Building Docker image locally...');

      const dockerImage = await this.localDockerHostingService.buildImage(serverDir, serverId);
      hostedServer.dockerImage = dockerImage;
      await this.hostedServerRepo.save(hostedServer);

      await this.updateStatus(
        hostedServer,
        'deploying',
        'Starting container and verifying MCP handshake (initialize + tools/list)...',
      );

      const { containerName, handshake } = await this.localDockerHostingService.startAndVerify(
        serverId,
        dockerImage,
        envVars || {},
      );

      // Remember exactly how this container was started, so stop -> start
      // reproduces it instead of silently downgrading it (see
      // persistDeployEnv and HostedServer.deployEnvEncrypted).
      this.persistDeployEnv(hostedServer, envVars || {});

      hostedServer.config = {
        ...(hostedServer.config || {}),
        mode: 'docker-run',
        containerName,
        localPath: serverDir,
        handshake: {
          protocolVersion: handshake.protocolVersion,
          serverInfo: handshake.serverInfo,
          toolCount: handshake.tools?.length ?? 0,
          toolNames: (handshake.tools ?? []).map((t) => t.name),
          verifiedAt: new Date().toISOString(),
        },
      };

      const toolSummary = `${handshake.tools?.length ?? 0} tool(s): ${(handshake.tools ?? [])
        .map((t) => t.name)
        .join(', ')}`;
      await this.updateStatus(
        hostedServer,
        'running',
        `Running in local Docker container '${containerName}'. Verified via ${handshake.transport ?? 'stdio'} MCP handshake - ${toolSummary}.`,
      );
      hostedServer.deployedAt = new Date();
      await this.hostedServerRepo.save(hostedServer);

      this.logger.log(
        `Deployed MCP server ${serverId} as local Docker container ${containerName} (${toolSummary})`,
      );

      return {
        success: true,
        serverId,
        endpointUrl,
        status: 'running',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.updateStatus(hostedServer, 'failed', errorMessage);
      this.logger.error(`Local docker deployment failed for ${serverId}: ${errorMessage}`);

      return {
        success: false,
        serverId,
        endpointUrl,
        status: 'failed',
        error: errorMessage,
      };
    }
  }

  /**
   * Stop a hosted server (scale to 0 in K8s mode; actually stop+remove the
   * container in docker-run mode)
   */
  async stopServer(serverId: string, userId?: string): Promise<void> {
    const server = await this.getServerByIdOrFail(serverId, userId);

    server.desiredState = 'stopped';

    if (this.isDockerRunServer(server)) {
      await this.localDockerHostingService.stopContainer(serverId);
      await this.updateStatus(server, 'stopped', 'Container stopped');
      server.stoppedAt = new Date();
      await this.hostedServerRepo.save(server);
      return;
    }

    // Scale the live Deployment to 0. The old code regenerated the whole
    // manifest set and string-replaced 'replicas: 1' -> 'replicas: 0' before
    // re-committing it; a targeted merge-patch is both correct and immune to
    // that substitution silently not matching.
    await this.k8sControlPlane.scaleServer(serverId, 0);

    await this.updateStatus(server, 'stopped', 'Scaled to 0 replicas');
    server.stoppedAt = new Date();
    await this.hostedServerRepo.save(server);
  }

  /**
   * Start a stopped server (scale to 1 in K8s mode; rebuild+run a fresh
   * container and re-verify the MCP handshake in docker-run mode - there is
   * no "paused" container to resume since stopContainer removes it (--rm))
   */
  async startServer(serverId: string, userId?: string): Promise<void> {
    const server = await this.getServerByIdOrFail(serverId, userId);

    if (server.status !== 'stopped') {
      throw new BadRequestException('Server is not stopped');
    }

    server.desiredState = 'running';

    if (this.isDockerRunServer(server)) {
      const config = server.config as Record<string, unknown>;
      // Prefer the dedicated column: `config.localPath` is legacy, and the
      // column is the one that is guaranteed to survive deletion of the
      // originating conversation (and its CASCADE-deleted Deployment row).
      const localPath = server.localPath ?? (config?.localPath as string | undefined);
      if (!localPath) {
        throw new BadRequestException(
          'Cannot restart: original server source path was not recorded',
        );
      }

      // Restart with the env vars this server was actually deployed with.
      // Passing `{}` here (the previous behaviour) permanently broke any
      // HTTP-transport server: LocalDockerHostingService defaults
      // MCP_TRANSPORT to stdio when it is absent, so no port was published
      // and the server became unreachable at the http://localhost:<port>
      // endpointUrl its own record still advertises - while any user-supplied
      // API keys were dropped at the same time.
      const restartEnv = this.restoreDeployEnv(server);

      await this.updateStatus(server, 'deploying', 'Restarting local Docker container...');
      const { containerName, handshake } = await this.localDockerHostingService.startAndVerify(
        serverId,
        server.dockerImage,
        restartEnv,
      );

      server.config = {
        ...config,
        containerName,
        handshake: {
          protocolVersion: handshake.protocolVersion,
          serverInfo: handshake.serverInfo,
          toolCount: handshake.tools?.length ?? 0,
          toolNames: (handshake.tools ?? []).map((t) => t.name),
          verifiedAt: new Date().toISOString(),
        },
      };
      await this.updateStatus(server, 'running', `Restarted container '${containerName}'`);
      server.stoppedAt = null;
      await this.hostedServerRepo.save(server);
      return;
    }

    // Scale back up and let the reconciler confirm readiness. As with deploy,
    // this reports 'deploying' rather than asserting 'running' - the pod still
    // has to pull, start and pass its readiness probe.
    await this.k8sControlPlane.scaleServer(serverId, 1);

    await this.updateStatus(server, 'deploying', 'Scaled to 1 replica; waiting for readiness');
    server.stoppedAt = null;
    await this.hostedServerRepo.save(server);
  }

  /**
   * Delete a hosted server completely
   */
  async deleteServer(serverId: string, userId?: string): Promise<void> {
    const server = await this.getServerByIdOrFail(serverId, userId);

    server.desiredState = 'deleted';

    if (this.isDockerRunServer(server)) {
      await this.localDockerHostingService.stopContainer(serverId);
    } else {
      // Really delete the Deployment, Service and env Secret. The GitOps path
      // could not do this: it "deleted" by committing a removal, leaving the
      // manifests - and any user credentials in them - recoverable in git
      // history forever, which is the wrong answer for account deletion.
      await this.k8sControlPlane.deleteServer(serverId);

      // Delete Docker image (optional, can keep for rollback)
      try {
        await this.containerRegistryService.deleteImage(serverId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn(`Failed to delete image for ${serverId}: ${errorMessage}`);
      }
    }

    // Soft delete in database
    await this.updateStatus(server, 'deleted', 'Server deleted');
    server.deletedAt = new Date();
    await this.hostedServerRepo.save(server);
  }

  /**
   * Get all servers for a user
   */
  async getServers(userId?: string): Promise<HostedServer[]> {
    const query = this.hostedServerRepo
      .createQueryBuilder('server')
      .where('server.status != :deleted', { deleted: 'deleted' })
      .orderBy('server.createdAt', 'DESC');

    if (userId) {
      query.andWhere('server.userId = :userId', { userId });
    }

    return query.getMany();
  }

  /**
   * Get server by ID
   *
   * @param userId when supplied, servers owned by other users (or legacy rows
   *               without an owner) are reported as not found
   */
  async getServer(serverId: string, userId?: string): Promise<HostedServer> {
    return this.getServerByIdOrFail(serverId, userId);
  }

  /**
   * Increment request count (called by MCP proxy)
   */
  async trackRequest(serverId: string): Promise<void> {
    await this.hostedServerRepo.increment({ serverId }, 'requestCount', 1);
    await this.hostedServerRepo.update({ serverId }, { lastRequestAt: new Date() });
  }

  /**
   * Get server logs.
   * docker-run mode: real `docker logs` output.
   * K8s mode: real pod logs via the Kubernetes API (previously a hardcoded
   * "not yet implemented" stub).
   */
  async getServerLogs(
    serverId: string,
    options: { lines?: number; since?: string },
    userId?: string,
  ): Promise<{ logs: string[]; message: string }> {
    // Validate server exists and belongs to the requesting user
    const server = await this.getServerByIdOrFail(serverId, userId);

    this.logger.debug(
      `Log request for ${serverId}: lines=${options.lines}, since=${options.since}`,
    );

    if (this.isDockerRunServer(server)) {
      try {
        const logs = await this.localDockerHostingService.getLogs(serverId, options.lines ?? 100);
        return { logs, message: 'Live logs from local Docker container.' };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { logs: [], message: `Failed to fetch container logs: ${errorMessage}` };
      }
    }

    if (!this.k8sControlPlane.isEnabled()) {
      return {
        logs: [],
        message:
          'Kubernetes hosting is not configured on this backend, so there are no pod logs to read.',
      };
    }

    try {
      const logs = await this.k8sControlPlane.getLogs(serverId, options.lines ?? 100);
      return {
        logs,
        message: logs.length
          ? 'Live logs from the newest pod.'
          : 'No pod is currently running for this server.',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { logs: [], message: `Failed to fetch pod logs: ${errorMessage}` };
    }
  }

  // --- Helper Methods ---

  private generateServerId(serverName: string): string {
    const prefix = serverName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') // never start/end the component with '-'
      .slice(0, 20)
      .replace(/-+$/g, '') // slice() may re-expose a trailing '-'
      || 'mcp-server'; // serverName with no alphanumeric chars at all

    const suffix = generateSuffix();
    return `${prefix}-${suffix}`;
  }

  
  /**
   * Record the env vars a docker-run container was actually started with, so
   * a later `startServer` can reproduce it exactly.
   *
   * Split deliberately by sensitivity:
   *   - `config.transportEnv` holds only NON_SECRET_ENV_VAR_NAMES in
   *     cleartext. These decide whether a port is published at all, so losing
   *     them is what turned a restart into a permanently unreachable server -
   *     and they are not secrets, so they must survive even when no
   *     encryption key is configured.
   *   - `deployEnvEncrypted` holds the full set, AES-256-GCM encrypted. These
   *     are the values `env_var_names` exists specifically to avoid storing in
   *     the clear. If `TOKEN_ENCRYPTION_KEY` is unset, `encrypt()` returns
   *     undefined and nothing is written - a restart then loses the secrets
   *     (as it always did) but keeps the transport, and we say so in the log
   *     rather than quietly writing plaintext secrets to the database.
   */
  private persistDeployEnv(server: HostedServer, envVars: Record<string, string>): void {
    const transportEnv: Record<string, string> = {};
    for (const name of NON_SECRET_ENV_VAR_NAMES) {
      if (envVars[name] !== undefined) {
        transportEnv[name] = envVars[name];
      }
    }
    server.config = { ...(server.config || {}), transportEnv };

    if (Object.keys(envVars).length === 0) {
      server.deployEnvEncrypted = null;
      return;
    }

    const encrypted = this.tokenEncryptionService.encrypt(JSON.stringify(envVars));
    if (!encrypted) {
      server.deployEnvEncrypted = null;
      this.logger.warn(
        `TOKEN_ENCRYPTION_KEY is not configured, so the env vars for hosted server ` +
          `${server.serverId} are not being persisted. Restarting it will restore only ` +
          `${NON_SECRET_ENV_VAR_NAMES.join('/')}; any API keys must be supplied by ` +
          `redeploying.`,
      );
      return;
    }

    server.deployEnvEncrypted = encrypted;
  }

  /**
   * Inverse of `persistDeployEnv`. Always returns at least the non-secret
   * transport vars; adds the full decrypted set on top when it is available
   * and readable (a rotated/absent key yields undefined, never a throw).
   */
  private restoreDeployEnv(server: HostedServer): Record<string, string> {
    const config = (server.config || {}) as Record<string, unknown>;
    const transportEnv = (config.transportEnv as Record<string, string> | undefined) || {};

    const decrypted = this.tokenEncryptionService.decrypt(server.deployEnvEncrypted);
    if (!decrypted) {
      if (server.deployEnvEncrypted) {
        this.logger.warn(
          `Could not decrypt the stored env vars for hosted server ${server.serverId} ` +
            `(TOKEN_ENCRYPTION_KEY rotated?); restarting with transport settings only.`,
        );
      }
      return { ...transportEnv };
    }

    try {
      return { ...transportEnv, ...(JSON.parse(decrypted) as Record<string, string>) };
    } catch {
      this.logger.warn(
        `Stored env vars for hosted server ${server.serverId} are not valid JSON; ` +
          `restarting with transport settings only.`,
      );
      return { ...transportEnv };
    }
  }

  private async getServerByIdOrFail(serverId: string, userId?: string): Promise<HostedServer> {
    const server = await this.hostedServerRepo.findOne({
      where: userId ? { serverId, userId } : { serverId },
    });

    if (!server) {
      // Do not distinguish "does not exist" from "not yours"
      throw new NotFoundException(`Server not found: ${serverId}`);
    }

    return server;
  }

  private async updateStatus(
    server: HostedServer,
    status: HostedServerStatus,
    message: string,
  ): Promise<void> {
    server.status = status;
    server.statusMessage = message;
    server.lastStatusChange = new Date();
    await this.hostedServerRepo.save(server);
  }
}
