import { Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import type { Readable } from 'node:stream';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { Conversation } from '../database/entities/conversation.entity';
import { buildGeneratedFileMap } from '../orchestration/generated-code-layout';
import { SourceArchiveService } from './services/source-archive.service';

export interface SourceArchive {
  /** A `.tar.gz` stream, generated as it is consumed. */
  stream: Readable;
  /** Suggested download filename. Non-secret. */
  filename: string;
  fileCount: number;
  /** Size of the archive BEFORE gzip. The compressed size is not known ahead. */
  uncompressedBytes: number;
}

/**
 * Serves a hosted server's generated source as a tarball, from Postgres.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `GENERATED_SERVERS_DIR`
 * ---------------------------------------------------------------------------
 * `GenerationPipeline.persist` does two things with the generated code: it
 * writes it to `conversations.state.generatedCode` (durable, replicated with
 * the database) and it writes a derived copy under `GENERATED_SERVERS_DIR`.
 * That directory is an `emptyDir` volume on the backend pod
 * (k8s/base/backend/deployment.yaml) - it is invisible to every other pod in
 * the cluster and it is destroyed when the backend pod is rescheduled.
 *
 * Reading from disk here would therefore make source availability depend on
 * "did the same backend pod that generated this server happen to still be
 * running", which is not a property anything can rely on. This reads the row.
 * The disk copy stays as the local build path's input; it is no longer the
 * only way to get at the source.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class HostedServerSourceService {
  private readonly logger = new Logger(HostedServerSourceService.name);

  /**
   * Cap on the UNCOMPRESSED archive size.
   *
   * 32 MiB is roughly two orders of magnitude above any generated server
   * observed so far (they are a handful of TypeScript files, tens of KB), so
   * it will not be hit by legitimate output. It exists because the size of
   * `state.generatedCode` is bounded only by what a model produced, and an
   * endpoint that will stream an arbitrary number of bytes to a caller
   * presenting one token is a denial-of-service primitive.
   */
  static readonly DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

  private readonly maxArchiveBytes: number;

  constructor(
    @InjectRepository(HostedServer)
    private readonly hostedServerRepository: Repository<HostedServer>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    private readonly sourceArchiveService: SourceArchiveService,
    private readonly configService: ConfigService,
  ) {
    const configured = Number.parseInt(
      String(this.configService.get('HOSTED_SERVER_SOURCE_MAX_BYTES') ?? ''),
      10,
    );
    this.maxArchiveBytes =
      Number.isFinite(configured) && configured > 0
        ? configured
        : HostedServerSourceService.DEFAULT_MAX_ARCHIVE_BYTES;
  }

  /**
   * Build the source archive for one hosted server.
   *
   * The caller (`HostedServerSourceGuard`) has already proved the request may
   * read this server's source, so no ownership check is repeated here.
   *
   * Throws `NotFoundException` for every "there is no source to serve" case -
   * unknown server, deleted server, a conversation that was removed, a
   * conversation that never produced code. The contract says 404 for "unknown
   * server, or source no longer available", and these are not distinguishable
   * from the pod's point of view: there is nothing to fetch either way.
   */
  async getSourceArchive(serverId: string): Promise<SourceArchive> {
    const server = await this.hostedServerRepository.findOne({ where: { serverId } });

    if (!server || server.status === 'deleted') {
      throw new NotFoundException(`Server not found: ${serverId}`);
    }

    if (!server.conversationId) {
      // `hosted_servers.conversation_id` is ON DELETE SET NULL, so deleting the
      // chat severs the only link back to the generated code.
      throw new NotFoundException(
        `Source is no longer available for server '${serverId}': ` +
          'the conversation it was generated from has been deleted.',
      );
    }

    const conversation = await this.conversationRepository.findOne({
      where: { id: server.conversationId },
      select: ['id', 'state'],
    });

    const files = buildGeneratedFileMap(conversation?.state?.generatedCode);

    if (files.size === 0) {
      throw new NotFoundException(
        `Source is no longer available for server '${serverId}': ` +
          'no generated code is stored for its conversation.',
      );
    }

    const uncompressedBytes = this.sourceArchiveService.archiveSizeBytes(files);

    // Checked BEFORE any byte is written, so an oversized archive is a clean
    // 413 rather than a response that starts 200 and then dies mid-stream with
    // a truncated tarball the pod would try to extract.
    if (uncompressedBytes > this.maxArchiveBytes) {
      throw new PayloadTooLargeException(
        `Generated source for server '${serverId}' is ${uncompressedBytes} bytes, ` +
          `over the ${this.maxArchiveBytes}-byte limit.`,
      );
    }

    this.logger.log(
      `Serving source for hosted server ${serverId}: ` +
        `${files.size} file(s), ${uncompressedBytes} bytes uncompressed`,
    );

    return {
      stream: this.sourceArchiveService.pack(files),
      filename: `${serverId}-source.tar.gz`,
      fileCount: files.size,
      uncompressedBytes,
    };
  }
}
