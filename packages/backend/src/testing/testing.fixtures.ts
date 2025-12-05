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
