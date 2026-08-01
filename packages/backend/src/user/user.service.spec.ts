/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { User } from '../database/entities/user.entity';
import { UsageRecord } from '../database/entities/usage.entity';

describe('UserService - GitHub token storage', () => {
  let service: UserService;
  let mockUserRepository: any;
  let mockUsageRepository: any;
  let queryBuilderMock: any;

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
    };
    mockUsageRepository = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(UsageRecord), useValue: mockUsageRepository },
      ],
    }).compile();

    service = module.get(UserService);
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
