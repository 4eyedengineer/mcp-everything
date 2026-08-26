import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Conversation } from '../database/entities';
import { GenerationPipeline, PipelineUpdate } from '../orchestration/pipeline.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { SortField, SortOrder } from '../marketplace/dto/search-servers.dto';
import { HostingService } from '../hosting/hosting.service';
import { HostedMcpClientService } from '../hosting/services/hosted-mcp-client.service';

/**
 * Delegates every MCP tool call to the exact same services the chat UI uses:
 * `GenerationPipeline` (quota + intent gate + clarification all apply
 * identically whether the caller is the Angular frontend or an external
 * agent), `MarketplaceService`, and direct, ownership-scoped reads of the
 * `conversations` table.
 *
 * No business logic lives here - only translation between MCP's
 * request/response shape and the platform's existing entry points, plus
 * turning failures into MCP tool errors (`isError: true`) instead of letting
 * them reach the transport as protocol-level errors or uncaught 500s.
 */
@Injectable()
export class McpToolsService {
  private readonly logger = new Logger(McpToolsService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    private readonly pipeline: GenerationPipeline,
    private readonly marketplaceService: MarketplaceService,
    private readonly hostingService: HostingService,
    private readonly hostedMcpClientService: HostedMcpClientService,
  ) {}

