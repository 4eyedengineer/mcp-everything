import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatController } from './chat.controller';
import { ConversationController } from './conversation.controller';
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
import { McpTestingService } from '../testing/mcp-testing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, ConversationMemory, ResearchCache, Deployment]),
  ],
  controllers: [ChatController, ConversationController],
  providers: [
    // Core orchestration
    GraphOrchestrationService,
    CodeExecutionService,
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
    McpTestingService,
  ],
  exports: [
    GraphOrchestrationService,
    CodeExecutionService,
    DeploymentService,
  ],
})
export class ChatModule {}
