import { Controller, Get, Post, Delete, Patch, Body, Param } from '@nestjs/common';
import { ConversationService } from '../conversation.service';
import { DeploymentService } from '../database/services/deployment.service';

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
  ) {}

  /**
   * Get all conversations for the current user
   */
  @Get()
  async getConversations() {
    const conversations = await this.conversationService.findAll();
    return {
      conversations: conversations.map(conv => ({
        id: conv.id,
        title: this.generateTitle(conv),
        timestamp: conv.updatedAt || conv.createdAt,
        preview: this.generatePreview(conv),
        sessionId: conv.sessionId,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      })),
    };
  }

  /**
   * Get a single conversation by ID
   */
  @Get(':id')
  async getConversation(@Param('id') id: string) {
    const conversation = await this.conversationService.findById(id);
    return {
      conversation: {
        id: conversation.id,
        title: this.generateTitle(conversation),
        timestamp: conversation.updatedAt || conversation.createdAt,
        preview: this.generatePreview(conversation),
        sessionId: conversation.sessionId,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      },
    };
  }

  /**
   * Create a new conversation
   */
  @Post()
  async createConversation(@Body() dto: CreateConversationDto) {
    const conversation = await this.conversationService.create(dto.sessionId);
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
  async getConversationMessages(@Param('id') id: string) {
    const conversation = await this.conversationService.findById(id);
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];

    return {
      messages: messages.map((msg: any, index: number) => ({
        id: `${id}-${index}`,
        conversationId: id,
        content: msg.content || '',
        role: msg.role || 'assistant',
        timestamp: new Date(msg.timestamp || conversation.createdAt),
      })),
    };
  }

  /**
   * Get deployments for a specific conversation
   */
  @Get(':id/deployments')
  async getConversationDeployments(@Param('id') id: string) {
    const deployments = await this.deploymentService.getDeploymentsByConversation(id);
    return {
      deployments: deployments.map(dep => ({
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
  async getLatestDeployment(@Param('id') id: string) {
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
  async deleteConversation(@Param('id') id: string) {
    await this.conversationService.delete(id);
    return { success: true };
  }

  /**
   * Update conversation title
   */
  @Patch(':id')
  async updateConversationTitle(@Param('id') id: string, @Body() dto: UpdateConversationDto) {
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
   * Generate a title from conversation content
   */
  private generateTitle(conversation: any): string {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (messages.length > 0) {
      const firstMessage = messages[0].content || '';
      return firstMessage.substring(0, 50) + (firstMessage.length > 50 ? '...' : '');
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