  /**
   * Registers all MCP Everything tools on a per-request `McpServer`
   * instance, bound to the already-authenticated `userId`.
   *
   * Called once per HTTP request (see `McpServerController`) since the
   * transport is stateless per the 2026-07-28 spec - there is no long-lived
   * server/session to register tools on once and reuse.
   */
  registerTools(server: McpServer, userId: string): void {
    server.registerTool(
      'generate_mcp_server',
      {
        title: 'Generate MCP Server',
        description:
          'Starts generating a new MCP server from a natural-language description, using the ' +
          'same GenerationPipeline the chat UI drives (intent analysis, research, tool planning, ' +
          'clarification, and a Docker-sandboxed generate-test-refine loop). ' +
          "COST NOTE: this consumes one unit of the caller's monthly generation quota and " +
          'incurs real AI inference cost (research + planning + up to 5 refinement iterations). ' +
          'Confirm with your user before calling this tool. Quota limits are enforced ' +
          'server-side regardless. If the pipeline needs more information it returns a ' +
          'clarifying question instead of code - reply to it with continue_generation.',
        inputSchema: {
          description: z
            .string()
            .min(3)
            .max(4000)
            .describe(
              'What the generated MCP server should do, e.g. "a server that wraps the Stripe ' +
                'API for read-only invoice and customer lookups".',
            ),
        },
      },
      async ({ description }) => this.generateMcpServer(userId, description),
    );

    server.registerTool(
      'continue_generation',
      {
        title: 'Continue Generation',
        description:
          'Sends a follow-up message into an existing generation conversation - most commonly ' +
          'an answer to a clarifying question returned by generate_mcp_server or a previous ' +
          'continue_generation call. Applies the same quota and pipeline logic as a new message ' +
          'typed into the chat UI.',
        inputSchema: {
          conversationId: z.string().uuid().describe('The conversationId to reply to.'),
          message: z.string().min(1).max(4000).describe('The follow-up message to send.'),
        },
      },
      async ({ conversationId, message }) =>
        this.continueGeneration(userId, conversationId, message),
    );

    server.registerTool(
      'get_generation_status',
      {
        title: 'Get Generation Status',
        description:
          'Reports the current state of a generation conversation: whether it is paused ' +
          'awaiting a clarifying answer, whether a generated server is available yet, and the ' +
          'most recent messages.',
        inputSchema: {
          conversationId: z.string().uuid().describe('The conversationId to check.'),
        },
      },
      async ({ conversationId }) => this.getGenerationStatus(userId, conversationId),
    );

    server.registerTool(
      'get_generated_server',
      {
        title: 'Get Generated Server',
        description:
          'Fetches the generated code artifacts (main file, supporting files, package.json, ' +
          'documentation, and the tool list) for a completed generation. Returns a "not ready" ' +
          'message if the conversation has no generated server yet.',
        inputSchema: {
          conversationId: z.string().uuid().describe('The conversationId to fetch code for.'),
        },
      },
      async ({ conversationId }) => this.getGeneratedServer(userId, conversationId),
    );

    server.registerTool(
      'list_conversations',
      {
        title: 'List Conversations',
        description: "Lists the authenticated user's generation conversations, most recent first.",
        inputSchema: {},
      },
      async () => this.listConversations(userId),
    );

    server.registerTool(
      'search_marketplace',
      {
        title: 'Search Marketplace',
        description:
          'Searches the public MCP Everything marketplace of previously generated, published ' +
          'MCP servers. Read-only and free of charge - no quota or AI cost involved.',
        inputSchema: {
          query: z
            .string()
            .max(200)
            .optional()
            .describe('Free-text search term (server name/description). Omit to list all.'),
        },
      },
      async ({ query }) => this.searchMarketplace(query),
    );

    server.registerTool(
      'search_tools',
      {
        title: 'Search Hosted Server Tools',
        description:
          'Searches the tools of your own hosted servers, so a single connection can reach all ' +
          "of them. It reads each server's stored tool definitions, which means it still works " +
          'when a server is stopped. Read-only and free of charge, with no quota or AI cost. Use ' +
          'it to find a tool, then run one of the results with call_tool. Note that the free ' +
          'tier hosts a single server.',
        inputSchema: {
          query: z
            .string()
            .max(200)
            .optional()
            .describe(
              'Free-text term matched against tool name, tool description, and server name. ' +
                'Omit to list every tool.',
            ),
          serverId: z
            .string()
            .optional()
            .describe('Restrict the search to a single hosted server by its serverId.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .default(25)
            .describe('Maximum number of tools to return (1-100). Defaults to 25.'),
        },
      },
      async ({ query, serverId, limit }) => this.searchTools(userId, { query, serverId, limit }),
    );

    server.registerTool(
      'call_tool',
      {
        title: 'Call Hosted Server Tool',
        description:
          "Forwards a call to a tool on one of your own hosted servers and returns that tool's " +
          'result. The target server must be running; this does not start it for you. No ' +
          'generation quota or AI cost is involved.',
        inputSchema: {
          serverId: z.string().describe('The serverId of the hosted server to call.'),
          tool: z.string().describe('The name of the tool to run on that server.'),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Arguments object passed through to the tool. Omit if it takes none.'),
        },
      },
      async ({ serverId, tool, arguments: args }) => this.callTool(userId, serverId, tool, args),
    );

    server.registerTool(
      'host_server',
      {
        title: 'Host Generated Server',
        description:
          'Deploys a server you previously generated (identified by its conversationId) onto the ' +
          "platform's cluster, so its tools become reachable through this same connection with " +
          'search_tools / call_tool - no separate endpoint or client needed. The conversation ' +
          'must already contain a completed generated server (run generate_mcp_server first). ' +
          'COST NOTE: this provisions real infrastructure and consumes one slot against your ' +
          "tier's concurrent hosted-server limit (the free tier hosts a single server). Confirm " +
          'with your user before calling it. ' +
          'ASYNC NOTE: it returns as soon as the deployment is accepted, with a status like ' +
          '"pending" or "deploying"; a cold start (fetch source, install, compile, come up) ' +
          'typically takes about a minute. Poll get_hosted_server with the returned serverId ' +
          'until it reports ready before calling its tools. ' +
          'SECRETS: prefer credentialRefs over envVars for anything sensitive - it references a ' +
          "secret already stored in your vault instead of putting the secret's raw value in " +
          'this call.',
        inputSchema: {
          conversationId: z
            .string()
            .uuid()
            .describe('The conversationId whose generated server should be hosted.'),
          envVars: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              'Environment variables to inject into the running container (e.g. an API token ' +
                'the generated server needs). Values are stored as a Kubernetes Secret. Omit if ' +
                'the server needs none.',
            ),
          credentialRefs: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              'Map of environment-variable name to the NAME of one of your stored vault ' +
                'credentials. The secret value is injected server-side at deploy time and never ' +
                'passes through this call. Use this instead of putting raw secrets in envVars.',
            ),
        },
      },
      async ({ conversationId, envVars, credentialRefs }) =>
        this.hostServer(userId, conversationId, envVars, credentialRefs),
    );

