import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContainerRegistryService } from './services/container-registry.service';
import { ManifestGeneratorService } from './services/manifest-generator.service';
import { GitOpsService } from './services/gitops.service';
import { LocalDockerHostingService } from './services/local-docker-hosting.service';
import { HostingService } from './hosting.service';
import { HostedServerApiKeyService } from './hosted-server-api-key.service';
import { HostingController } from './hosting.controller';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { HostedServerApiKey } from '../database/entities/hosted-server-api-key.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([HostedServer, HostedServerApiKey, Deployment]),
    // For UserService: HostingService reads the caller's tier to enforce the
    // concurrent hosted-server cap.
    UserModule,
  ],
  controllers: [HostingController],
  providers: [
    ContainerRegistryService,
    ManifestGeneratorService,
    GitOpsService,
    LocalDockerHostingService,
    HostingService,
    HostedServerApiKeyService,
  ],
  exports: [
    ContainerRegistryService,
    ManifestGeneratorService,
    GitOpsService,
    LocalDockerHostingService,
    HostingService,
    HostedServerApiKeyService,
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
