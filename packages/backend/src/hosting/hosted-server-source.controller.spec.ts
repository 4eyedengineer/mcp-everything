import { NotFoundException } from '@nestjs/common';
import { Readable, PassThrough } from 'node:stream';
import { HostedServerSourceController } from './hosted-server-source.controller';
import { HostedServerSourceService } from './hosted-server-source.service';
import { RequestWithHostedServerSourceAuth } from './guards/hosted-server-source.guard';
import { HostedServerSourceRoute } from '../auth/decorators/hosted-server-source.decorator';
import { IS_HOSTED_SERVER_SOURCE_KEY } from '../auth/decorators/hosted-server-source.decorator';
import { HostedServerSourceGuard } from './guards/hosted-server-source.guard';

describe('HostedServerSourceController', () => {
  let controller: HostedServerSourceController;
  let sourceService: { getSourceArchive: jest.Mock };
  let res: {
    setHeader: jest.Mock;
    destroy: jest.Mock;
    headers: Record<string, string>;
  } & NodeJS.WritableStream;

  const request = {
    hostedServerSourceAuth: { serverId: 'srv-1', sourceTokenId: 'token-1' },
  } as RequestWithHostedServerSourceAuth;

  beforeEach(() => {
    sourceService = { getSourceArchive: jest.fn() };
    controller = new HostedServerSourceController(
      sourceService as unknown as HostedServerSourceService,
    );

    const sink = new PassThrough() as unknown as typeof res;
    sink.headers = {};
    sink.setHeader = jest.fn((name: string, value: string) => {
      sink.headers[name] = value;
    });
    sink.destroy = jest.fn();
    res = sink;
  });

  function archive(overrides: Record<string, unknown> = {}) {
    return {
      stream: Readable.from([Buffer.from('gzip-bytes')]),
      filename: 'srv-1-source.tar.gz',
      fileCount: 4,
      uncompressedBytes: 2048,
      ...overrides,
    };
  }

  it('streams the archive body to the response', async () => {
    sourceService.getSourceArchive.mockResolvedValue(archive());

    await controller.getSource('srv-1', request, res as any);

    const body: Buffer[] = [];
    for await (const chunk of res as unknown as AsyncIterable<Buffer>) {
      body.push(chunk);
    }
    expect(Buffer.concat(body).toString()).toBe('gzip-bytes');
  });

  it('advertises application/gzip with a download filename', async () => {
    sourceService.getSourceArchive.mockResolvedValue(archive());

    await controller.getSource('srv-1', request, res as any);

    expect(res.headers['Content-Type']).toBe('application/gzip');
    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="srv-1-source.tar.gz"',
    );
  });

  /**
   * The gzipped length is not known until the stream ends. Setting a guessed
   * Content-Length would truncate or hang the transfer; omitting it lets
   * Express fall back to chunked encoding.
   */
  it('sets no Content-Length, because the compressed size is not known ahead', async () => {
    sourceService.getSourceArchive.mockResolvedValue(archive());

    await controller.getSource('srv-1', request, res as any);

    expect(res.headers['Content-Length']).toBeUndefined();
  });

  it('marks the response no-store - this body is a user private source', async () => {
    sourceService.getSourceArchive.mockResolvedValue(archive());

    await controller.getSource('srv-1', request, res as any);

    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('propagates a 404 before writing any response headers', async () => {
    sourceService.getSourceArchive.mockRejectedValue(new NotFoundException('gone'));

    await expect(controller.getSource('srv-1', request, res as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  /**
   * Headers are already sent by the time the stream can fail, so there is no
   * status code left to change. Destroying the socket makes the client see a
   * truncated transfer and fail loudly, rather than extracting a partial
   * archive it believes is complete.
   */
  it('destroys the response when the archive stream fails mid-flight', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('disk went away'));
      },
    });
    sourceService.getSourceArchive.mockResolvedValue(archive({ stream: failing }));

    await controller.getSource('srv-1', request, res as any);
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.destroy).toHaveBeenCalledWith(expect.any(Error));
  });

  /**
   * The route is only safe because the global guard's deferral is closed by a
   * mandatory route-level guard. Losing either decorator would leave `mcpsrc_`
   * requests unauthenticated, so both are asserted structurally.
   */
  describe('route metadata', () => {
    it('is marked as a source route so the global guard defers rather than rejects', () => {
      expect(
        Reflect.getMetadata(IS_HOSTED_SERVER_SOURCE_KEY, controller.getSource),
      ).toBe(true);
    });

    it('carries HostedServerSourceGuard, which is what closes that deferral', () => {
      const guards = Reflect.getMetadata('__guards__', controller.getSource) ?? [];
      expect(guards).toContain(HostedServerSourceGuard);
    });

    it('the decorator it relies on actually sets that metadata key', () => {
      class Probe {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        handler() {}
      }
      HostedServerSourceRoute()(Probe.prototype, 'handler', {
        value: Probe.prototype.handler,
      });

      expect(
        Reflect.getMetadata(IS_HOSTED_SERVER_SOURCE_KEY, Probe.prototype.handler),
      ).toBe(true);
    });
  });
});
