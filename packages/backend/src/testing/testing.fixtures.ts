/**
 * Test Fixtures for McpTestingService
 * Provides example generated code for testing the testing service itself
 */

import { GeneratedCode } from './mcp-testing.service';

/**
 * Simple working MCP server (all tools pass)
 */
export const FIXTURE_SIMPLE_WORKING_SERVER: GeneratedCode = {
  mainFile: `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';

async function addImplementation(args: any): Promise<{ content: [{ type: "text", text: string }] }> {
  try {
    const { a, b } = args || { a: 0, b: 0 };
    const result = (typeof a === 'number' ? a : 0) + (typeof b === 'number' ? b : 0);
    return {
      content: [{
        type: "text",
        text: \`Result: \${a} + \${b} = \${result}\`
      }]
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      \`Error in add: \${error instanceof Error ? error.message : String(error)}\`
    );
  }
}

async function multiplyImplementation(args: any): Promise<{ content: [{ type: "text", text: string }] }> {
  try {
    const { x, y } = args || { x: 1, y: 1 };
    const result = (typeof x === 'number' ? x : 1) * (typeof y === 'number' ? y : 1);
    return {
      content: [{
        type: "text",
        text: \`Result: \${x} * \${y} = \${result}\`
      }]
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      \`Error in multiply: \${error instanceof Error ? error.message : String(error)}\`
    );
  }
}

const server = new Server(
  {
    name: "simple-math-server",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number", description: "First number" },
            b: { type: "number", description: "Second number" }
          },
          required: ["a", "b"]
        }
      },
      {
        name: "multiply",
        description: "Multiply two numbers",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number", description: "First number" },
            y: { type: "number", description: "Second number" }
          },
          required: ["x", "y"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "add":
      return await addImplementation(request.params.arguments);
    case "multiply":
      return await multiplyImplementation(request.params.arguments);
    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        \`Unknown tool: \${request.params.name}\`
      );
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
`,

  packageJson: JSON.stringify(
    {
      name: 'simple-math-mcp-server',
      version: '0.1.0',
      description: 'Simple math operations MCP server',
      type: 'module',
      main: 'dist/index.js',
      scripts: {
        build: 'tsc',
        start: 'node dist/index.js',
        dev: 'tsc --watch',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '^0.5.0',
      },
      devDependencies: {
        '@types/node': '^20.0.0',
        typescript: '^5.0.0',
      },
    },
    null,
    2,
  ),

  tsConfig: JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'node',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        outDir: './dist',
        rootDir: './src',
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  ),

  supportingFiles: {},

  metadata: {
    tools: [
      {
        name: 'add',
        description: 'Add two numbers',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      },
      {
        name: 'multiply',
        description: 'Multiply two numbers',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
      },
    ],
    iteration: 1,
    serverName: 'simple-math-mcp-server',
  },
};

/**
 * Dual-transport MCP server (stdio default, HTTP via `MCP_TRANSPORT=http`).
 *
 * Modeled directly on a verified-working reference implementation (built and
 * curl-tested against a real `StreamableHTTPServerTransport` server: `POST
 * /mcp` with `Accept: application/json, text/event-stream`, `Mcp-Session-Id`
 * response header on initialize, SSE-framed `event: message\ndata: {...}`
 * response bodies). Tools are pure computation (no outbound network calls)
 * so tool execution is deterministic and doesn't depend on any external API
 * being reachable — only `npm install` needs network access.
 *
 * Used to exercise the HTTP transport branch of McpTestingService /
 * McpProtocolValidatorService, mirroring FIXTURE_SIMPLE_WORKING_SERVER for
 * the stdio branch.
 */
