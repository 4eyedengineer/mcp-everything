import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from '../database/entities/conversation.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { MyServersController } from './my-servers.controller';
import { MyServersService } from './my-servers.service';

/**
 * Read-only aggregation of a user's generated/deployed/hosted MCP servers for
 * the "My Servers" page. Deliberately does not depend on ChatModule,
 * DeploymentModule, or HostingModule - it reads their entities directly
 * (Conversation, Deployment, HostedServer) rather than reaching into their
 * services, so it stays a pure read-side view with no risk of touching those
 * modules' write paths.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Conversation, Deployment, HostedServer])],
  controllers: [MyServersController],
  providers: [MyServersService],
})
export class MyServersModule {}
