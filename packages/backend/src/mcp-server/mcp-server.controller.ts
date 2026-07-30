import { Controller, Delete, Get, Logger, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';
import { McpToolsService } from './mcp-tools.service';

const MCP_SERVER_NAME = 'mcp-everything';
const MCP_SERVER_VERSION = '1.0.0';

/**
 * MCP Everything's own MCP server endpoint - lets external agents (Claude,
 * etc.) drive generation, check status, fetch generated code, and browse the
 * marketplace on behalf of an authenticated user.
 *
 * Transport: Streamable HTTP per the MCP 2026-07-28 specification, in the
 * spec's stateless-core mode (no `Mcp-Session-Id`, no `initialize` handshake
 * carried across requests - `StreamableHTTPServerTransport` is constructed
 * fresh per request with `sessionIdGenerator: undefined`, matching the SDK's
 * own `simpleStatelessStreamableHttp` example). GET and DELETE - used in the
 * pre-2026-07-28 stateful transport to resume/terminate a session - have
 * nothing to operate on in stateless mode and return 405 with a JSON-RPC
 * error body, exactly as the SDK's stateless example does.
 *
 * Auth: this endpoint is intentionally NOT `@Public()`. The global
 * `JwtAuthGuard` (see `src/auth/guards/jwt-auth.guard.ts`) already accepts an
 * `X-API-Key` header or an `Authorization: Bearer mcpe_...` API key ahead of
 * passport-jwt, authenticating via `ApiKeyService.validateApiKey` and
 * attaching `request.user` - which is exactly the per-request auth an MCP
 * transport handshake needs (there is no browser session to piggyback a
 * cookie/JWT off of). A JWT bearer token also works through the same guard
 * for callers that already have one, but a user API key
 * (`mcpe_<48 hex chars>`, created via POST /api/v1/api-keys) is the intended
 * credential for agents. Missing/invalid credentials never reach this
 * controller - the guard throws its normal 401 first.
 */
@Controller('mcp')
export class McpServerController {
  private readonly logger = new Logger(McpServerController.name);

  constructor(private readonly tools: McpToolsService) {}

  @Post()
  async handlePost(
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const server = this.buildServer(user.id);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on('close', () => {
        transport.close().catch((error) => this.logger.warn(`transport.close failed: ${error}`));
        server.close().catch((error) => this.logger.warn(`server.close failed: ${error}`));
      });
    } catch (error) {
      this.logger.error(
        `Error handling MCP request: ${error instanceof Error ? error.message : error}`,
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  /**
   * The 2026-07-28 spec's stateless core removes the session concept
   * entirely, so there is nothing for a standalone GET SSE stream to resume.
   * Mirrors the official SDK stateless example's response.
   */
  @Get()
  handleGet(@Res() res: Response): void {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'Method not allowed: this MCP server is stateless (spec 2026-07-28) - there is no session to resume via GET.',
      },
      id: null,
    });
  }

  /** No session exists to terminate in stateless mode; see `handleGet`. */
  @Delete()
  handleDelete(@Res() res: Response): void {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'Method not allowed: this MCP server is stateless (spec 2026-07-28) - there is no session to terminate via DELETE.',
      },
      id: null,
    });
  }

  /**
   * Builds a fresh `McpServer` for a single request, with every tool bound to
   * the already-authenticated `userId` via closure. Per-request construction
   * (rather than one long-lived server instance) is what the stateless
   * transport pattern requires - see `StreamableHTTPServerTransport`'s own
   * docs on avoiding request-id collisions across concurrent requests.
   */
  private buildServer(userId: string): McpServer {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    this.tools.registerTools(server, userId);
    return server;
  }
}
