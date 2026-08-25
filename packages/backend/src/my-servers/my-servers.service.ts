import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../database/entities/conversation.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { HostedServer } from '../database/entities/hosted-server.entity';

export type MyServerStatus = 'generated' | 'deployed' | 'hosted';

export interface MyServerEntry {
  conversationId: string;
  serverName: string;
  description?: string;
  toolCount: number;
  createdAt: Date;
  status: MyServerStatus;
  deployment?: {
    type: 'gist' | 'repo' | 'none';
    url?: string;
    deployedAt?: Date;
  };
  hosted?: {
    serverId: string;
    endpointUrl: string;
    status: string;
  };
}

/**
 * Aggregates the full "server lifecycle ladder" for a user:
 * GENERATED (pipeline success, code persisted on the conversation/message) ->
 * DEPLOYED (a `deployments` row exists with status 'success') ->
 * HOSTED (a `hosted_servers` row exists and isn't soft-deleted).
 *
 * Source of truth for "generated" is deliberately dual: `conversation.state
 * .generatedCode` (written by GenerationPipeline.persist) OR the last
 * assistant message's `metadata.generatedCode` (written to the same shape,
 * and backfilled onto historical conversations by the
 * BackfillMessageGeneratedCodeMetadata migration - see mcp-tools.service.ts
 * for the same fallback pattern used to serve the MCP proxy).
 */
@Injectable()
export class MyServersService {
  private readonly logger = new Logger(MyServersService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Deployment)
    private readonly deploymentRepository: Repository<Deployment>,
    @InjectRepository(HostedServer)
    private readonly hostedServerRepository: Repository<HostedServer>,
  ) {}

  async getMyServers(userId: string): Promise<MyServerEntry[]> {
    const conversations = await this.conversationRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    const generated = conversations
      .map((conversation) => this.toGeneratedEntry(conversation))
      .filter((entry): entry is MyServerEntry => entry !== null);

    if (generated.length === 0) {
      return generated;
    }

    const conversationIds = generated.map((g) => g.conversationId);

    const [deployments, hostedServers] = await Promise.all([
      this.deploymentRepository
        .createQueryBuilder('deployment')
        .where('deployment.conversationId IN (:...conversationIds)', { conversationIds })
        .andWhere('deployment.userId = :userId', { userId })
        .orderBy('deployment.createdAt', 'DESC')
        .getMany(),
      this.hostedServerRepository
        .createQueryBuilder('server')
        .where('server.conversationId IN (:...conversationIds)', { conversationIds })
        .andWhere('server.userId = :userId', { userId })
        .andWhere('server.status != :deleted', { deleted: 'deleted' })
        .orderBy('server.createdAt', 'DESC')
        .getMany(),
    ]);

    const latestDeploymentByConversation = new Map<string, Deployment>();
    for (const deployment of deployments) {
      // Repository already ordered DESC by createdAt, so the first one seen
      // per conversation is the latest.
      if (!latestDeploymentByConversation.has(deployment.conversationId)) {
        latestDeploymentByConversation.set(deployment.conversationId, deployment);
      }
    }

    const latestHostedByConversation = new Map<string, HostedServer>();
    for (const server of hostedServers) {
      if (!latestHostedByConversation.has(server.conversationId)) {
        latestHostedByConversation.set(server.conversationId, server);
      }
    }

    for (const entry of generated) {
      const deployment = latestDeploymentByConversation.get(entry.conversationId);
      if (deployment && deployment.status === 'success') {
        entry.status = 'deployed';
        entry.deployment = {
          type: deployment.deploymentType,
          url: deployment.repositoryUrl || deployment.gistUrl || deployment.codespaceUrl,
          deployedAt: deployment.deployedAt,
        };
        if (!entry.description && deployment.description) {
          entry.description = deployment.description;
        }
      }

      const hosted = latestHostedByConversation.get(entry.conversationId);
      if (hosted) {
        entry.status = 'hosted';
        entry.hosted = {
          serverId: hosted.serverId,
          endpointUrl: hosted.endpointUrl,
          status: hosted.status,
        };
        if (!entry.description && hosted.description) {
          entry.description = hosted.description;
        }
      }
    }

    return generated;
  }

  /**
   * Extract a generated-server entry from a conversation, or null when it has
   * no generated code yet (still mid-pipeline, or never produced one).
   */
  private toGeneratedEntry(conversation: Conversation): MyServerEntry | null {
    const fromState = conversation.state?.generatedCode;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const lastAssistantWithCode = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.metadata?.generatedCode);
    const generatedCode = fromState ?? lastAssistantWithCode?.metadata?.generatedCode;

    if (!generatedCode) {
      return null;
    }

    const serverName =
      generatedCode.metadata?.serverName ||
      conversation.state?.serverName ||
      this.deriveTitleFromMessages(messages) ||
      'Untitled MCP Server';

    const toolCount = Array.isArray(generatedCode.metadata?.tools)
      ? generatedCode.metadata.tools.length
      : 0;

    const entry: MyServerEntry = {
      conversationId: conversation.id,
      serverName,
      toolCount,
      createdAt: conversation.createdAt,
      status: 'generated',
    };

    return entry;
  }

  private deriveTitleFromMessages(messages: Conversation['messages']): string | undefined {
    const firstUserMessage = messages.find((m) => m.role === 'user');
    if (!firstUserMessage) {
      return undefined;
    }
    const content = firstUserMessage.content || '';
    return content.substring(0, 50) + (content.length > 50 ? '...' : '');
  }
}
