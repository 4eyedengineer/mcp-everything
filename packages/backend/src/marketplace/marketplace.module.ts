import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpServer } from '../database/entities/mcp-server.entity';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { AdminGuard } from './guards/admin.guard';

@Module({
  imports: [TypeOrmModule.forFeature([McpServer])],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, AdminGuard],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
