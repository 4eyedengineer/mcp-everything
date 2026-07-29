import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatController } from './chat.controller';
import { ConversationController } from './conversation.controller';
import { StreamTicketService } from './stream-ticket.service';
import { GraphOrchestrationService } from '../orchestration/graph.service';
import { CodeExecutionService } from '../orchestration/code-execution.service';
import { GitHubAnalysisService } from '../github-analysis.service';
import { ToolDiscoveryService } from '../tool-discovery.service';
import { McpGenerationService } from '../mcp-generation.service';
import { ConversationService } from '../conversation.service';
import { EnvVariableService } from '../env-variable.service';
import { Conversation, ConversationMemory, ResearchCache, Deployment } from '../database/entities';
// Ensemble architecture services
import { ResearchService } from '../orchestration/research.service';
import { EnsembleService } from '../orchestration/ensemble.service';
import { ClarificationService } from '../orchestration/clarification.service';
import { RefinementService } from '../orchestration/refinement.service';
import { ResearchCacheService } from '../database/services/research-cache.service';
import { DeploymentService } from '../database/services/deployment.service';
import { TestingModule } from '../testing/testing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, ConversationMemory, ResearchCache, Deployment]),
    // McpTestingService owns Docker container lifecycle/state (running
    // containers map); it must be a single shared instance, not
    // independently provided per module. See TestingModule.
    TestingModule,
  ],
  controllers: [ChatController, ConversationController],
  providers: [
    // Core orchestration
    GraphOrchestrationService,
    CodeExecutionService,
    // SSE stream authorization tickets
    StreamTicketService,
    // GitHub and code generation services
    GitHubAnalysisService,
    ToolDiscoveryService,
    McpGenerationService,
    ConversationService,
    // Environment variable management
    EnvVariableService,
    // Ensemble architecture services
    ResearchService,
    EnsembleService,
    ClarificationService,
    RefinementService,
    ResearchCacheService,
    DeploymentService,
  ],
  exports: [GraphOrchestrationService, CodeExecutionService, DeploymentService],
})
export class ChatModule {}
