import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContainerRegistryService } from './services/container-registry.service';
import { ManifestGeneratorService } from './services/manifest-generator.service';
import { K8sControlPlaneService } from './services/k8s-control-plane.service';
import { K8sReconcilerService } from './services/k8s-reconciler.service';
import { LocalDockerHostingService } from './services/local-docker-hosting.service';
import { HostingService } from './hosting.service';
import { HostedServerApiKeyService } from './hosted-server-api-key.service';
import { HostedServerSourceTokenService } from './hosted-server-source-token.service';
import { HostedServerSourceService } from './hosted-server-source.service';
import { SourceArchiveService } from './services/source-archive.service';
import { HostingController } from './hosting.controller';
import { McpGatewayController } from './mcp-gateway.controller';
import { HostedServerSourceController } from './hosted-server-source.controller';
import { McpProxyService } from './services/mcp-proxy.service';
import { McpUpstreamResolver } from './services/mcp-upstream-resolver.service';
import { HostedMcpClientService } from './services/hosted-mcp-client.service';
import { HostedServerGatewayGuard } from './guards/hosted-server-gateway.guard';
import { HostedServerSourceGuard } from './guards/hosted-server-source.guard';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { HostedServerApiKey } from '../database/entities/hosted-server-api-key.entity';
import { HostedServerSourceToken } from '../database/entities/hosted-server-source-token.entity';
import { Conversation } from '../database/entities/conversation.entity';
import { TokenEncryptionModule } from '../common/token-encryption/token-encryption.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    // Conversation is here because `state.generatedCode` is where a generated
    // server's source actually lives durably - HostedServerSourceService reads
    // it to serve the source endpoint. See that file on why the on-disk copy
    // under GENERATED_SERVERS_DIR is not usable for this.
    TypeOrmModule.forFeature([
      HostedServer,
      HostedServerApiKey,
      HostedServerSourceToken,
      Conversation,
    ]),
    // TokenEncryptionModule: HostingService encrypts the env vars a hosted
    // server was deployed with so a restart can reproduce it - see
    // HostedServer.deployEnvEncrypted.
    TokenEncryptionModule,
    // For UserService: HostingService reads the caller's tier to enforce the
    // concurrent hosted-server cap.
    UserModule,
  ],
  // Three controllers share the `api/hosting` prefix but no routes:
  //   HostingController            - control plane (deploy/stop/keys), user-authenticated
  //   McpGatewayController         - data plane, owns `servers/:serverId/mcp`
  //   HostedServerSourceController - source delivery, owns `servers/:serverId/source`,
  //                                  authenticated as a SERVER rather than a user
  controllers: [HostingController, McpGatewayController, HostedServerSourceController],
  providers: [
    ContainerRegistryService,
    ManifestGeneratorService,
    K8sControlPlaneService,
    K8sReconcilerService,
    LocalDockerHostingService,
    HostingService,
    HostedServerApiKeyService,
    HostedServerSourceTokenService,
    HostedServerSourceService,
    SourceArchiveService,
    McpProxyService,
    McpUpstreamResolver,
    HostedMcpClientService,
    HostedServerGatewayGuard,
    HostedServerSourceGuard,
  ],
  exports: [
    ContainerRegistryService,
    ManifestGeneratorService,
    K8sControlPlaneService,
    K8sReconcilerService,
    LocalDockerHostingService,
    HostingService,
    HostedServerApiKeyService,
    HostedServerSourceTokenService,
    HostedServerSourceService,
    McpProxyService,
    McpUpstreamResolver,
    HostedMcpClientService,
  ],
})
export class HostingModule implements OnModuleInit {
  private readonly logger = new Logger(HostingModule.name);

  constructor(private readonly containerRegistryService: ContainerRegistryService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.containerRegistryService.login();
      this.logger.log('Hosting module initialized - GHCR login complete');
    } catch (error) {
      // Don't fail startup if GHCR login fails - it may not be configured
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`GHCR login failed during startup: ${errorMessage}`);
      this.logger.warn('Container registry features may not work properly');
    }
  }
}
