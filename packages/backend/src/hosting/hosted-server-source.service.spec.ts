import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedServerSourceService } from './hosted-server-source.service';
import { SourceArchiveService } from './services/source-archive.service';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { Conversation } from '../database/entities/conversation.entity';

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const GENERATED_CODE = {
  mainFile: 'console.log("mcp");\n',
  packageJson: '{"name":"demo-mcp","version":"1.0.0"}',
  tsConfig: '{"compilerOptions":{"strict":true}}',
  supportingFiles: {
    Dockerfile: 'FROM node:20-alpine\n',
    '.dockerignore': 'node_modules\n',
    'src/lib/client.ts': 'export const client = {};\n',
  },
};

describe('HostedServerSourceService', () => {
  let service: HostedServerSourceService;
  let hostedServerRepo: { findOne: jest.Mock };
  let conversationRepo: { findOne: jest.Mock };
  let configValues: Record<string, unknown>;

  const RUNNING_SERVER = {
    id: 'hosted-uuid-1',
    serverId: 'demo-mcp-abcd1234',
    status: 'running',
    conversationId: 'conv-1',
  };

  async function build(): Promise<HostedServerSourceService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HostedServerSourceService,
        SourceArchiveService,
        { provide: getRepositoryToken(HostedServer), useValue: hostedServerRepo },
        { provide: getRepositoryToken(Conversation), useValue: conversationRepo },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
      ],
    }).compile();

    return module.get(HostedServerSourceService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    configValues = {};
    hostedServerRepo = { findOne: jest.fn().mockResolvedValue(RUNNING_SERVER) };
    conversationRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'conv-1', state: { generatedCode: GENERATED_CODE } }),
    };
    service = await build();
  });

  describe('reads from Postgres, not pod-local disk', () => {
    /**
     * The whole point of this endpoint. GENERATED_SERVERS_DIR is an emptyDir on
     * the backend pod - invisible to every other pod and destroyed on
     * reschedule. If this ever went back to reading disk, the endpoint would
     * silently work in dev and fail in the cluster.
     */
    it('sources the archive from conversations.state.generatedCode', async () => {
      await service.getSourceArchive('demo-mcp-abcd1234');

      expect(conversationRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'conv-1' } }),
      );
    });

    it('resolves the conversation via the hosted server row', async () => {
      await service.getSourceArchive('demo-mcp-abcd1234');

      expect(hostedServerRepo.findOne).toHaveBeenCalledWith({
        where: { serverId: 'demo-mcp-abcd1234' },
      });
    });
  });

  describe('404 - nothing to serve', () => {
    it('for an unknown server', async () => {
      hostedServerRepo.findOne.mockResolvedValue(null);
      await expect(service.getSourceArchive('nope')).rejects.toThrow(NotFoundException);
    });

    it('for a deleted server, whose row outlives the soft delete', async () => {
      hostedServerRepo.findOne.mockResolvedValue({ ...RUNNING_SERVER, status: 'deleted' });
      await expect(service.getSourceArchive('demo-mcp-abcd1234')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('when the conversation link was severed (ON DELETE SET NULL)', async () => {
      hostedServerRepo.findOne.mockResolvedValue({ ...RUNNING_SERVER, conversationId: null });
      await expect(service.getSourceArchive('demo-mcp-abcd1234')).rejects.toThrow(
        NotFoundException,
      );
      expect(conversationRepo.findOne).not.toHaveBeenCalled();
    });

    it('when the conversation row itself is gone', async () => {
      conversationRepo.findOne.mockResolvedValue(null);
      await expect(service.getSourceArchive('demo-mcp-abcd1234')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('when the conversation holds no generated code', async () => {
      conversationRepo.findOne.mockResolvedValue({ id: 'conv-1', state: {} });
      await expect(service.getSourceArchive('demo-mcp-abcd1234')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('when generatedCode is present but empty', async () => {
      conversationRepo.findOne.mockResolvedValue({
        id: 'conv-1',
        state: { generatedCode: { supportingFiles: {} } },
      });
      await expect(service.getSourceArchive('demo-mcp-abcd1234')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('size cap', () => {
    it('refuses an oversized archive before writing a single byte', async () => {
      configValues.HOSTED_SERVER_SOURCE_MAX_BYTES = '1024';
      service = await build();

      await expect(service.getSourceArchive('demo-mcp-abcd1234')).rejects.toThrow(
        PayloadTooLargeException,
      );
    });

    it('allows an archive inside the configured cap', async () => {
      configValues.HOSTED_SERVER_SOURCE_MAX_BYTES = String(64 * 1024);
      service = await build();

      await expect(service.getSourceArchive('demo-mcp-abcd1234')).resolves.toBeDefined();
    });

    it('falls back to the 32 MiB default for a nonsense configured value', async () => {
      configValues.HOSTED_SERVER_SOURCE_MAX_BYTES = 'banana';
      service = await build();

      await expect(service.getSourceArchive('demo-mcp-abcd1234')).resolves.toBeDefined();
    });
  });

  describe('archive metadata', () => {
    it('reports the file count and a serverId-derived filename', async () => {
      const archive = await service.getSourceArchive('demo-mcp-abcd1234');

      expect(archive.fileCount).toBe(6); // 3 well-known + 3 supporting
      expect(archive.filename).toBe('demo-mcp-abcd1234-source.tar.gz');
      expect(archive.uncompressedBytes).toBeGreaterThan(0);
    });
  });

  /**
   * The endpoint's contract is not "returns bytes" but "returns something that
   * extracts into a buildable project". This checks that end to end with the
   * system `tar`, from a realistic generatedCode blob.
   */
  describe('extracts to a buildable tree', () => {
    let workDir: string;

    const hasTar = (() => {
      try {
        execFileSync('tar', ['--version'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();
    const maybe = hasTar ? it : it.skip;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), 'hosted-source-spec-'));
    });

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    maybe('yields package.json, tsconfig.json and src/index.ts at the root', async () => {
      const archive = await service.getSourceArchive('demo-mcp-abcd1234');

      const archivePath = join(workDir, 'source.tar.gz');
      writeFileSync(archivePath, await collect(archive.stream));

      const outDir = join(workDir, 'out');
      execFileSync('mkdir', ['-p', outDir]);
      execFileSync('tar', ['-xzf', archivePath, '-C', outDir]);

      expect(readFileSync(join(outDir, 'package.json'), 'utf8')).toBe(
        GENERATED_CODE.packageJson,
      );
      expect(readFileSync(join(outDir, 'tsconfig.json'), 'utf8')).toBe(GENERATED_CODE.tsConfig);
      expect(readFileSync(join(outDir, 'src/index.ts'), 'utf8')).toBe(GENERATED_CODE.mainFile);
      expect(readFileSync(join(outDir, 'Dockerfile'), 'utf8')).toBe(
        GENERATED_CODE.supportingFiles.Dockerfile,
      );
      expect(readFileSync(join(outDir, '.dockerignore'), 'utf8')).toBe(
        GENERATED_CODE.supportingFiles['.dockerignore'],
      );
      expect(readFileSync(join(outDir, 'src/lib/client.ts'), 'utf8')).toBe(
        GENERATED_CODE.supportingFiles['src/lib/client.ts'],
      );
    });

    maybe('produces an archive with no wrapping directory', async () => {
      const archive = await service.getSourceArchive('demo-mcp-abcd1234');
      const archivePath = join(workDir, 'source.tar.gz');
      writeFileSync(archivePath, await collect(archive.stream));

      const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);

      // No entry may be nested under a single top-level wrapper directory.
      expect(listing).toContain('package.json');
      expect(listing.some((entry) => entry.startsWith(`${RUNNING_SERVER.serverId}/`))).toBe(false);
    });
  });
});
