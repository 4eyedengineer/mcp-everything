import { BadRequestException, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { createGzip, constants as zlibConstants } from 'node:zlib';

/** Every structure in a tar archive is a whole number of 512-byte blocks. */
const BLOCK_SIZE = 512;

/** POSIX ustar: name field is 100 bytes, with an optional 155-byte prefix. */
const NAME_FIELD_SIZE = 100;
const PREFIX_FIELD_SIZE = 155;

/** Mode for every entry. Source files; nothing here needs to be executable. */
const FILE_MODE = 0o644;

/**
 * Builds a gzipped POSIX ustar archive from an in-memory set of text files.
 *
 * ---------------------------------------------------------------------------
 * WHY A HAND-WRITTEN TAR WRITER
 * ---------------------------------------------------------------------------
 * `tar-stream` is physically present in node_modules, but only transitively
 * (via `tar-fs`), and it ships no type declarations - using it would mean
 * either adding `@types/tar-stream` to the dependency tree or writing a
 * hand-maintained shim for a library we would be using for one function.
 *
 * What we actually need is the smallest subset of tar there is: regular files,
 * no symlinks, no hardlinks, no sparse files, no extended attributes, all
 * content already in memory. That is ~60 lines of format code, it is frozen
 * (ustar has not changed since POSIX.1-1988), and it is verified end to end by
 * `tar -xzf` in the test suite rather than by trusting a spec reading. The
 * dependency was not worth its own maintenance surface.
 * ---------------------------------------------------------------------------
 *
 * STREAMING: `pack()` returns a stream that is *generated* as it is consumed.
 * Exactly one file's bytes exist as a Buffer at a time, and gzip applies
 * backpressure through the async generator, so the completed archive is never
 * held in memory. (The source text itself is unavoidably resident - it arrives
 * as a single JSONB column read - so the bound this buys is on the archive,
 * which is the part that would otherwise be duplicated per concurrent request.)
 */
@Injectable()
export class SourceArchiveService {
  /**
   * Produce a `.tar.gz` of `files`, keyed by project-root-relative path.
   *
   * Entries land at the archive root (`package.json`, `src/index.ts`, ...) with
   * no wrapping directory, so `tar -xzf` into an empty directory yields a
   * buildable project - which is the endpoint's entire contract.
   *
   * No explicit directory entries are emitted. Every extractor in practical
   * use (GNU tar, bsdtar, busybox tar, Node's tar-fs) creates missing parents
   * for a regular-file entry, and omitting them keeps the archive minimal.
   */
  pack(files: ReadonlyMap<string, string>): Readable {
    // Every entry is validated BEFORE the stream is created, so a bad path is a
    // synchronous throw the controller can still turn into an error status.
    // Validating lazily inside the generator would surface it as a stream
    // error after `200 OK` and the response headers had already gone out, and
    // the client would see a truncated archive instead of a failure.
    // `splitPath` is included here, not just the cheap checks, because it has
    // its own rejection case (a single path component over 100 bytes).
    for (const path of files.keys()) {
      this.assertSafeEntryPath(path);
      this.splitPath(path);
    }

    // Fixed mtime source, captured once, so every entry in one archive agrees.
    const mtime = Math.floor(Date.now() / 1000);

    const blocks = async function* (this: SourceArchiveService): AsyncGenerator<Buffer> {
      for (const [path, content] of files) {
        const data = Buffer.from(content, 'utf8');

        yield this.buildHeader(path, data.length, mtime);
        yield data;

        // Pad the file body out to a block boundary.
        const remainder = data.length % BLOCK_SIZE;
        if (remainder !== 0) {
          yield Buffer.alloc(BLOCK_SIZE - remainder);
        }
      }

      // End-of-archive marker: two consecutive zero blocks.
      yield Buffer.alloc(BLOCK_SIZE * 2);
    }.call(this);

    // Level 6 (zlib's default) rather than 9: this is short, highly
    // compressible text over a network the pod is already waiting on, and the
    // extra CPU of level 9 buys single-digit percent on payloads this size.
    return Readable.from(blocks).pipe(createGzip({ level: zlibConstants.Z_DEFAULT_COMPRESSION }));
  }

  /** Uncompressed size of the archive `pack()` would produce, in bytes. */
  archiveSizeBytes(files: ReadonlyMap<string, string>): number {
    let total = 0;

    for (const content of files.values()) {
      const size = Buffer.byteLength(content, 'utf8');
      total += BLOCK_SIZE; // header
      total += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE; // padded body
    }

    return total + BLOCK_SIZE * 2; // end-of-archive marker
  }

  /**
   * Reject anything that would let an archive escape the directory it is
   * extracted into, or that ustar cannot represent.
   *
   * This is the trust boundary. `generatedCode.supportingFiles` is keyed by
   * paths a language model produced, so "the generator would never do that" is
   * not a security argument - a `../../.ssh/authorized_keys` entry is a
   * classic tar traversal, and the pod extracting this archive runs as root in
   * its own filesystem.
   */
  private assertSafeEntryPath(path: string): void {
    if (!path || path.trim() !== path) {
      throw new BadRequestException(`Unsafe archive entry path: '${path}'`);
    }

    if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
      throw new BadRequestException(`Archive entry path must be relative: '${path}'`);
    }

    // Covers `..`, `../x`, `x/../y` and `x/..` alike.
    if (path.split('/').includes('..')) {
      throw new BadRequestException(`Archive entry path must not traverse upwards: '${path}'`);
    }

    // NUL would truncate the name inside the fixed-width header field.
    if (path.includes('\0')) {
      throw new BadRequestException(`Archive entry path contains a NUL byte`);
    }

    if (Buffer.byteLength(path, 'utf8') > NAME_FIELD_SIZE + 1 + PREFIX_FIELD_SIZE) {
      throw new BadRequestException(`Archive entry path is too long for the tar format: '${path}'`);
    }
  }

  /**
   * One 512-byte POSIX ustar header.
   *
   * Field offsets are from POSIX.1-1988 §10.1.1. The checksum is computed with
   * its own field treated as eight spaces, then written back as six octal
   * digits followed by NUL and a space - the one genuinely non-obvious part of
   * the format, and the part every extractor validates first.
   */
  private buildHeader(path: string, size: number, mtime: number): Buffer {
    const header = Buffer.alloc(BLOCK_SIZE);
    const { prefix, name } = this.splitPath(path);

    header.write(name, 0, NAME_FIELD_SIZE, 'utf8');
    header.write(this.octal(FILE_MODE, 8), 100, 8, 'ascii');
    header.write(this.octal(0, 8), 108, 8, 'ascii'); // uid
    header.write(this.octal(0, 8), 116, 8, 'ascii'); // gid
    header.write(this.octal(size, 12), 124, 12, 'ascii');
    header.write(this.octal(mtime, 12), 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii'); // checksum placeholder: 8 spaces
    header.write('0', 156, 1, 'ascii'); // typeflag '0' = regular file
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('root', 265, 32, 'ascii'); // uname
    header.write('root', 297, 32, 'ascii'); // gname

    if (prefix) {
      header.write(prefix, 345, PREFIX_FIELD_SIZE, 'utf8');
    }

    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

    return header;
  }

  /**
   * Split a path across ustar's `prefix` (155 bytes) and `name` (100 bytes)
   * fields when it does not fit in `name` alone. The split must fall on a `/`,
   * because extractors rejoin the two with one.
   */
  private splitPath(path: string): { prefix: string; name: string } {
    if (Buffer.byteLength(path, 'utf8') <= NAME_FIELD_SIZE) {
      return { prefix: '', name: path };
    }

    // Prefer the rightmost split that leaves a representable name, so the
    // prefix absorbs as much of the path as possible.
    for (let i = path.length - 1; i > 0; i--) {
      if (path[i] !== '/') {
        continue;
      }
      const prefix = path.slice(0, i);
      const name = path.slice(i + 1);
      if (
        Buffer.byteLength(name, 'utf8') <= NAME_FIELD_SIZE &&
        Buffer.byteLength(prefix, 'utf8') <= PREFIX_FIELD_SIZE
      ) {
        return { prefix, name };
      }
    }

    // A single path component longer than 100 bytes. `assertSafeEntryPath`
    // only bounds the total, so this is reachable and must not silently
    // truncate into a wrong filename.
    throw new BadRequestException(
      `Archive entry path cannot be represented in the tar format: '${path}'`,
    );
  }

  /** Zero-padded octal in `length` bytes, the last of which is NUL. */
  private octal(value: number, length: number): string {
    return `${value.toString(8).padStart(length - 1, '0')}\0`;
  }
}
