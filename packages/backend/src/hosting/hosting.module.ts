import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContainerRegistryService } from './services/container-registry.service';
import { ManifestGeneratorService } from './services/manifest-generator.service';
import { K8sControlPlaneService } from './services/k8s-control-plane.service';
import { K8sReconcilerService } from './services/k8s-reconciler.service';
import { LocalDockerHostingService } from './services/local-docker-hosting.service';
import { HostingService } from './hosting.service';
import { HostedServerApiKeyService } from './hosted-server-api-key.service';
import { HostingController } from './hosting.controller';
import { McpGatewayController } from './mcp-gateway.controller';
import { McpProxyService } from './services/mcp-proxy.service';
import { McpUpstreamResolver } from './services/mcp-upstream-resolver.service';
import { HostedServerGatewayGuard } from './guards/hosted-server-gateway.guard';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { HostedServerApiKey } from '../database/entities/hosted-server-api-key.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { TokenEncryptionModule } from '../common/token-encryption/token-encryption.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([HostedServer, HostedServerApiKey, Deployment]),
    // TokenEncryptionModule: HostingService encrypts the env vars a hosted
    // server was deployed with so a restart can reproduce it - see
    // HostedServer.deployEnvEncrypted.
    TokenEncryptionModule,
    // For UserService: HostingService reads the caller's tier to enforce the
    // concurrent hosted-server cap.
    UserModule,
  ],
  // McpGatewayController is the data plane (proxying MCP traffic to hosted
  // servers); HostingController is the control plane (deploy/stop/keys). They
  // share the `api/hosting` prefix but no routes - the gateway owns exactly
  // `servers/:serverId/mcp`.
  controllers: [HostingController, McpGatewayController],
  providers: [
    ContainerRegistryService,
    ManifestGeneratorService,
    K8sControlPlaneService,
    K8sReconcilerService,
    LocalDockerHostingService,
    HostingService,
    HostedServerApiKeyService,
    McpProxyService,
    McpUpstreamResolver,
    HostedServerGatewayGuard,
  ],
  exports: [
    ContainerRegistryService,
    ManifestGeneratorService,
    K8sControlPlaneService,
    K8sReconcilerService,
    LocalDockerHostingService,
    HostingService,
    HostedServerApiKeyService,
    McpProxyService,
    McpUpstreamResolver,
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
