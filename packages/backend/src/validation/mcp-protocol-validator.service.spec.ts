import { McpProtocolValidatorService } from './mcp-protocol-validator.service';
import {
  FIXTURE_SIMPLE_WORKING_SERVER,
  FIXTURE_HTTP_WORKING_SERVER,
} from '../testing/testing.fixtures';

describe('McpProtocolValidatorService — dual transport (stdio + HTTP)', () => {
  // Real npm install + tsc + process start/handshake per test; generous timeout.
  jest.setTimeout(60000);

  let service: McpProtocolValidatorService;

  beforeEach(() => {
    service = new McpProtocolValidatorService();
  });

  it('validates a server over HTTP by default (this is the transport used by the refinement quality gate)', async () => {
    const result = await service.validateServer({
      mainFile: FIXTURE_HTTP_WORKING_SERVER.mainFile,
      packageJson: FIXTURE_HTTP_WORKING_SERVER.packageJson,
      tsConfig: FIXTURE_HTTP_WORKING_SERVER.tsConfig,
      metadata: {
        tools: FIXTURE_HTTP_WORKING_SERVER.metadata.tools,
        serverName: FIXTURE_HTTP_WORKING_SERVER.metadata.serverName,
      },
      // transport option intentionally omitted — must default to 'http'.
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.toolCount).toBe(2);
    expect(result.serverInfo?.name).toBe('http-dual-transport-mcp-server');

    const toolCallChecks = result.checks.filter((c) => c.name.startsWith('tools/call:'));
    expect(toolCallChecks.length).toBeGreaterThan(0);
    expect(toolCallChecks.every((c) => c.passed)).toBe(true);
  });

  it('still supports the legacy stdio transport when explicitly requested (regression check)', async () => {
    const result = await service.validateServer(
      {
        mainFile: FIXTURE_SIMPLE_WORKING_SERVER.mainFile,
        packageJson: FIXTURE_SIMPLE_WORKING_SERVER.packageJson,
        tsConfig: FIXTURE_SIMPLE_WORKING_SERVER.tsConfig,
        metadata: {
          tools: FIXTURE_SIMPLE_WORKING_SERVER.metadata.tools,
          serverName: FIXTURE_SIMPLE_WORKING_SERVER.metadata.serverName,
        },
      },
      { transport: 'stdio' },
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.toolCount).toBe(2);
  });
});