    server.registerTool(
      'get_hosted_server',
      {
        title: 'Get Hosted Server Status',
        description:
          'Reports the live deployment status of one of your own hosted servers: whether it is ' +
          'ready to serve requests yet, its real replica counts observed from the cluster, its ' +
          'endpoint, and any failure message. Use it to poll after host_server until the server ' +
          'is ready, then discover and run its tools with search_tools / call_tool. Read-only ' +
          'and free of charge.',
        inputSchema: {
          serverId: z.string().describe('The serverId of the hosted server to check.'),
        },
      },
      async ({ serverId }) => this.getHostedServer(userId, serverId),
    );
  }

  // ---------------------------------------------------------------------------
  // generate_mcp_server
  // ---------------------------------------------------------------------------

  /**
   * Starts a brand new generation conversation for the authenticated user.
   *
   * Uses a freshly generated sessionId - there is no browser session behind an
   * MCP tool call - which `GenerationPipeline.execute` uses to create a new
   * `conversations` row. The same row's `sessionId` column is what
   * `continueGeneration` must reuse (see its docstring) so a follow-up call
   * resolves back to this same conversation instead of silently creating a
   * new one.
   */
  async generateMcpServer(userId: string, description: string): Promise<CallToolResult> {
    const sessionId = randomUUID();
    try {
      const updates = await this.pipeline.execute(sessionId, description, undefined, userId);
      const final = await this.drain(updates);
      return this.formatGenerationResult(final);
    } catch (error) {
      return this.toolError('generate_mcp_server', error);
    }
  }

  // ---------------------------------------------------------------------------
  // continue_generation
  // ---------------------------------------------------------------------------

  /**
   * Sends a follow-up / clarification reply into an existing conversation.
   *
   * `GenerationPipeline.execute`'s conversation lookup is keyed on
   * `(id, sessionId)` together (see `loadOrCreateConversation`), so the
   * original `sessionId` the conversation was created with must be passed
   * back in, not a new one - otherwise the lookup misses and the pipeline
   * silently starts an unrelated conversation. Ownership is checked twice:
   * once here (so an invalid conversationId fails fast with a clean tool
   * error) and again inside the pipeline itself.
   */
  async continueGeneration(
    userId: string,
    conversationId: string,
    message: string,
  ): Promise<CallToolResult> {
    const conversation = await this.findOwnedConversation(conversationId, userId);
    if (!conversation) {
      return this.notFoundError(conversationId);
    }

    try {
      const updates = await this.pipeline.execute(
        conversation.sessionId,
        message,
        conversationId,
        userId,
      );
      const final = await this.drain(updates);
      return this.formatGenerationResult(final);
    } catch (error) {
      return this.toolError('continue_generation', error);
    }
  }

  // ---------------------------------------------------------------------------
  // get_generation_status
  // ---------------------------------------------------------------------------

  async getGenerationStatus(userId: string, conversationId: string): Promise<CallToolResult> {
    const conversation = await this.findOwnedConversation(conversationId, userId);
    if (!conversation) {
      return this.notFoundError(conversationId);
    }

    const awaitingClarification = Boolean(conversation.state?.pipeline?.awaitingClarification);
    const hasGeneratedServer = Boolean(conversation.state?.generatedCode);
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const latestMessages = messages.slice(-5).map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));

    const payload = {
      conversationId,
      // "isGenerating" reflects the durable, DB-persisted pause state rather
      // than an in-process flag: MCP tool calls in this implementation run
      // the pipeline to completion (or to its next pause) synchronously
      // before returning, so by the time a client can call this tool no
      // generation triggered through THIS endpoint is still "in flight" in
      // this process. Cross-session accuracy comes from `state.pipeline`,
      // which survives restarts.
      isGenerating: false,
      awaitingClarification,
      hasGeneratedServer,
      latestMessages,
    };

    return this.textResult(JSON.stringify(payload, null, 2));
  }

  // ---------------------------------------------------------------------------
  // get_generated_server
  // ---------------------------------------------------------------------------

  async getGeneratedServer(userId: string, conversationId: string): Promise<CallToolResult> {
    const conversation = await this.findOwnedConversation(conversationId, userId);
    if (!conversation) {
      return this.notFoundError(conversationId);
    }

    // `state.generatedCode` is the pipeline's own persisted copy (synced by
    // `syncGeneratedCodeToConversation`); the last assistant message's
    // `metadata.generatedCode` is a second, newer copy of the same payload
    // kept so history reloads survive without re-running the pipeline. Either
    // may be present depending on when the conversation last persisted -
    // prefer state, fall back to the message, and only report "not ready" if
    // neither has it.
    const fromState = conversation.state?.generatedCode;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const lastAssistantWithCode = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.metadata?.generatedCode);
    const generatedCode = fromState ?? lastAssistantWithCode?.metadata?.generatedCode;

    if (!generatedCode) {
      return this.textResult(
        `No generated server is available yet for conversation ${conversationId}. ` +
          `Call get_generation_status to check whether it is still awaiting clarification or ` +
          `still in progress.`,
      );
    }

    const payload = {
      conversationId,
      serverName: generatedCode.metadata?.serverName,
      tools: generatedCode.metadata?.tools ?? [],
      mainFile: generatedCode.mainFile,
      packageJson: generatedCode.packageJson,
      tsConfig: generatedCode.tsConfig,
      supportingFiles: generatedCode.supportingFiles ?? {},
      tests: generatedCode.tests,
      documentation: generatedCode.documentation,
    };

    return this.textResult(JSON.stringify(payload, null, 2));
  }

  // ---------------------------------------------------------------------------
  // list_conversations
  // ---------------------------------------------------------------------------

  async listConversations(userId: string): Promise<CallToolResult> {
    const conversations = await this.conversationRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });

    const summaries = conversations.map((conversation) => {
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const firstUserMessage = messages.find((m) => m.role === 'user');
      const title = firstUserMessage ? firstUserMessage.content.slice(0, 80) : 'New conversation';

      return {
        conversationId: conversation.id,
        title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        awaitingClarification: Boolean(conversation.state?.pipeline?.awaitingClarification),
        hasGeneratedServer: Boolean(conversation.state?.generatedCode),
      };
    });

    return this.textResult(JSON.stringify({ conversations: summaries }, null, 2));
  }

  // ---------------------------------------------------------------------------
  // search_marketplace
  // ---------------------------------------------------------------------------

  async searchMarketplace(query?: string): Promise<CallToolResult> {
    try {
      const results = await this.marketplaceService.search({
        query,
        sortBy: SortField.DOWNLOADS,
        sortOrder: SortOrder.DESC,
        page: 1,
        limit: 20,
      });

      return this.textResult(JSON.stringify(results, null, 2));
    } catch (error) {
      return this.toolError('search_marketplace', error);
    }
  }

  // ---------------------------------------------------------------------------
  // search_tools
  // ---------------------------------------------------------------------------

  /**
   * Aggregates the tools of the caller's own hosted servers into one list so a
   * single connection to the platform can discover everything the user hosts.
   *
   * Reads each server's persisted `tools` (the stored tool definitions) rather
   * than querying the live servers, so it is cheap and still returns results
   * for servers that are currently stopped. `getServers(userId)` scopes to the
   * owner, so a `serverId` the caller does not own simply is not in the list
   * and yields an empty result rather than an error.
   */
  async searchTools(
    userId: string,
    options: { query?: string; serverId?: string; limit?: number },
  ): Promise<CallToolResult> {
    const limit = options.limit ?? 25;

    try {
      const servers = await this.hostingService.getServers(userId);

      const scoped = servers.filter(
        (server) =>
          server.status !== 'deleted' &&
          !server.deletedAt &&
          (options.serverId ? server.serverId === options.serverId : true),
      );

      const needle = options.query?.trim().toLowerCase();

      const matches: Array<{
        serverId: string;
        serverName: string;
        serverStatus: string;
        name: string;
        description?: string;
        inputSchema: unknown;
      }> = [];

      for (const server of scoped) {
        const tools = Array.isArray(server.tools) ? server.tools : [];
        for (const tool of tools) {
          if (needle) {
            const haystack = [tool?.name, tool?.description, server.serverName]
              .filter((part): part is string => typeof part === 'string')
              .join('\n')
              .toLowerCase();
            if (!haystack.includes(needle)) {
              continue;
            }
          }

          matches.push({
            serverId: server.serverId,
            serverName: server.serverName,
            serverStatus: server.status,
            name: tool?.name,
            description: tool?.description,
            inputSchema: tool?.inputSchema ?? {},
          });
        }
      }

      const truncated = matches.length > limit;
      const capped = matches.slice(0, limit);
      const serverCount = new Set(capped.map((tool) => tool.serverId)).size;

      const payload = { count: capped.length, tools: capped, truncated };
      const sentence =
        `${capped.length} tool${capped.length === 1 ? '' : 's'} across ` +
        `${serverCount} hosted server${serverCount === 1 ? '' : 's'}.`;

      return this.textResult(`${sentence}\n${JSON.stringify(payload, null, 2)}`);
    } catch (error) {
      return this.toolError('search_tools', error);
    }
  }

  // ---------------------------------------------------------------------------
  // call_tool
  // ---------------------------------------------------------------------------

  /**
   * Forwards a `tools/call` to one of the caller's own hosted servers and
   * returns the hosted server's `CallToolResult` unchanged - including a
   * tool-level `isError: true`, which is a legitimate result and must not be
   * re-wrapped. Ownership/not-found (from `getServer`) and "not running" (a
   * ServiceUnavailableException from the upstream resolver) are routed through
   * `toolError`, so the caller sees a clean tool error rather than a protocol
   * error. This never starts a stopped server.
   */
  async callTool(
    userId: string,
    serverId: string,
    tool: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    try {
      const server = await this.hostingService.getServer(serverId, userId);
      return await this.hostedMcpClientService.callTool(server, tool, args, undefined);
    } catch (error) {
      return this.toolError('call_tool', error);
    }
  }

  // ---------------------------------------------------------------------------
  // host_server
  // ---------------------------------------------------------------------------

  /**
   * Deploys the server generated in `conversationId` onto the cluster via the
   * exact same entry point the "Host on Cloud" button uses
   * (`HostingService.deployToCloud`), so ownership scoping, the per-tier
   * concurrent-server cap, and source-token minting all apply identically to
   * an agent driving this over MCP.
   *
   * `deployToCloud` reports two distinct kinds of failure differently, and
   * both must reach the agent as a tool error rather than a cheerful success:
   * ownership / "no generated server" / quota are THROWN (and caught here),
   * while a deploy that was accepted but could not be realized comes back as a
   * resolved `{ success: false }` result. The latter is surfaced with
   * `isError: true` so an agent does not mistake a failed deploy for a hosted
   * server it can immediately call.
   */
  async hostServer(
    userId: string,
    conversationId: string,
    envVars: Record<string, string> | undefined,
    credentialRefs?: Record<string, string>,
  ): Promise<CallToolResult> {
    try {
      const result = await this.hostingService.deployToCloud(
        conversationId,
        userId,
        envVars,
        credentialRefs,
      );

      const lines: string[] = [
        `serverId: ${result.serverId}`,
        `status: ${result.status}`,
        `endpointUrl: ${result.endpointUrl}`,
      ];
      if (result.error) {
        lines.push(`error: ${result.error}`);
      }

      if (!result.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: lines.join('\n') }],
        };
      }

      lines.push(
        'The server was accepted and is deploying; a cold start (fetch source, install, ' +
          'compile, come up) typically takes about a minute. Poll get_hosted_server with this ' +
          'serverId until it reports ready, then use search_tools / call_tool to discover and ' +
          'invoke its tools through this same connection.',
      );
      return this.textResult(lines.join('\n'));
    } catch (error) {
      return this.toolError('host_server', error);
    }
  }

  // ---------------------------------------------------------------------------
  // get_hosted_server
  // ---------------------------------------------------------------------------

  /**
   * Reports the live, cluster-observed status of one hosted server so an agent
   * can poll for readiness after host_server. Readiness is taken from the real
   * `observedReadyReplicas` written back by K8sReconcilerService, not the
   * derived `status` string - a pod can be `status: 'running'` while still
   * reporting 0 ready replicas mid cold-start. `getServer` scopes to the owner
   * and throws NotFound for an id the caller does not own, which `toolError`
   * turns into a clean tool error.
   */
  async getHostedServer(userId: string, serverId: string): Promise<CallToolResult> {
    try {
      const server = await this.hostingService.getServer(serverId, userId);

      const readyReplicas = server.observedReadyReplicas ?? 0;
      const ready = readyReplicas >= 1;

      const payload = {
        serverId: server.serverId,
        serverName: server.serverName,
        endpointUrl: server.endpointUrl,
        // The honest desired-vs-observed split (see the HostedServer entity):
        // `status` is a derived mirror kept for the UI; these are the source.
        desiredState: server.desiredState,
        observedStatus: server.observedStatus,
        status: server.status,
        ready,
        replicas: server.observedReplicas ?? 0,
        readyReplicas,
        message: server.observedMessage || server.statusMessage || '',
        observedAt: server.observedAt,
        toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
      };

      const hint = ready
        ? 'This server is running. Use search_tools / call_tool to discover and invoke its ' +
          'tools through this connection.'
        : server.desiredState !== 'running'
          ? `This server's desired state is "${server.desiredState}", so it is not serving ` +
            'requests. Nothing is wrong; it will not become ready until it is started.'
          : 'This server is not ready yet. Poll this tool again in a few seconds - a cold ' +
            'start typically takes about a minute.';

      return this.textResult(`${hint}\n${JSON.stringify(payload, null, 2)}`);
    } catch (error) {
      return this.toolError('get_hosted_server', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /**
   * Loads a conversation scoped to its owner. Returns null both when the
   * conversation does not exist and when it belongs to another user, so
   * callers never leak existence of another user's conversation.
   */
  private async findOwnedConversation(
    conversationId: string,
    userId: string,
  ): Promise<Conversation | null> {
    return this.conversationRepo.findOne({ where: { id: conversationId, userId } });
  }

  /** Drains a pipeline update stream to its final (most recent) update. */
  private async drain(updates: AsyncGenerator<PipelineUpdate>): Promise<PipelineUpdate> {
    let last: PipelineUpdate | undefined;
    for await (const update of updates) {
      last = update;
    }
    if (!last) {
      throw new Error('Pipeline produced no updates');
    }
    return last;
  }

  /** Renders a pipeline update as the MCP tool's textual result. */
  private formatGenerationResult(update: PipelineUpdate): CallToolResult {
    const lines: string[] = [`conversationId: ${update.conversationId}`];

    if (update.needsUserInput && update.clarificationNeeded) {
      lines.push('status: awaiting_clarification');
      lines.push(`question: ${update.clarificationNeeded.question}`);
      if (update.clarificationNeeded.options?.length) {
        lines.push(`options: ${update.clarificationNeeded.options.join(', ')}`);
      }
    } else if (update.generatedCode) {
      lines.push('status: complete');
      lines.push(`serverName: ${update.generatedCode.metadata?.serverName ?? 'unknown'}`);
      const toolNames = (update.generatedCode.metadata?.tools ?? []).map((t) => t.name);
      lines.push(`tools: ${toolNames.join(', ') || '(none)'}`);
      if (update.response) {
        lines.push(`message: ${update.response}`);
      }
      lines.push('Call get_generated_server with this conversationId to fetch the code.');
    } else {
      lines.push(`status: ${update.isComplete ? 'complete' : 'in_progress'}`);
      if (update.response) {
        lines.push(`message: ${update.response}`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  private textResult(text: string): CallToolResult {
    return { content: [{ type: 'text', text }] };
  }

  private notFoundError(conversationId: string): CallToolResult {
    return {
      isError: true,
      content: [{ type: 'text', text: `Conversation not found: ${conversationId}` }],
    };
  }

  /**
   * Turns a thrown error into an MCP tool error result instead of letting it
   * propagate as an uncaught exception (which the transport would otherwise
   * turn into an opaque JSON-RPC -32603 rather than a tool-level error the
   * calling agent can act on).
   */
  private toolError(toolName: string, error: unknown): CallToolResult {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Tool ${toolName} failed: ${message}`);
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
    };
  }
}
