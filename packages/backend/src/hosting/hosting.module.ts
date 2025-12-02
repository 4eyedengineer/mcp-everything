import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContainerRegistryService } from './services/container-registry.service';
import { ManifestGeneratorService } from './services/manifest-generator.service';
import { GitOpsService } from './services/gitops.service';
import { HostingService } from './hosting.service';
import { HostingController } from './hosting.controller';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { Deployment } from '../database/entities/deployment.entity';

@Module({
  imports: [TypeOrmModule.forFeature([HostedServer, Deployment])],
  controllers: [HostingController],
  providers: [
    ContainerRegistryService,
    ManifestGeneratorService,
    GitOpsService,
    HostingService,
  ],
  exports: [
    ContainerRegistryService,
    ManifestGeneratorService,
    GitOpsService,
    HostingService,
  ],
})
export class HostingModule implements OnModuleInit {
  private readonly logger = new Logger(HostingModule.name);

  constructor(
    private readonly containerRegistryService: ContainerRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.containerRegistryService.login();
      this.logger.log('Hosting module initialized - GHCR login complete');
    } catch (error) {
      // Don't fail startup if GHCR login fails - it may not be configured
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`GHCR login failed during startup: ${errorMessage}`);
      this.logger.warn('Container registry features may not work properly');
    }
  }
}
