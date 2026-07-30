/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { McpServerController } from './mcp-server.controller';
import { McpToolsService } from './mcp-tools.service';
import { User } from '../database/entities/user.entity';

describe('McpServerController', () => {
  let controller: McpServerController;

  const mockToolsService = {
    registerTools: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpServerController],
      providers: [{ provide: McpToolsService, useValue: mockToolsService }],
    }).compile();

    controller = module.get<McpServerController>(McpServerController);
    jest.clearAllMocks();
  });

  it('is defined', () => {
    expect(controller).toBeDefined();
  });

  describe('handleGet', () => {
    it('responds 405 with a JSON-RPC error - stateless transport has no session to resume', () => {
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      controller.handleGet(res);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          error: expect.objectContaining({ code: -32000 }),
          id: null,
        }),
      );
    });
  });

  describe('handleDelete', () => {
    it('responds 405 with a JSON-RPC error - stateless transport has no session to terminate', () => {
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      controller.handleDelete(res);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          error: expect.objectContaining({ code: -32000 }),
          id: null,
        }),
      );
    });
  });

  describe('handlePost', () => {
    it('builds a per-request McpServer bound to the authenticated user and registers tools on it', async () => {
      const user = { id: 'user-123' } as User;
      const req: any = { body: { jsonrpc: '2.0', method: 'tools/list', id: 1 }, on: jest.fn() };
      const res: any = {
        headersSent: false,
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        on: jest.fn(),
        setHeader: jest.fn(),
        writeHead: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };

      await controller.handlePost(user, req, res);

      expect(mockToolsService.registerTools).toHaveBeenCalledTimes(1);
      expect(mockToolsService.registerTools).toHaveBeenCalledWith(expect.anything(), 'user-123');
    });
  });
});
