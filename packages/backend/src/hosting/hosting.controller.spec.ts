import { Test, TestingModule } from '@nestjs/testing';
import { HostingController } from './hosting.controller';
import { HostingService } from './hosting.service';
import { User } from '../database/entities/user.entity';

describe('HostingController', () => {
  let controller: HostingController;
  let hostingService: { deployToCloud: jest.Mock };

  const user = { id: 'user-1' } as User;

  beforeEach(async () => {
    hostingService = { deployToCloud: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HostingController],
      providers: [{ provide: HostingService, useValue: hostingService }],
    }).compile();

    controller = module.get<HostingController>(HostingController);
  });

  describe('deployServer', () => {
    it('passes dto.envVars through to hostingService.deployToCloud (previously silently dropped)', async () => {
      hostingService.deployToCloud.mockResolvedValue({
        success: true,
        serverId: 'srv-1',
        endpointUrl: 'docker-exec://mcp-hosted-srv-1',
        status: 'running',
      });

      await controller.deployServer(user, 'conv-1', {
        envVars: { GITHUB_TOKEN: 'abc123' },
      });

      expect(hostingService.deployToCloud).toHaveBeenCalledWith('conv-1', 'user-1', {
        GITHUB_TOKEN: 'abc123',
      });
    });

    it('works with no envVars supplied', async () => {
      hostingService.deployToCloud.mockResolvedValue({
        success: true,
        serverId: 'srv-1',
        endpointUrl: 'https://srv-1.mcp.example.com',
        status: 'running',
      });

      await controller.deployServer(user, 'conv-1', {});

      expect(hostingService.deployToCloud).toHaveBeenCalledWith('conv-1', 'user-1', undefined);
    });
  });
});
