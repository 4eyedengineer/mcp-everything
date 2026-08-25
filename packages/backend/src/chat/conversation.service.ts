import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../database/entities';

/**
 * Conversation CRUD for the REST API.
 *
 * This is deliberately just persistence. Conversation *flow* lives in
 * GenerationPipeline - the previous version of this service carried a second,
 * competing conversation engine (hand-rolled Anthropic fetch client, in-memory
 * state map, its own intent detection) that nothing drove.
 */
@Injectable()
export class ConversationService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
  ) {}

  /**
   * Find all conversations owned by a specific user.
   * Legacy rows without an owner (userId IS NULL) are intentionally excluded.
   */
  async findAllByUser(userId: string): Promise<Conversation[]> {
    return this.conversationRepository.find({
      where: { userId },
      order: {
        updatedAt: 'DESC',
      },
    });
  }

  /**
   * Find conversation by ID
   */
  async findById(id: string): Promise<Conversation> {
    return this.conversationRepository.findOneOrFail({
      where: { id },
    });
  }

  /**
   * Find a conversation by ID scoped to its owner.
   *
   * @returns the conversation, or null when it does not exist or is owned by
   *          somebody else (callers should translate this to a 404 so that
   *          resource existence is not leaked).
   */
  async findByIdForUser(id: string, userId: string): Promise<Conversation | null> {
    return this.conversationRepository.findOne({
      where: { id, userId },
    });
  }

  /**
   * Create a new conversation
   */
  async create(sessionId: string, userId?: string): Promise<Conversation> {
    const conversation = this.conversationRepository.create({
      sessionId,
      userId,
      messages: [],
      state: {},
      isActive: true,
    });
    return this.conversationRepository.save(conversation);
  }

  /**
   * Delete a conversation
   */
  async delete(id: string): Promise<void> {
    await this.conversationRepository.delete(id);
  }

  /**
   * Update conversation title (stored in the state object)
   */
  async updateTitle(id: string, title: string): Promise<Conversation> {
    const conversation = await this.findById(id);
    // state is already an object, no need to JSON.parse
    conversation.state = {
      ...conversation.state,
      metadata: {
        ...(conversation.state?.metadata || {}),
        title,
      },
    };
    return this.conversationRepository.save(conversation);
  }
}
