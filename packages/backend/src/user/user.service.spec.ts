/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException } from '@nestjs/common';
import { UserService } from './user.service';
import { User } from '../database/entities/user.entity';
import { UsageRecord } from '../database/entities/usage.entity';
import { HostedServer } from '../database/entities/hosted-server.entity';

describe('UserService - GitHub token storage', () => {
  let service: UserService;
  let mockUserRepository: any;
  let mockUsageRepository: any;
  let mockHostedServerRepository: any;
  let queryBuilderMock: any;
  let hostedServerQueryBuilderMock: any;

  beforeEach(async () => {
    queryBuilderMock = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };

    mockUserRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilderMock),
      findOne: jest.fn().mockResolvedValue(null),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    mockUsageRepository = {};

    hostedServerQueryBuilderMock = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    mockHostedServerRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(hostedServerQueryBuilderMock),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(UsageRecord), useValue: mockUsageRepository },
        { provide: getRepositoryToken(HostedServer), useValue: mockHostedServerRepository },
      ],
    }).compile();

    service = module.get(UserService);
  });

  /**
   * `hosted_servers.user_id` had an index but no foreign key, so deleting an
   * account left rows pointing at a user that no longer existed - invisible to
   * every user-scoped query while their containers/pods kept running. The
   * constraint is now ON DELETE RESTRICT (see
   * 1754100000002-AddHostedServerUserForeignKey.ts), which makes the silent
   * orphan impossible; these tests cover the application half that turns the
   * constraint into an actionable error rather than a 500.
   */
  describe('deleteUser', () => {
    beforeEach(() => {
      mockUserRepository.findOne.mockResolvedValue({ id: 'user-1', email: 'a@b.c' });
    });

    it('refuses to delete an account that still owns live hosted servers', async () => {
      hostedServerQueryBuilderMock.getMany.mockResolvedValue([
        { serverId: 'stripe-abc123' },
        { serverId: 'github-def456' },
      ]);

      await expect(service.deleteUser('user-1')).rejects.toThrow(ConflictException);
      await expect(service.deleteUser('user-1')).rejects.toThrow(/stripe-abc123/);
      expect(mockUserRepository.remove).not.toHaveBeenCalled();
    });

    it('excludes already soft-deleted servers from the check', async () => {
      await service.deleteUser('user-1');

      expect(hostedServerQueryBuilderMock.andWhere).toHaveBeenCalledWith(
        'server.status != :deleted',
        { deleted: 'deleted' },
      );
    });

    it('releases the RESTRICT foreign key held by soft-deleted servers, then deletes', async () => {
      await service.deleteUser('user-1');

      expect(mockHostedServerRepository.update).toHaveBeenCalledWith(
        { userId: 'user-1' },
        { userId: null },
      );
      expect(mockUserRepository.remove).toHaveBeenCalled();
    });
  });

  describe('findByIdWithGithubToken', () => {
    it('explicitly opts in to the select:false token column via addSelect', async () => {
      queryBuilderMock.getOne.mockResolvedValue({
        id: 'user-1',
        githubAccessTokenEncrypted: 'enc(token)',
      });

      const result = await service.findByIdWithGithubToken('user-1');

      expect(mockUserRepository.createQueryBuilder).toHaveBeenCalledWith('user');
      expect(queryBuilderMock.addSelect).toHaveBeenCalledWith('user.githubAccessTokenEncrypted');
      expect(queryBuilderMock.where).toHaveBeenCalledWith('user.id = :id', { id: 'user-1' });
      expect(result?.githubAccessTokenEncrypted).toBe('enc(token)');
    });
  });

  describe('setGithubToken', () => {
    it('persists the encrypted token, scope, and a fresh updatedAt', async () => {
      await service.setGithubToken('user-1', 'enc(token)', 'public_repo');

      expect(mockUserRepository.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          githubAccessTokenEncrypted: 'enc(token)',
          githubTokenScope: 'public_repo',
          githubTokenUpdatedAt: expect.any(Date),
        }),
      );
    });
  });

  describe('clearGithubToken', () => {
    it('sends explicit null (never undefined) for every GitHub token column', async () => {
      // Regression test: TypeORM's Repository#update() OMITS properties
      // whose value is `undefined` from the generated SQL - it does NOT set
      // the column to NULL. An earlier version of this method passed
      // `undefined`, which meant "disconnect" silently left the encrypted
      // token in the database despite reporting success. Only `null`
      // actually clears the column.
      await service.clearGithubToken('user-1');

      expect(mockUserRepository.update).toHaveBeenCalledTimes(1);
      const [calledUserId, calledPayload] = mockUserRepository.update.mock.calls[0];

      expect(calledUserId).toBe('user-1');
      expect(calledPayload.githubAccessTokenEncrypted).toBeNull();
      expect(calledPayload.githubTokenScope).toBeNull();
      expect(calledPayload.githubTokenUpdatedAt).toBeNull();

      // Explicitly assert none of them are `undefined` - the exact failure
      // mode being regression-tested.
      expect(calledPayload.githubAccessTokenEncrypted).not.toBeUndefined();
      expect(calledPayload.githubTokenScope).not.toBeUndefined();
      expect(calledPayload.githubTokenUpdatedAt).not.toBeUndefined();
    });
  });
});
