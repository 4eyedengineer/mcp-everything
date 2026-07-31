import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  ParseUUIDPipe,
  NotFoundException,
} from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { DeploymentService } from '../database/services/deployment.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';
import { Conversation } from '../database/entities/conversation.entity';
import { PipelineStatusService } from './pipeline-status.service';
// Note: All routes protected by global JWT guard - user authenticated automatically

interface CreateConversationDto {
  sessionId: string;
}

interface UpdateConversationDto {
  title: string;
}

@Controller('api/conversations')
export class ConversationController {
  constructor(
    private conversationService: ConversationService,
    private deploymentService: DeploymentService,
    private pipelineStatus: PipelineStatusService,
  ) {}

  /**
   * Load a conversation owned by the current user.
   * Throws NotFoundException when it does not exist OR belongs to another user
   * (including legacy rows with no owner) so existence is never leaked.
   */
  private async getOwnedConversationOrFail(id: string, userId: string): Promise<Conversation> {
    const conversation = await this.conversationService.findByIdForUser(id, userId);
    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }
    return conversation;
  }

  /**
   * Get all conversations for the current user
   */
  @Get()
  async getConversations(@CurrentUser() user: User) {
    const conversations = await this.conversationService.findAllByUser(user.id);
    return {
      conversations: conversations.map((conv) => ({
        id: conv.id,
        title: this.generateTitle(conv),
        timestamp: conv.updatedAt || conv.createdAt,
        preview: this.generatePreview(conv),
        sessionId: conv.sessionId,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        // Lets the sidebar/chat page know whether a pipeline run is still
        // executing (real-time, this process) or paused awaiting the user's
        // next message (durable, survives restarts) without fetching history.
        isGenerating: this.pipelineStatus.isExecuting(conv.id),
        awaitingClarification: this.isAwaitingClarification(conv),
      })),
    };
  }

  /**
   * Get a single conversation by ID
   * FIX #130: Include state field for frontend to access generatedCode
   */
  @Get(':id')
  async getConversation(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    const conversation = await this.getOwnedConversationOrFail(id, user.id);
    return {
      conversation: {
        id: conversation.id,
        title: this.generateTitle(conversation),
        timestamp: conversation.updatedAt || conversation.createdAt,
        preview: this.generatePreview(conversation),
        sessionId: conversation.sessionId,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        // FIX #130: Include state for generatedCode access
        state: conversation.state,
        // Whether the pipeline is actively streaming right now vs paused
        // waiting on the user - lets the frontend restore the correct UI
        // (processing spinner + SSE reconnect vs a normal idle conversation)
        // when the user returns to /chat/:id mid-generation or after a
        // refresh.
        isGenerating: this.pipelineStatus.isExecuting(conversation.id),
        awaitingClarification: this.isAwaitingClarification(conversation),
      },
    };
  }

  /**
   * Create a new conversation
   */
  @Post()
  async createConversation(@CurrentUser() user: User, @Body() dto: CreateConversationDto) {
    const conversation = await this.conversationService.create(dto.sessionId, user.id);
    return {
      conversation: {
        id: conversation.id,
        title: 'New conversation',
        timestamp: conversation.createdAt,
        sessionId: conversation.sessionId,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      },
    };
  }

  /**
   * Get messages for a specific conversation
   */
  @Get(':id/messages')
  async getConversationMessages(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    const conversation = await this.getOwnedConversationOrFail(id, user.id);
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];

    return {
      messages: messages.map((msg: any, index: number) => ({
        id: `${id}-${index}`,
        conversationId: id,
        content: msg.content || '',
        role: msg.role || 'assistant',
        timestamp: new Date(msg.timestamp || conversation.createdAt),
        // Generated code + validation summary, when this message carries them
        // (set by GenerationPipeline.persist at generation-complete time).
        // Lets a reloaded conversation restore Deploy/Download actions and
        // the validation badge, which previously only ever existed in the
        // one-shot SSE `complete` event and were lost on refresh. Ownership
        // of the conversation - and therefore this generated source - is
        // already enforced by getOwnedConversationOrFail above.
        ...(msg.metadata ? { metadata: msg.metadata } : {}),
      })),
    };
  }

  /**
   * Get deployments for a specific conversation
   */
  @Get(':id/deployments')
  async getConversationDeployments(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.getOwnedConversationOrFail(id, user.id);
    const deployments = await this.deploymentService.getDeploymentsByConversation(id);
    return {
      deployments: deployments.map((dep) => ({
        id: dep.id,
        conversationId: dep.conversationId,
        deploymentType: dep.deploymentType,
        repositoryUrl: dep.repositoryUrl,
        gistUrl: dep.gistUrl,
        codespaceUrl: dep.codespaceUrl,
        status: dep.status,
        errorMessage: dep.errorMessage,
        metadata: dep.metadata,
        createdAt: dep.createdAt,
        deployedAt: dep.deployedAt,
      })),
    };
  }

  /**
   * Get the latest deployment for a specific conversation
   */
  @Get(':id/deployments/latest')
  async getLatestDeployment(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.getOwnedConversationOrFail(id, user.id);
    const deployment = await this.deploymentService.getLatestDeployment(id);
    if (!deployment) {
      return { deployment: null };
    }
    return {
      deployment: {
        id: deployment.id,
        conversationId: deployment.conversationId,
        deploymentType: deployment.deploymentType,
        repositoryUrl: deployment.repositoryUrl,
        gistUrl: deployment.gistUrl,
        codespaceUrl: deployment.codespaceUrl,
        status: deployment.status,
        errorMessage: deployment.errorMessage,
        metadata: deployment.metadata,
        createdAt: deployment.createdAt,
        deployedAt: deployment.deployedAt,
      },
    };
  }

  /**
   * Delete a conversation
   */
  @Delete(':id')
  async deleteConversation(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.getOwnedConversationOrFail(id, user.id);
    await this.conversationService.delete(id);
    return { success: true };
  }

  /**
   * Update conversation title
   */
  @Patch(':id')
  async updateConversationTitle(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    await this.getOwnedConversationOrFail(id, user.id);
    const conversation = await this.conversationService.updateTitle(id, dto.title);
    return {
      conversation: {
        id: conversation.id,
        title: dto.title,
        timestamp: conversation.updatedAt || conversation.createdAt,
        sessionId: conversation.sessionId,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      },
    };
  }

  /**
   * Whether the conversation has a saved, resumable pipeline state (i.e. it
   * paused awaiting a clarification reply rather than finishing normally).
   * Persisted on the conversation row by GenerationPipeline.saveState/
   * clearSavedState, so this survives server restarts unlike `isGenerating`.
   */
  private isAwaitingClarification(conversation: Conversation): boolean {
    return Boolean(conversation.state?.pipeline?.awaitingClarification);
  }

  /**
   * Generate a title from conversation content
   */
  private generateTitle(conversation: any): string {
    // First check if title is stored in state metadata
    if (conversation.state?.metadata?.title) {
      return conversation.state.metadata.title;
    }

    // Fall back to deriving from first user message
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const firstUserMessage = messages.find((m: any) => m.role === 'user');
    if (firstUserMessage) {
      const content = firstUserMessage.content || '';
      return content.substring(0, 50) + (content.length > 50 ? '...' : '');
    }

    return 'New conversation';
  }

  /**
   * Generate a preview from conversation content
   */
  private generatePreview(conversation: any): string {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      const content = lastMessage.content || '';
      return content.substring(0, 100) + (content.length > 100 ? '...' : '');
    }
    return '';
  }
}