export const FIXTURE_HTTP_WORKING_SERVER: GeneratedCode = {
  mainFile: `import { randomUUID } from "node:crypto";
import http from "node:http";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

function buildServer(): McpServer {
  const server = new McpServer({
    name: "http-dual-transport-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "add",
    {
      title: "Add two numbers",
      description: "Adds two numbers together and returns the sum.",
      inputSchema: {
        a: z.number().describe("First addend"),
        b: z.number().describe("Second addend"),
      },
    },
    async ({ a, b }) => {
      return { content: [{ type: "text", text: String(a + b) }] };
    }
  );

  server.registerTool(
    "multiply",
    {
      title: "Multiply two numbers",
      description: "Multiplies two numbers together and returns the product.",
      inputSchema: {
        x: z.number().describe("First factor"),
        y: z.number().describe("Second factor"),
      },
    },
    async ({ x, y }) => {
      return { content: [{ type: "text", text: String(x * y) }] };
    }
  );

  return server;
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("http-dual-transport-mcp-server: listening on stdio");
}

async function runHttp(): Promise<void> {
  const port = Number(process.env.PORT) || 3000;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", \`http://\${req.headers.host}\`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.method === "POST") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString("utf-8");
      const parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(parsedBody)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };

        const server = buildServer();
        await server.connect(transport);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: no valid session ID provided for non-initialize request",
            },
            id: null,
          })
        );
        return;
      }

      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400).end("Invalid or missing session ID");
        return;
      }
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.error(\`http-dual-transport-mcp-server: listening on http://0.0.0.0:\${port}\`);
}

const transportMode = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

if (transportMode === "http") {
  runHttp().catch((err) => {
    console.error("Fatal error starting HTTP server:", err);
    process.exit(1);
  });
} else if (transportMode === "stdio") {
  runStdio().catch((err) => {
    console.error("Fatal error starting stdio server:", err);
    process.exit(1);
  });
} else {
  console.error(\`Unknown MCP_TRANSPORT "\${transportMode}" — expected "stdio" or "http".\`);
  process.exit(1);
}
`,

  packageJson: JSON.stringify(
    {
      name: 'http-dual-transport-mcp-server',
      version: '1.0.0',
      description: 'Dual-transport (stdio + Streamable HTTP) MCP server fixture',
      type: 'module',
      main: 'dist/index.js',
      scripts: {
        build: 'tsc -p tsconfig.json',
        start: 'node dist/index.js',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '1.30.0',
        zod: '4.4.3',
      },
      devDependencies: {
        '@types/node': '26.1.2',
        typescript: '7.0.2',
      },
      engines: {
        node: '>=20',
      },
    },
    null,
    2,
  ),

  tsConfig: JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        types: ['node'],
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: false,
        sourceMap: false,
        resolveJsonModule: true,
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  ),

  supportingFiles: {},

  metadata: {
    tools: [
      {
        name: 'add',
        description: 'Adds two numbers together and returns the sum.',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      },
      {
        name: 'multiply',
        description: 'Multiplies two numbers together and returns the product.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
      },
    ],
    iteration: 1,
    serverName: 'http-dual-transport-mcp-server',
  },
};

/**
 * HTTP-transport server that builds successfully, stays running (so the
 * process doesn't just exit on its own), but deliberately never binds its
 * HTTP listener (never calls `httpServer.listen(...)`), so `GET /health`
 * never comes up. Exercises the HTTP `waitForServerReady` polling-timeout
 * failure branch specifically (as opposed to the "process exited early"
 * branch), mirroring FIXTURE_INCOMPLETE_SERVER for stdio.
 */
export const FIXTURE_HTTP_INCOMPLETE_SERVER: GeneratedCode = {
  mainFile: `import http from "node:http";

// Deliberately builds the HTTP server but never calls listen() -
// GET /health will never respond, so waitForServerReady must time out.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
});

console.error("http-incomplete-mcp-server: built but not listening (intentional)");
// httpServer.listen(...) intentionally omitted.
void httpServer;

// Keep the process alive (unlike a script with nothing pending, which would
// just exit) so this genuinely exercises the /health polling timeout rather
// than the "process exited early" error path.
setInterval(() => {}, 60_000);
`,

  packageJson: JSON.stringify(
    {
      name: 'http-incomplete-mcp-server',
      version: '1.0.0',
      type: 'module',
      main: 'dist/index.js',
      scripts: {
        build: 'tsc -p tsconfig.json',
        start: 'node dist/index.js',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '1.30.0',
      },
      devDependencies: {
        '@types/node': '26.1.2',
        typescript: '7.0.2',
      },
    },
    null,
    2,
  ),

  tsConfig: JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        types: ['node'],
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: false,
        sourceMap: false,
        resolveJsonModule: true,
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  ),

  supportingFiles: {},

  metadata: {
    tools: [],
    iteration: 1,
    serverName: 'http-incomplete-mcp-server',
  },
};

