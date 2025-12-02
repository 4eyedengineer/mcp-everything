import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { ContainerRegistryService } from './services/container-registry.service';

@Module({
  providers: [ContainerRegistryService],
  exports: [ContainerRegistryService],
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
      this.logger.warn(`GHCR login failed during startup: ${error.message}`);
      this.logger.warn('Container registry features may not work properly');
    }
  }
}
