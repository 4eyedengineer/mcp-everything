/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MyServersService } from './my-servers.service';
import { Conversation } from '../database/entities/conversation.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { HostedServer } from '../database/entities/hosted-server.entity';

describe('MyServersService', () => {
  let service: MyServersService;
  let mockConversationRepository: any;
  let mockDeploymentRepository: any;
  let mockHostedServerRepository: any;

  const userId = 'user-123';

  const makeDeploymentQueryBuilder = (deployments: Partial<Deployment>[]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(deployments),
  });

  const makeHostedQueryBuilder = (servers: Partial<HostedServer>[]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(servers),
  });

  const baseConversation = (overrides: Partial<Conversation> = {}): Conversation =>
    ({
      id: 'conv-1',
      userId,
      messages: [],
      state: {},
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      ...overrides,
    }) as Conversation;

  const generatedCodeFixture = {
    mainFile: 'export const x = 1;',
    supportingFiles: {},
    metadata: {
      serverName: 'Express.js API',
      tools: [{ name: 'get_users' }, { name: 'create_user' }],
      iteration: 1,
    },
  };

  beforeEach(async () => {
    mockConversationRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    mockDeploymentRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(makeDeploymentQueryBuilder([])),
    };
    mockHostedServerRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(makeHostedQueryBuilder([])),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MyServersService,
        { provide: getRepositoryToken(Conversation), useValue: mockConversationRepository },
        { provide: getRepositoryToken(Deployment), useValue: mockDeploymentRepository },
        { provide: getRepositoryToken(HostedServer), useValue: mockHostedServerRepository },
      ],
    }).compile();

    service = module.get<MyServersService>(MyServersService);
  });

  it('returns an empty list when the user has no conversations', async () => {
    const result = await service.getMyServers(userId);
    expect(result).toEqual([]);
  });

  it('skips conversations with no generated code', async () => {
    mockConversationRepository.find.mockResolvedValue([baseConversation()]);
    const result = await service.getMyServers(userId);
    expect(result).toEqual([]);
  });

  it('reports status "generated" from conversation.state.generatedCode', async () => {
    mockConversationRepository.find.mockResolvedValue([
      baseConversation({ state: { generatedCode: generatedCodeFixture } }),
    ]);

    const result = await service.getMyServers(userId);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      conversationId: 'conv-1',
      serverName: 'Express.js API',
      toolCount: 2,
      status: 'generated',
    });
    expect(result[0].deployment).toBeUndefined();
    expect(result[0].hosted).toBeUndefined();
  });

  it('falls back to the last assistant message metadata.generatedCode when state has none', async () => {
    mockConversationRepository.find.mockResolvedValue([
      baseConversation({
        state: {},
        messages: [
          { role: 'user', content: 'build me a server', timestamp: new Date() },
          {
            role: 'assistant',
            content: 'done',
            timestamp: new Date(),
            metadata: { generatedCode: generatedCodeFixture },
          },
        ] as Conversation['messages'],
      }),
    ]);

    const result = await service.getMyServers(userId);

    expect(result).toHaveLength(1);
    expect(result[0].serverName).toBe('Express.js API');
    expect(result[0].status).toBe('generated');
  });

  it('escalates status to "deployed" when a successful deployment row exists', async () => {
    mockConversationRepository.find.mockResolvedValue([
      baseConversation({ state: { generatedCode: generatedCodeFixture } }),
    ]);
    mockDeploymentRepository.createQueryBuilder.mockReturnValue(
      makeDeploymentQueryBuilder([
        {
          conversationId: 'conv-1',
          deploymentType: 'repo',
          repositoryUrl: 'https://github.com/user/repo',
          status: 'success',
          deployedAt: new Date('2026-07-02T00:00:00.000Z'),
        } as Deployment,
      ]),
    );

    const result = await service.getMyServers(userId);

    expect(result[0].status).toBe('deployed');
    expect(result[0].deployment).toEqual({
      type: 'repo',
      url: 'https://github.com/user/repo',
      deployedAt: new Date('2026-07-02T00:00:00.000Z'),
    });
  });

  it('does not escalate to "deployed" when the only deployment row failed', async () => {
    mockConversationRepository.find.mockResolvedValue([
      baseConversation({ state: { generatedCode: generatedCodeFixture } }),
    ]);
    mockDeploymentRepository.createQueryBuilder.mockReturnValue(
      makeDeploymentQueryBuilder([
        { conversationId: 'conv-1', deploymentType: 'gist', status: 'failed' } as Deployment,
      ]),
    );

    const result = await service.getMyServers(userId);

    expect(result[0].status).toBe('generated');
    expect(result[0].deployment).toBeUndefined();
  });

  it('escalates status to "hosted" when a hosted server row exists, even without a deployment row', async () => {
    mockConversationRepository.find.mockResolvedValue([
      baseConversation({ state: { generatedCode: generatedCodeFixture } }),
    ]);
    mockHostedServerRepository.createQueryBuilder.mockReturnValue(
      makeHostedQueryBuilder([
        {
          conversationId: 'conv-1',
          serverId: 'express-js-abc123',
          endpointUrl: 'https://express-js-abc123.mcp.example.com',
          status: 'running',
        } as HostedServer,
      ]),
    );

    const result = await service.getMyServers(userId);

    expect(result[0].status).toBe('hosted');
    expect(result[0].hosted).toEqual({
      serverId: 'express-js-abc123',
      endpointUrl: 'https://express-js-abc123.mcp.example.com',
      status: 'running',
    });
  });

  it('scopes queries to the requesting user only', async () => {
    mockConversationRepository.find.mockResolvedValue([
      baseConversation({ state: { generatedCode: generatedCodeFixture } }),
    ]);

    await service.getMyServers(userId);

    expect(mockConversationRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId } }),
    );
  });
});
