import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { ErrorLoggingService } from './error-logging.service';

/**
 * These cover ONE property: a credential must never survive into an error log
 * or an error response body.
 *
 * `sanitizeHeaders` already redacts `Authorization`, so a credential sent the
 * correct way was safe. A credential sent the WRONG way - in the query string -
 * was logged in full, and those logs are persisted to the database and served
 * by the log-viewer endpoints. Hosted-server source tokens (`mcpsrc_`) make
 * that live: they grant read access to a user's generated source and are held
 * by a pod, so a misconfigured deployment could log one on every failed
 * request.
 */
describe('GlobalExceptionFilter credential redaction', () => {
  let filter: GlobalExceptionFilter;
  let logError: jest.Mock;
  let jsonBody: Record<string, any>;

  function hostFor(url: string, query: Record<string, any> = {}): ArgumentsHost {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn((body: Record<string, any>) => {
        jsonBody = body;
      }),
    };
    const request = {
      url,
      method: 'GET',
      query,
      params: {},
      body: {},
      headers: {},
      ip: '127.0.0.1',
      get: () => undefined,
    };

    return {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as unknown as ArgumentsHost;
  }

  beforeEach(() => {
    jsonBody = {};
    logError = jest.fn().mockResolvedValue(undefined);
    filter = new GlobalExceptionFilter({ logError } as unknown as ErrorLoggingService);
  });

  it.each([
    ['mcpsrc_', 'mcpsrc_wOytuywv6OpUgwdZztA5FnTaaR8Z5Eh5WAWotgnriW4'],
    ['mcps_', 'mcps_aGatewayKeyValueHere'],
    ['mcpe_', 'mcpe_aPlatformKeyValueHere'],
  ])('redacts a %s credential from the logged URL', async (prefix, token) => {
    await filter.catch(
      new UnauthorizedException('nope'),
      hostFor(`/api/hosting/servers/srv-1/source?token=${token}`, { token }),
    );

    const logged = JSON.stringify(logError.mock.calls[0][0]);
    expect(logged).not.toContain(token);
    expect(logged).toContain(`${prefix}[REDACTED]`);
  });

  it('redacts the credential from the error response body too', async () => {
    const token = 'mcpsrc_wOytuywv6OpUgwdZztA5FnTaaR8Z5Eh5WAWotgnriW4';

    await filter.catch(
      new UnauthorizedException('nope'),
      hostFor(`/api/hosting/servers/srv-1/source?token=${token}`, { token }),
    );

    expect(JSON.stringify(jsonBody)).not.toContain(token);
  });

  it('redacts the parsed query object, not just the raw URL string', async () => {
    const token = 'mcpsrc_wOytuywv6OpUgwdZztA5FnTaaR8Z5Eh5WAWotgnriW4';

    await filter.catch(new UnauthorizedException('nope'), hostFor('/x', { token }));

    expect(logError.mock.calls[0][0].context.query.token).not.toContain(
      'wOytuywv6OpUgwdZztA5FnTaaR8Z5Eh5WAWotgnriW4',
    );
  });

  it.each(['ticket', 'api_key', 'apikey', 'access_token', 'password'])(
    'redacts a ?%s= value even when it carries no known prefix',
    async (param) => {
      await filter.catch(
        new UnauthorizedException('nope'),
        hostFor(`/api/chat/stream/sess-1?${param}=SuperSecretOpaqueValue`),
      );

      const logged = JSON.stringify(logError.mock.calls[0][0]);
      expect(logged).not.toContain('SuperSecretOpaqueValue');
    },
  );

  it('leaves an ordinary URL untouched', async () => {
    await filter.catch(
      new HttpException('nope', HttpStatus.NOT_FOUND),
      hostFor('/api/hosting/servers/srv-1/source'),
    );

    expect(logError.mock.calls[0][0].context.path).toBe('/api/hosting/servers/srv-1/source');
  });

  it('preserves non-credential query parameters', async () => {
    await filter.catch(
      new HttpException('nope', HttpStatus.NOT_FOUND),
      hostFor('/api/hosting/servers?page=2&limit=20', { page: '2', limit: '20' }),
    );

    expect(logError.mock.calls[0][0].context.path).toBe('/api/hosting/servers?page=2&limit=20');
    expect(logError.mock.calls[0][0].context.query).toEqual({ page: '2', limit: '20' });
  });
});
