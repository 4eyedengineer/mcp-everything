import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatController } from './chat.controller';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { StreamTicketService } from './stream-ticket.service';
import { GenerationPipeline } from '../orchestration/pipeline.service';
import { CodeExecutionService } from '../orchestration/code-execution.service';
import { GitHubAnalysisService } from '../github-analysis.service';
import { EnvVariableService } from '../env-variable.service';
import { Conversation, PipelineRun, Deployment } from '../database/entities';
// Generation pipeline steps
import { ResearchService } from '../orchestration/research.service';
import { ClarificationService } from '../orchestration/clarification.service';
import { RefinementService } from '../orchestration/refinement.service';
import { DeploymentService } from '../database/services/deployment.service';
import { TestingModule } from '../testing/testing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, PipelineRun, Deployment]),
    // McpTestingService owns Docker container lifecycle/state (running
    // containers map); it must be a single shared instance, not
    // independently provided per module. See TestingModule.
    TestingModule,
  ],
  controllers: [ChatController, ConversationController],
  providers: [
    // The single generation pipeline
    GenerationPipeline,
    CodeExecutionService,
    // SSE stream authorization tickets
    StreamTicketService,
    // Research inputs
    GitHubAnalysisService,
    // Conversation CRUD for the REST API
    ConversationService,
    // Environment variable management
    EnvVariableService,
    // Pipeline steps
    ResearchService,
    ClarificationService,
    RefinementService,
    DeploymentService,
  ],
  exports: [GenerationPipeline, CodeExecutionService, DeploymentService],
})
export class ChatModule {}
