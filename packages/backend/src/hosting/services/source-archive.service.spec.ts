import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BadRequestException } from '@nestjs/common';
import { SourceArchiveService } from './source-archive.service';

/** Drain a stream to a single Buffer. Only used to inspect a finished archive. */
async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('SourceArchiveService', () => {
  let service: SourceArchiveService;
  let workDir: string;

  beforeEach(() => {
    service = new SourceArchiveService();
    workDir = mkdtempSync(join(tmpdir(), 'source-archive-spec-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('gzip framing', () => {
    it('produces a real gzip stream, not a bare tar', async () => {
      const archive = await collect(service.pack(new Map([['a.txt', 'hello']])));

      // Gzip magic number 0x1f 0x8b, then deflate (method 8).
      expect(archive[0]).toBe(0x1f);
      expect(archive[1]).toBe(0x8b);
      expect(archive[2]).toBe(0x08);

      // And it must actually inflate.
      expect(() => gunzipSync(archive)).not.toThrow();
    });

    it('gunzips to a whole number of 512-byte tar blocks', async () => {
      const tar = gunzipSync(await collect(service.pack(new Map([['a.txt', 'hello']]))));
      expect(tar.length % 512).toBe(0);
    });

    it('ends with the two zero blocks that mark end-of-archive', async () => {
      const tar = gunzipSync(await collect(service.pack(new Map([['a.txt', 'hi']]))));
      expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true);
    });
  });

  describe('ustar header correctness', () => {
    it('writes a checksum that matches the header bytes', async () => {
      const tar = gunzipSync(await collect(service.pack(new Map([['a.txt', 'hello']]))));
      const header = tar.subarray(0, 512);

      const stored = Number.parseInt(header.subarray(148, 154).toString('ascii'), 8);

      // Recompute with the checksum field treated as eight spaces.
      const recomputed = Buffer.from(header);
      recomputed.write('        ', 148, 8, 'ascii');
      let sum = 0;
      for (const byte of recomputed) {
        sum += byte;
      }

      expect(stored).toBe(sum);
    });

    it('declares the ustar magic and a regular-file typeflag', async () => {
      const tar = gunzipSync(await collect(service.pack(new Map([['a.txt', 'hello']]))));
      const header = tar.subarray(0, 512);

      expect(header.subarray(257, 262).toString('ascii')).toBe('ustar');
      expect(header.subarray(156, 157).toString('ascii')).toBe('0');
    });

    it('records the exact byte length of each entry', async () => {
      const content = 'x'.repeat(1000);
      const tar = gunzipSync(await collect(service.pack(new Map([['big.txt', content]]))));
      const size = Number.parseInt(tar.subarray(124, 135).toString('ascii'), 8);
      expect(size).toBe(1000);
    });

    it('splits a long path across the prefix and name fields', async () => {
      const deep = `${'nested/'.repeat(20)}index.ts`; // 148 chars, > the 100-byte name field
      const tar = gunzipSync(await collect(service.pack(new Map([[deep, 'x']]))));
      const header = tar.subarray(0, 512);

      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');

      expect(prefix).not.toBe('');
      expect(`${prefix}/${name}`).toBe(deep);
    });
  });

  describe('path safety - this is what a third party extracts', () => {
    it.each([
      ['../escape.txt', 'parent traversal'],
      ['src/../../escape.txt', 'embedded traversal'],
      ['/etc/passwd', 'absolute path'],
      ['C:/windows/system32', 'windows drive path'],
    ])('rejects %s (%s)', (path) => {
      expect(() => service.pack(new Map([[path, 'pwned']]))).toThrow(BadRequestException);
    });

    it('rejects a NUL byte, which would truncate the header name field', () => {
      expect(() => service.pack(new Map([['a\0b.txt', 'x']]))).toThrow(BadRequestException);
    });

    it('rejects a path too long for the ustar name+prefix fields', () => {
      expect(() => service.pack(new Map([[`${'a'.repeat(300)}.txt`, 'x']]))).toThrow(
        BadRequestException,
      );
    });

    it('rejects a single component longer than the 100-byte name field', () => {
      expect(() => service.pack(new Map([[`src/${'a'.repeat(120)}.ts`, 'x']]))).toThrow(
        BadRequestException,
      );
    });

    it('validates every entry before emitting any bytes', () => {
      // The unsafe entry is last; nothing must have been written for the first.
      expect(() =>
        service.pack(
          new Map([
            ['ok.txt', 'fine'],
            ['../bad.txt', 'not fine'],
          ]),
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe('archiveSizeBytes', () => {
    it('predicts the uncompressed archive size exactly', async () => {
      const files = new Map([
        ['package.json', '{"name":"x"}'],
        ['src/index.ts', 'y'.repeat(1500)],
      ]);

      const tar = gunzipSync(await collect(service.pack(files)));
      expect(service.archiveSizeBytes(files)).toBe(tar.length);
    });

    it('accounts for the end-of-archive marker on an empty set', async () => {
      const tar = gunzipSync(await collect(service.pack(new Map())));
      expect(service.archiveSizeBytes(new Map())).toBe(tar.length);
      expect(tar.length).toBe(1024);
    });
  });

  /**
   * The tar writer is hand-rolled, so "it parses in our own test helper" proves
   * nothing. These extract with the system `tar` - the same implementation a
   * pod's entrypoint will use.
   */
  describe('real extraction with system tar', () => {
    const hasTar = (() => {
      try {
        execFileSync('tar', ['--version'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();

    const maybe = hasTar ? it : it.skip;

    maybe('extracts to the expected tree, with byte-identical contents', async () => {
      const files = new Map([
        ['package.json', '{\n  "name": "demo"\n}\n'],
        ['tsconfig.json', '{"compilerOptions":{}}'],
        ['src/index.ts', 'console.log("hi");\n'],
        ['src/lib/util.ts', 'export const x = 1;\n'],
        ['Dockerfile', 'FROM node:20-alpine\n'],
        ['.dockerignore', 'node_modules\n'],
      ]);

      const archivePath = join(workDir, 'src.tar.gz');
      writeFileSync(archivePath, await collect(service.pack(files)));

      const outDir = join(workDir, 'out');
      execFileSync('mkdir', ['-p', outDir]);
      execFileSync('tar', ['-xzf', archivePath, '-C', outDir]);

      for (const [path, content] of files) {
        expect(existsSync(join(outDir, path))).toBe(true);
        expect(readFileSync(join(outDir, path), 'utf8')).toBe(content);
      }
    });

    maybe('places entries at the archive root, with no wrapping directory', async () => {
      const archivePath = join(workDir, 'src.tar.gz');
      writeFileSync(
        archivePath,
        await collect(service.pack(new Map([['package.json', '{}'], ['src/index.ts', 'x']]))),
      );

      const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);

      expect(listing.sort()).toEqual(['package.json', 'src/index.ts']);
    });

    maybe('round-trips content with non-ASCII bytes and exact lengths', async () => {
      // Emoji and accents are multi-byte; a header written with string length
      // rather than byte length would corrupt the very next entry.
      const files = new Map([
        ['a.txt', 'héllo wörld ✅\n'],
        ['b.txt', 'after\n'],
      ]);

      const archivePath = join(workDir, 'utf8.tar.gz');
      writeFileSync(archivePath, await collect(service.pack(files)));

      const outDir = join(workDir, 'utf8-out');
      execFileSync('mkdir', ['-p', outDir]);
      execFileSync('tar', ['-xzf', archivePath, '-C', outDir]);

      expect(readFileSync(join(outDir, 'a.txt'), 'utf8')).toBe('héllo wörld ✅\n');
      expect(readFileSync(join(outDir, 'b.txt'), 'utf8')).toBe('after\n');
    });

    maybe('extracts a file whose length is an exact block multiple', async () => {
      // 512 bytes exactly: the padding branch must emit nothing, not a block.
      const files = new Map([
        ['exact.txt', 'z'.repeat(512)],
        ['next.txt', 'sentinel\n'],
      ]);

      const archivePath = join(workDir, 'exact.tar.gz');
      writeFileSync(archivePath, await collect(service.pack(files)));

      const outDir = join(workDir, 'exact-out');
      execFileSync('mkdir', ['-p', outDir]);
      execFileSync('tar', ['-xzf', archivePath, '-C', outDir]);

      expect(readFileSync(join(outDir, 'exact.txt'), 'utf8')).toBe('z'.repeat(512));
      expect(readFileSync(join(outDir, 'next.txt'), 'utf8')).toBe('sentinel\n');
    });
  });
});