/**
 * Server with build error (missing import)
 */
export const FIXTURE_BUILD_ERROR_SERVER: GeneratedCode = {
  mainFile: `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
// Missing StdioServerTransport import - will cause build error

const server = new Server(
  {
    name: "broken-server",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
`,

  packageJson: JSON.stringify(
    {
      name: 'broken-mcp-server',
      version: '0.1.0',
      type: 'module',
      main: 'dist/index.js',
      scripts: {
        build: 'tsc',
        start: 'node dist/index.js',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '^0.5.0',
      },
      devDependencies: {
        '@types/node': '^20.0.0',
        typescript: '^5.0.0',
      },
    },
    null,
    2,
  ),

  tsConfig: JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'node',
        strict: true,
        skipLibCheck: true,
        outDir: './dist',
        rootDir: './src',
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  ),

  supportingFiles: {},

  metadata: {
    tools: [
      {
        name: 'broken_tool',
        description: 'A tool that will fail',
        inputSchema: {},
      },
    ],
    iteration: 1,
    serverName: 'broken-mcp-server',
  },
};

/**
 * Server with incomplete implementation (missing server.connect() call)
 */
export const FIXTURE_INCOMPLETE_SERVER: GeneratedCode = {
  mainFile: `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: "incomplete-server",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [] };
});

// Missing server.connect(transport) call - server won't start
`,

  packageJson: JSON.stringify(
    {
      name: 'incomplete-mcp-server',
      version: '0.1.0',
      type: 'module',
      main: 'dist/index.js',
      scripts: {
        build: 'tsc',
        start: 'node dist/index.js',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '^0.5.0',
      },
      devDependencies: {
        '@types/node': '^20.0.0',
        typescript: '^5.0.0',
      },
    },
    null,
    2,
  ),

  tsConfig: JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'node',
        strict: true,
        skipLibCheck: true,
        outDir: './dist',
        rootDir: './src',
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  ),

  supportingFiles: {},

  metadata: {
    tools: [],
    iteration: 1,
    serverName: 'incomplete-mcp-server',
  },
};

/**
 * Test case: Verify fixture works correctly
 */
export async function validateFixtures() {
  const fixtures = [
    { name: 'FIXTURE_SIMPLE_WORKING_SERVER', fixture: FIXTURE_SIMPLE_WORKING_SERVER },
    { name: 'FIXTURE_HTTP_WORKING_SERVER', fixture: FIXTURE_HTTP_WORKING_SERVER },
    { name: 'FIXTURE_HTTP_INCOMPLETE_SERVER', fixture: FIXTURE_HTTP_INCOMPLETE_SERVER },
    { name: 'FIXTURE_BUILD_ERROR_SERVER', fixture: FIXTURE_BUILD_ERROR_SERVER },
    { name: 'FIXTURE_INCOMPLETE_SERVER', fixture: FIXTURE_INCOMPLETE_SERVER },
  ];

  for (const { name, fixture } of fixtures) {
    console.log(`Validating ${name}...`);

    // Check required fields
    if (!fixture.mainFile) throw new Error(`${name}: mainFile missing`);
    if (!fixture.packageJson) throw new Error(`${name}: packageJson missing`);
    if (!fixture.tsConfig) throw new Error(`${name}: tsConfig missing`);
    if (!fixture.metadata) throw new Error(`${name}: metadata missing`);
    if (typeof fixture.metadata.tools !== 'object') {
      throw new Error(`${name}: metadata.tools must be an array`);
    }

    // Verify JSON is valid
    try {
      JSON.parse(fixture.packageJson);
      JSON.parse(fixture.tsConfig);
    } catch (error) {
      throw new Error(`${name}: Invalid JSON in packageJson or tsConfig`);
    }

    console.log(`✓ ${name} is valid`);
  }

  console.log('All fixtures validated successfully');
}
