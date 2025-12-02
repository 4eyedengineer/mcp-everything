import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { Conversation } from './database/entities';

// Anthropic API client (simple HTTP implementation)
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{ text: string; type: 'text' }>;
}

// Conversation state management
interface ConversationState {
  id: string;
  messages: AnthropicMessage[];
  intent?: string;
  extractedUrl?: string;
  repositoryData?: any;
  stage: 'intent_detection' | 'url_extraction' | 'clarification' | 'generation' | 'completed';
  createdAt: Date;
}

// Intent detection result
interface IntentResult {
  intent: 'generate_mcp_server' | 'help' | 'clarification_needed' | 'unknown';
  confidence: number;
  extractedInfo?: {
    repositoryReference?: string;
    specifications?: string[];
  };
  needsClarification?: string;
}

// URL extraction result
interface UrlExtractionResult {
  success: boolean;
  githubUrl?: string;
  repositoryName?: string;
  clarificationNeeded?: string;
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private conversations: Map<string, ConversationState> = new Map();
  private anthropicApiKey: string;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Conversation)
    private conversationRepository: Repository<Conversation>,
  ) {
    this.anthropicApiKey = this.configService.get<string>('ANTHROPIC_API_KEY') || '';
  }

  /**
   * Main conversation handler - processes natural language input
   */
  async processConversation(
    userMessage: string,
    conversationId?: string,
  ): Promise<{
    success: boolean;
    conversationId: string;
    intent?: string;
    extractedUrl?: string;
    response: string;
    server?: any;
    followUp?: string;
    stage: string;
  }> {
    try {
      // Get or create conversation state
      let conversation: ConversationState;
      if (conversationId && this.conversations.has(conversationId)) {
        conversation = this.conversations.get(conversationId)!;
      } else {
        conversation = {
          id: uuidv4(),
          messages: [],
          stage: 'intent_detection',
          createdAt: new Date(),
        };
        this.conversations.set(conversation.id, conversation);
      }

      // Add user message to conversation
      conversation.messages.push({ role: 'user', content: userMessage });

      // Process based on current stage
      switch (conversation.stage) {
        case 'intent_detection':
          return await this.handleIntentDetection(conversation, userMessage);

        case 'url_extraction':
          return await this.handleUrlExtraction(conversation, userMessage);

        case 'clarification':
          return await this.handleClarification(conversation, userMessage);

        case 'generation':
          return await this.handleGeneration(conversation);

        default:
          return {
            success: false,
            conversationId: conversation.id,
            response:
              "I'm not sure how to help with that. Try asking me to generate an MCP server from a GitHub repository.",
            stage: conversation.stage,
          };
      }
    } catch (error) {
      this.logger.error(`Conversation processing failed: ${error.message}`);
      return {
        success: false,
        conversationId: conversationId || 'error',
        response: 'Sorry, I encountered an error processing your request. Please try again.',
        stage: 'error',
      };
    }
  }

  /**
   * Stage 1: Intent Detection with optimized prompt
   */
  private async handleIntentDetection(
    conversation: ConversationState,
    userMessage: string,
  ): Promise<any> {
    const intentPrompt = this.buildIntentDetectionPrompt(userMessage);
    const intentResult = await this.callAnthropic(intentPrompt);

    let parsedIntent: IntentResult;
    try {
      // Clean and validate JSON response
      const cleanedResponse = this.cleanMinimalJson(intentResult);
      parsedIntent = JSON.parse(cleanedResponse);

      // Validate structure
      if (!parsedIntent.intent || !parsedIntent.confidence) {
        throw new Error('Missing required fields in intent response');
      }
    } catch (error) {
      this.logger.warn(
        `Intent JSON parsing failed: ${error.message}. Response: ${intentResult.substring(0, 100)}`,
      );
      parsedIntent = this.fallbackIntentParsing(intentResult, userMessage);
    }

    conversation.intent = parsedIntent.intent;

    switch (parsedIntent.intent) {
      case 'generate_mcp_server':
        conversation.stage = 'url_extraction';
        return await this.handleUrlExtraction(conversation, userMessage);

      case 'help':
        return {
          success: true,
          conversationId: conversation.id,
          intent: 'help',
          response: `I help you generate MCP (Model Context Protocol) servers from GitHub repositories!

You can ask me things like:
• "Generate an MCP server for https://github.com/microsoft/vscode"
• "Create a server from the React repository"
• "Make an MCP server for my auth library at github.com/user/repo"

Just tell me about the repository you'd like to turn into an MCP server!`,
          stage: 'completed',
        };

      case 'clarification_needed':
        conversation.stage = 'clarification';
        return {
          success: true,
          conversationId: conversation.id,
          intent: 'clarification_needed',
          response:
            parsedIntent.needsClarification ||
            "Could you provide more details about the GitHub repository you'd like to generate an MCP server from?",
          stage: 'clarification',
        };

      default:
        return {
          success: false,
          conversationId: conversation.id,
          intent: 'unknown',
          response:
            "I specialize in generating MCP servers from GitHub repositories. Could you tell me about a repository you'd like to convert?",
          stage: 'intent_detection',
        };
    }
  }

  /**
   * Stage 2: URL Extraction with repository resolution
   */
  private async handleUrlExtraction(
    conversation: ConversationState,
    userMessage: string,
  ): Promise<any> {
    const extractionPrompt = this.buildUrlExtractionPrompt(userMessage, conversation.messages);
    const extractionResult = await this.callAnthropic(extractionPrompt);

    let parsedExtraction: UrlExtractionResult;
    try {
      // Clean and validate JSON response
      const cleanedResponse = this.cleanMinimalJson(extractionResult);
      parsedExtraction = JSON.parse(cleanedResponse);

      // Validate structure
      if (typeof parsedExtraction.success !== 'boolean') {
        throw new Error('Invalid URL extraction response structure');
      }
    } catch (error) {
      this.logger.warn(
        `URL extraction JSON parsing failed: ${error.message}. Response: ${extractionResult.substring(0, 100)}`,
      );
      parsedExtraction = this.fallbackUrlExtraction(extractionResult, userMessage);
    }

    if (parsedExtraction.success && parsedExtraction.githubUrl) {
      conversation.extractedUrl = parsedExtraction.githubUrl;
      conversation.stage = 'generation';
      return await this.handleGeneration(conversation);
    } else {
      conversation.stage = 'clarification';
      return {
        success: false,
        conversationId: conversation.id,
        response:
          parsedExtraction.clarificationNeeded ||
          "I couldn't find a GitHub repository in your message. Could you provide a GitHub URL or repository name?",
        stage: 'clarification',
      };
    }
  }

  /**
   * Stage 3: Handle clarification requests
   */
  private async handleClarification(
    conversation: ConversationState,
    userMessage: string,
  ): Promise<any> {
    // Try URL extraction again with the clarification
    return await this.handleUrlExtraction(conversation, userMessage);
  }

  /**
   * Stage 4: Generate MCP Server (delegates to existing service)
   */
  private async handleGeneration(conversation: ConversationState): Promise<any> {
    if (!conversation.extractedUrl) {
      return {
        success: false,
        conversationId: conversation.id,
        response: 'I need a GitHub repository URL to generate an MCP server.',
        stage: 'url_extraction',
      };
    }

    try {
      // This would integrate with your existing GitHubService and generation logic
      // For now, return a placeholder response indicating successful extraction
      conversation.stage = 'completed';

      return {
        success: true,
        conversationId: conversation.id,
        intent: 'generate_mcp_server',
        extractedUrl: conversation.extractedUrl,
        response: `Great! I've identified the repository: ${conversation.extractedUrl}

I'm now generating an MCP server for this repository. The server will include:
• Repository analysis and metadata extraction
• Custom tools based on the repository's functionality
• Complete TypeScript implementation with MCP SDK
• Ready-to-run package with build configuration

Would you like me to proceed with the generation?`,
        followUp:
          'Would you like to customize any specific tools or functionality for this MCP server?',
        stage: 'completed',
      };
    } catch (error) {
      this.logger.error(`Generation failed: ${error.message}`);
      return {
        success: false,
        conversationId: conversation.id,
        response: `I found the repository (${conversation.extractedUrl}) but encountered an error during generation. Please try again.`,
        stage: 'generation',
      };
    }
  }

  /**
   * OPTIMIZED PROMPT: Intent Detection
   * Enforces strict JSON structure with validation
   */
  private buildIntentDetectionPrompt(userMessage: string): string {
    return `You must respond with ONLY valid JSON. No text before or after. No markdown code blocks.

User message: "${userMessage}"

Analyze intent and respond with this EXACT JSON structure:

{
  "intent": "generate_mcp_server",
  "confidence": 0.9,
  "extractedInfo": {
    "repositoryReference": "github.com/owner/repo or null",
    "specifications": []
  },
  "needsClarification": null
}

VALID intent values ONLY:
- "generate_mcp_server" (user wants MCP server from repository)
- "help" (user needs general assistance)
- "clarification_needed" (message unclear)
- "unknown" (request outside capabilities)

CONFIDENCE must be 0.0-1.0 decimal
REPOSITORY REFERENCE: GitHub URL/name if found, otherwise null
CLARIFICATION: Question string if intent unclear, otherwise null

Respond with JSON only:`;
  }

  /**
   * OPTIMIZED PROMPT: URL Extraction and Repository Resolution
   * Strict JSON format with repository mapping
   */
  private buildUrlExtractionPrompt(
    userMessage: string,
    conversationHistory: AnthropicMessage[],
  ): string {
    const recentContext = conversationHistory
      .slice(-3)
      .map((m) => `${m.role}: ${m.content}`)
      .join(' | ');

    return `Respond ONLY with valid JSON. No markdown. No explanations.

Context: ${recentContext}
Latest: "${userMessage}"

Extract GitHub repository. Use this EXACT JSON format:

{
  "success": true,
  "githubUrl": "https://github.com/owner/repo",
  "repositoryName": "Repo Name",
  "clarificationNeeded": null
}

Repository mappings (case-insensitive):
"react" -> "https://github.com/facebook/react"
"vue" -> "https://github.com/vuejs/vue"
"express" -> "https://github.com/expressjs/express"
"vscode" -> "https://github.com/microsoft/vscode"
"typescript" -> "https://github.com/microsoft/TypeScript"
"node" -> "https://github.com/nodejs/node"
"angular" -> "https://github.com/angular/angular"
"svelte" -> "https://github.com/sveltejs/svelte"

URL patterns:
- https://github.com/owner/repo
- github.com/owner/repo
- owner/repo
- Popular names (use mappings)

If NO repository found:
{"success": false, "clarificationNeeded": "Please provide a GitHub URL or repository name"}

JSON response:`;
  }

  /**
   * Public method for external services to call Anthropic API
   */
  async callAnthropicForService(prompt: string): Promise<string> {
    return this.callAnthropic(prompt);
  }

  /**
   * Call Anthropic API
   */
  private async callAnthropic(prompt: string): Promise<string> {
    if (!this.anthropicApiKey) {
      throw new Error('Anthropic API key not configured');
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status}`);
      }

      const data: AnthropicResponse = await response.json();
      return data.content[0]?.text || '';
    } catch (error) {
      this.logger.error(`Anthropic API call failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Enhanced fallback with strict validation
   */
  private fallbackIntentParsing(response: string, userMessage: string): IntentResult {
    this.logger.warn(`Intent JSON parsing failed. Response: ${response.substring(0, 200)}`);

    const lowerMessage = userMessage.toLowerCase();

    // Simple keyword-based classification
    if (lowerMessage.includes('help') || lowerMessage.includes('what can you')) {
      return { intent: 'help', confidence: 0.7 };
    }

    if (
      lowerMessage.includes('github') ||
      lowerMessage.includes('repository') ||
      lowerMessage.includes('repo') ||
      lowerMessage.includes('generate') ||
      lowerMessage.includes('create') ||
      lowerMessage.includes('mcp')
    ) {
      return {
        intent: 'generate_mcp_server',
        confidence: 0.6,
        extractedInfo: { repositoryReference: userMessage },
      };
    }

    return {
      intent: 'clarification_needed',
      confidence: 0.5,
      needsClarification:
        "Could you tell me about the GitHub repository you'd like to create an MCP server from?",
    };
  }

  /**
   * Enhanced fallback with logging and validation
   */
  private fallbackUrlExtraction(response: string, userMessage: string): UrlExtractionResult {
    this.logger.warn(`URL extraction JSON parsing failed. Response: ${response.substring(0, 200)}`);

    // GitHub URL patterns
    const githubUrlPattern = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)/i;

    const match = userMessage.match(githubUrlPattern);
    if (match) {
      return {
        success: true,
        githubUrl: `https://github.com/${match[1]}/${match[2]}`,
        repositoryName: match[2],
      };
    }

    // Popular repository mappings
    const popularRepos: Record<string, { url: string; name: string }> = {
      react: { url: 'https://github.com/facebook/react', name: 'React' },
      vue: { url: 'https://github.com/vuejs/vue', name: 'Vue' },
      express: { url: 'https://github.com/expressjs/express', name: 'Express' },
      vscode: { url: 'https://github.com/microsoft/vscode', name: 'VS Code' },
      typescript: { url: 'https://github.com/microsoft/TypeScript', name: 'TypeScript' },
      angular: { url: 'https://github.com/angular/angular', name: 'Angular' },
      svelte: { url: 'https://github.com/sveltejs/svelte', name: 'Svelte' },
    };

    for (const [key, repo] of Object.entries(popularRepos)) {
      if (userMessage.toLowerCase().includes(key)) {
        return {
          success: true,
          githubUrl: repo.url,
          repositoryName: repo.name,
        };
      }
    }

    return {
      success: false,
      clarificationNeeded:
        "Please provide a GitHub URL or repository name (e.g., 'github.com/owner/repo' or 'react')",
    };
  }

  /**
   * Minimal JSON cleaning for validation
   */
  private cleanMinimalJson(response: string): string {
    if (!response) return '{}';

    let cleaned = response.trim();

    // Remove markdown blocks
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

    // Extract JSON object
    const openBrace = cleaned.indexOf('{');
    const closeBrace = cleaned.lastIndexOf('}');

    if (openBrace !== -1 && closeBrace > openBrace) {
      cleaned = cleaned.substring(openBrace, closeBrace + 1);
    }

    return cleaned;
  }

  /**
   * Clean up old conversations (simple memory management)
   */
  private cleanupOldConversations(): void {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    for (const [id, conversation] of this.conversations.entries()) {
      if (conversation.createdAt < oneHourAgo) {
        this.conversations.delete(id);
      }
    }
  }

  /**
   * TypeORM Repository Methods for REST API
   */

  /**
   * Find all conversations
   */
  async findAll(): Promise<Conversation[]> {
    return this.conversationRepository.find({
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
   * Create a new conversation
   */
  async create(sessionId: string): Promise<Conversation> {
    const conversation = this.conversationRepository.create({
      sessionId,
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
   * Update conversation title (stored in state object)
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
