/// <reference types="jest" />
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { McpToolsService } from './mcp-tools.service';
import { Conversation } from '../database/entities';
import { GenerationPipeline } from '../orchestration/pipeline.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { HostingService } from '../hosting/hosting.service';
import { HostedMcpClientService } from '../hosting/services/hosted-mcp-client.service';

describe('McpToolsService', () => {
  let service: McpToolsService;
  let conversationRepo: any;
  let pipeline: jest.Mocked<Pick<GenerationPipeline, 'execute'>>;
  let marketplaceService: jest.Mocked<Pick<MarketplaceService, 'search'>>;
  let hostingService: jest.Mocked<Pick<HostingService, 'getServers' | 'getServer'>>;
  let hostedMcpClientService: jest.Mocked<Pick<HostedMcpClientService, 'callTool'>>;

  const userId = 'user-123';
  const otherUserId = 'user-456';
  const conversationId = 'conv-abc';

  /** Builds a one-shot async generator yielding a single PipelineUpdate. */
  async function* singleUpdate(update: any) {
    yield update;
  }

  beforeEach(async () => {
    conversationRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    pipeline = {
      execute: jest.fn(),
    };

    marketplaceService = {
      search: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
        hasNext: false,
        hasPrevious: false,
      }),
    };

    hostingService = {
      getServers: jest.fn().mockResolvedValue([]),
      getServer: jest.fn(),
    };

    hostedMcpClientService = {
      callTool: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpToolsService,
        { provide: getRepositoryToken(Conversation), useValue: conversationRepo },
        { provide: GenerationPipeline, useValue: pipeline },
        { provide: MarketplaceService, useValue: marketplaceService },
        { provide: HostingService, useValue: hostingService },
        { provide: HostedMcpClientService, useValue: hostedMcpClientService },
      ],
    }).compile();

    service = module.get<McpToolsService>(McpToolsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('generateMcpServer', () => {
    it('starts a new conversation and reports a clarification question', async () => {
      pipeline.execute.mockResolvedValue(
        singleUpdate({
          conversationId,
          needsUserInput: true,
          clarificationNeeded: { question: 'Which repo?', context: 'missing_target' },
          isComplete: true,
        }),
      );

      const result = await service.generateMcpServer(userId, 'a server for my api');

      expect(pipeline.execute).toHaveBeenCalledWith(
        expect.any(String),
        'a server for my api',
        undefined,
        userId,
      );
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as any).text as string;
      expect(text).toContain(conversationId);
      expect(text).toContain('awaiting_clarification');
      expect(text).toContain('Which repo?');
    });

    it('reports completion with the tool list when generation finishes', async () => {
      pipeline.execute.mockResolvedValue(
        singleUpdate({
          conversationId,
          needsUserInput: false,
          isComplete: true,
          generatedCode: {
            mainFile: 'code',
            supportingFiles: {},
            metadata: {
              serverName: 'stripe-mcp',
              tools: [{ name: 'list_invoices' }],
              iteration: 1,
            },
          },
        }),
      );

      const result = await service.generateMcpServer(userId, 'stripe read-only server');

      const text = (result.content[0] as any).text as string;
      expect(text).toContain('status: complete');
      expect(text).toContain('stripe-mcp');
      expect(text).toContain('list_invoices');
    });

    it('turns a thrown pipeline error into an MCP tool error instead of throwing', async () => {
      pipeline.execute.mockRejectedValue(new Error('quota exceeded'));

      const result = await service.generateMcpServer(userId, 'anything');

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('quota exceeded');
    });
  });

  describe('continueGeneration', () => {
    it('rejects a conversation the user does not own with a clean tool error, never a throw', async () => {
      conversationRepo.findOne.mockResolvedValue(null);

      const result = await service.continueGeneration(otherUserId, conversationId, 'reply');

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('not found');
      expect(pipeline.execute).not.toHaveBeenCalled();
    });

    it('reuses the conversation`s original sessionId so the pipeline resolves the same row', async () => {
      conversationRepo.findOne.mockResolvedValue({
        id: conversationId,
        userId,
        sessionId: 'original-session-id',
      });
      pipeline.execute.mockResolvedValue(
        singleUpdate({ conversationId, needsUserInput: false, isComplete: true, response: 'ok' }),
      );

      await service.continueGeneration(userId, conversationId, 'my answer');

      expect(pipeline.execute).toHaveBeenCalledWith(
        'original-session-id',
        'my answer',
        conversationId,
        userId,
      );
    });
  });

  describe('getGenerationStatus', () => {
    it('reports not found for another user`s conversation', async () => {
      conversationRepo.findOne.mockResolvedValue(null);

      const result = await service.getGenerationStatus(otherUserId, conversationId);

      expect(result.isError).toBe(true);
    });

    it('reports awaitingClarification and the latest messages', async () => {
      conversationRepo.findOne.mockResolvedValue({
        id: conversationId,
        userId,
        state: { pipeline: { awaitingClarification: true } },
        messages: [
          { role: 'user', content: 'hi', timestamp: new Date() },
          { role: 'assistant', content: 'which repo?', timestamp: new Date() },
        ],
      });

      const result = await service.getGenerationStatus(userId, conversationId);
      const payload = JSON.parse((result.content[0] as any).text);

      expect(payload.awaitingClarification).toBe(true);
      expect(payload.hasGeneratedServer).toBe(false);
      expect(payload.latestMessages).toHaveLength(2);
    });
  });

  describe('getGeneratedServer', () => {
    it('reports not ready when there is no generated code yet', async () => {
      conversationRepo.findOne.mockResolvedValue({
        id: conversationId,
        userId,
        state: {},
        messages: [],
      });

      const result = await service.getGeneratedServer(userId, conversationId);

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as any).text).toContain('No generated server is available yet');
    });

    it('returns the generated code from conversation state when present', async () => {
      conversationRepo.findOne.mockResolvedValue({
        id: conversationId,
        userId,
        state: {
          generatedCode: {
            mainFile: 'export default {}',
            supportingFiles: { 'README.md': 'docs' },
            metadata: { serverName: 'my-server', tools: [{ name: 'a_tool' }] },
          },
        },
        messages: [],
      });

      const result = await service.getGeneratedServer(userId, conversationId);
      const payload = JSON.parse((result.content[0] as any).text);

      expect(payload.serverName).toBe('my-server');
      expect(payload.mainFile).toBe('export default {}');
      expect(payload.supportingFiles).toEqual({ 'README.md': 'docs' });
    });

    it('falls back to the last assistant message`s metadata when state has none', async () => {
      conversationRepo.findOne.mockResolvedValue({
        id: conversationId,
        userId,
        state: {},
        messages: [
          { role: 'user', content: 'hi', timestamp: new Date() },
          {
            role: 'assistant',
            content: 'done',
            timestamp: new Date(),
            metadata: {
              generatedCode: {
                mainFile: 'from message metadata',
                supportingFiles: {},
                metadata: { serverName: 'msg-server', tools: [] },
              },
            },
          },
        ],
      });

      const result = await service.getGeneratedServer(userId, conversationId);
      const payload = JSON.parse((result.content[0] as any).text);

      expect(payload.serverName).toBe('msg-server');
      expect(payload.mainFile).toBe('from message metadata');
    });
  });

  describe('listConversations', () => {
    it('scopes the query to the authenticated user and summarizes each conversation', async () => {
      conversationRepo.find.mockResolvedValue([
        {
          id: 'c1',
          createdAt: new Date(),
          updatedAt: new Date(),
          state: {},
          messages: [{ role: 'user', content: 'build me a server', timestamp: new Date() }],
        },
      ]);

      const result = await service.listConversations(userId);

      expect(conversationRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId } }),
      );
      const payload = JSON.parse((result.content[0] as any).text);
      expect(payload.conversations).toHaveLength(1);
      expect(payload.conversations[0].title).toContain('build me a server');
    });
  });

  describe('searchMarketplace', () => {
    it('delegates to MarketplaceService.search with the query', async () => {
      await service.searchMarketplace('stripe');

      expect(marketplaceService.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'stripe', page: 1, limit: 20 }),
      );
    });

    it('turns a search failure into a tool error', async () => {
      marketplaceService.search.mockRejectedValue(new Error('db down'));

      const result = await service.searchMarketplace();

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('db down');
    });
  });

  describe('searchTools', () => {
    /** Parses the JSON payload out of the prose+JSON text result. */
    function parsePayload(result: any) {
      const text = (result.content[0] as any).text as string;
      return JSON.parse(text.slice(text.indexOf('{')));
    }

    const runningServer = {
      serverId: 'srv-running',
      serverName: 'Weather API',
      status: 'running',
      deletedAt: null,
      tools: [
        {
          name: 'get_forecast',
          description: 'Returns a weather forecast',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
        },
        { name: 'list_stations', description: 'Lists stations', inputSchema: {} },
      ],
    };

    const stoppedServer = {
      serverId: 'srv-stopped',
      serverName: 'Billing Tools',
      status: 'stopped',
      deletedAt: null,
      tools: [
        { name: 'create_invoice', description: 'Creates an invoice', inputSchema: {} },
      ],
    };

    it('flattens tools across all of the user`s hosted servers', async () => {
      hostingService.getServers.mockResolvedValue([runningServer, stoppedServer] as any);

      const result = await service.searchTools(userId, {});

      expect(hostingService.getServers).toHaveBeenCalledWith(userId);
      const payload = parsePayload(result);
      expect(payload.count).toBe(3);
      expect(payload.truncated).toBe(false);
      expect(payload.tools.map((t: any) => t.name)).toEqual([
        'get_forecast',
        'list_stations',
        'create_invoice',
      ]);
      // Each flattened entry carries its owning server's identity + status.
      expect(payload.tools[0]).toMatchObject({
        serverId: 'srv-running',
        serverName: 'Weather API',
        serverStatus: 'running',
        name: 'get_forecast',
      });
      const text = (result.content[0] as any).text as string;
      expect(text).toContain('3 tools across 2 hosted servers.');
    });

    it('surfaces a stopped server`s tools with its status', async () => {
      hostingService.getServers.mockResolvedValue([stoppedServer] as any);

      const payload = parsePayload(await service.searchTools(userId, {}));

      expect(payload.count).toBe(1);
      expect(payload.tools[0]).toMatchObject({
        serverStatus: 'stopped',
        name: 'create_invoice',
      });
    });

    it('filters by tool name', async () => {
      hostingService.getServers.mockResolvedValue([runningServer, stoppedServer] as any);

      const payload = parsePayload(await service.searchTools(userId, { query: 'forecast' }));

      expect(payload.count).toBe(1);
      expect(payload.tools[0].name).toBe('get_forecast');
    });

    it('filters by tool description', async () => {
      hostingService.getServers.mockResolvedValue([runningServer, stoppedServer] as any);

      const payload = parsePayload(await service.searchTools(userId, { query: 'invoice' }));

      expect(payload.count).toBe(1);
      expect(payload.tools[0].name).toBe('create_invoice');
    });

    it('filters by server name', async () => {
      hostingService.getServers.mockResolvedValue([runningServer, stoppedServer] as any);

      const payload = parsePayload(await service.searchTools(userId, { query: 'weather' }));

      expect(payload.count).toBe(2);
      expect(payload.tools.every((t: any) => t.serverName === 'Weather API')).toBe(true);
    });

    it('restricts to a single server by serverId', async () => {
      hostingService.getServers.mockResolvedValue([runningServer, stoppedServer] as any);

      const payload = parsePayload(
        await service.searchTools(userId, { serverId: 'srv-stopped' }),
      );

      expect(payload.count).toBe(1);
      expect(payload.tools[0].serverId).toBe('srv-stopped');
    });

    it('returns an empty result when serverId is not in the user`s list', async () => {
      hostingService.getServers.mockResolvedValue([runningServer] as any);

      const result = await service.searchTools(userId, { serverId: 'srv-not-owned' });

      expect(result.isError).toBeFalsy();
      const payload = parsePayload(result);
      expect(payload.count).toBe(0);
      expect(payload.tools).toEqual([]);
    });

    it('caps results at limit and marks the payload truncated', async () => {
      hostingService.getServers.mockResolvedValue([runningServer, stoppedServer] as any);

      const payload = parsePayload(await service.searchTools(userId, { limit: 2 }));

      expect(payload.count).toBe(2);
      expect(payload.truncated).toBe(true);
    });

    it('returns an empty result when the user hosts no servers', async () => {
      hostingService.getServers.mockResolvedValue([]);

      const result = await service.searchTools(userId, {});

      expect(hostingService.getServers).toHaveBeenCalledWith(userId);
      const payload = parsePayload(result);
      expect(payload.count).toBe(0);
      expect(payload.truncated).toBe(false);
    });

    it('excludes deleted servers even if getServers returned them', async () => {
      hostingService.getServers.mockResolvedValue([
        { ...runningServer, status: 'deleted', deletedAt: new Date() },
      ] as any);

      const payload = parsePayload(await service.searchTools(userId, {}));

      expect(payload.count).toBe(0);
    });
  });

  describe('callTool', () => {
    const hostedServer = { serverId: 'srv-1', serverName: 'S1', status: 'running' };

    it('forwards to the hosted client and returns its result verbatim', async () => {
      hostingService.getServer.mockResolvedValue(hostedServer as any);
      const upstream = { content: [{ type: 'text', text: 'hello from tool' }] };
      hostedMcpClientService.callTool.mockResolvedValue(upstream as any);

      const result = await service.callTool(userId, 'srv-1', 'do_thing', { a: 1 });

      expect(hostingService.getServer).toHaveBeenCalledWith('srv-1', userId);
      expect(hostedMcpClientService.callTool).toHaveBeenCalledWith(
        hostedServer,
        'do_thing',
        { a: 1 },
        undefined,
      );
      expect(result).toBe(upstream);
    });

    it('passes a hosted isError:true result through unchanged (no double wrap)', async () => {
      hostingService.getServer.mockResolvedValue(hostedServer as any);
      const upstream = {
        isError: true,
        content: [{ type: 'text', text: 'tool said no' }],
      };
      hostedMcpClientService.callTool.mockResolvedValue(upstream as any);

      const result = await service.callTool(userId, 'srv-1', 'do_thing', undefined);

      expect(result).toBe(upstream);
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toBe('tool said no');
    });

    it('turns a NotFound (not owned/missing) into a clean tool error', async () => {
      hostingService.getServer.mockRejectedValue(
        new NotFoundException('Server not found: srv-x'),
      );

      const result = await service.callTool(userId, 'srv-x', 'do_thing', undefined);

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('Server not found');
      expect(hostedMcpClientService.callTool).not.toHaveBeenCalled();
    });

    it('turns a ServiceUnavailable (not running) into a clean tool error', async () => {
      hostingService.getServer.mockResolvedValue(hostedServer as any);
      hostedMcpClientService.callTool.mockRejectedValue(
        new ServiceUnavailableException(
          "Hosted server 'srv-1' is not running (status: stopped). Start it first.",
        ),
      );

      const result = await service.callTool(userId, 'srv-1', 'do_thing', undefined);

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('not running');
    });

    it('always scopes getServer to the authenticated user', async () => {
      hostingService.getServer.mockResolvedValue(hostedServer as any);
      hostedMcpClientService.callTool.mockResolvedValue({ content: [] } as any);

      await service.callTool(userId, 'srv-1', 'do_thing', undefined);

      expect(hostingService.getServer).toHaveBeenCalledWith('srv-1', userId);
    });
  });
});
