import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

// Simple controller for basic testing
import { Controller, Get, Post, Body, Injectable, Logger } from '@nestjs/common';
import { IsString, IsUrl, IsOptional } from 'class-validator';
import { ConversationService } from './conversation.service';
import { GitHubAnalysisService } from './github-analysis.service';
import { ToolDiscoveryService } from './tool-discovery.service';
import { McpGenerationService } from './mcp-generation.service';
import { ChatModule } from './chat/chat.module';
import { DeploymentModule } from './deployment/deployment.module';
import { ValidationModule } from './validation/validation.module';
import { UserModule } from './user/user.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { HostingModule } from './hosting/hosting.module';
import { Conversation, ConversationMemory, Deployment, User, Subscription, UsageRecord, HostedServer } from './database/entities';

// Basic DTO for generate endpoint
export class GenerateServerDto {
  @IsString()
  @IsUrl()
  githubUrl: string;
}

// DTO for conversational chat endpoint
export class ChatDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  conversationId?: string;
}

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly gitHubAnalysisService: GitHubAnalysisService,
    private readonly conversationService: ConversationService,
    private readonly toolDiscoveryService: ToolDiscoveryService,
    private readonly mcpGenerationService: McpGenerationService
  ) {}

  @Get()
  getHello(): string {
    return 'MCP Everything Backend is running!';
  }

  @Get('health')
  getHealth(): object {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'mcp-everything-backend'
    };
  }

  @Post('chat')
  async chat(@Body() chatDto: ChatDto): Promise<object> {
    try {
      return await this.conversationService.processConversation(
        chatDto.message,
        chatDto.conversationId
      );
    } catch (error) {
      this.logger.error(`Chat processing failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  @Post('analyze')
  async analyzeRepository(@Body() generateDto: GenerateServerDto): Promise<object> {
    try {
      const analysis = await this.gitHubAnalysisService.analyzeRepository(generateDto.githubUrl);
      return {
        success: true,
        analysis
      };
    } catch (error) {
      this.logger.error(`Repository analysis failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  @Post('discover-tools')
  async discoverTools(@Body() generateDto: GenerateServerDto): Promise<object> {
    try {
      // First analyze the repository
      const analysis = await this.gitHubAnalysisService.analyzeRepository(generateDto.githubUrl);

      // Then discover tools using AI
      const toolDiscoveryResult = await this.toolDiscoveryService.discoverTools(analysis);

      return {
        success: true,
        repository: {
          name: analysis.metadata.name,
          fullName: analysis.metadata.fullName,
          description: analysis.metadata.description,
          url: generateDto.githubUrl
        },
        toolDiscovery: toolDiscoveryResult
      };
    } catch (error) {
      this.logger.error(`Tool discovery failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  @Post('generate-mcp')
  async generateMcpServer(@Body() generateDto: GenerateServerDto): Promise<object> {
    try {
      const server = await this.mcpGenerationService.generateMCPServer(generateDto.githubUrl);
      return {
        success: true,
        server
      };
    } catch (error) {
      this.logger.error(`MCP server generation failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  @Post('generate')
  async generateMcpServerSimple(@Body() generateDto: GenerateServerDto): Promise<object> {
    // Simple template-based generation for testing
    try {
      const analysis = await this.gitHubAnalysisService.analyzeRepository(generateDto.githubUrl);

      const serverName = `${analysis.metadata.name}-mcp-server`;
      const description = analysis.metadata.description
        ? `MCP Server for ${analysis.metadata.fullName}: ${analysis.metadata.description}`
        : `MCP Server generated from ${analysis.metadata.fullName}`;

      return {
        success: true,
        repository: {
          name: analysis.metadata.name,
          fullName: analysis.metadata.fullName,
          description: analysis.metadata.description,
          language: analysis.metadata.language,
          url: generateDto.githubUrl,
        },
        server: {
          name: serverName,
          githubUrl: generateDto.githubUrl,
          description,
          files: [
            {
              path: 'src/index.ts',
              content: `#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: '${serverName}',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'hello',
        description: 'Say hello from ${analysis.metadata.fullName}',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name to greet',
            },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'hello':
      const nameArg = args?.name || 'World';
      return {
        content: [
          {
            type: 'text',
            text: \`Hello \${nameArg} from ${analysis.metadata.fullName}!\`,
          },
        ],
      };
    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        \`Unknown tool: \${name}\`
      );
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('${serverName} running on stdio');
}

main().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});`
            },
            {
              path: 'package.json',
              content: JSON.stringify({
                name: serverName,
                version: '0.1.0',
                description: description,
                type: 'module',
                main: 'dist/index.js',
                scripts: {
                  build: 'tsc',
                  start: 'node dist/index.js',
                  dev: 'tsc --watch'
                },
                dependencies: {
                  '@modelcontextprotocol/sdk': '^0.5.0'
                },
                devDependencies: {
                  '@types/node': '^20.0.0',
                  'typescript': '^5.0.0'
                }
              }, null, 2)
            }
          ]
        }
      };
    } catch (error) {
      this.logger.error(`Simple generation failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432', 10),
      username: process.env.DATABASE_USER || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'mcp_everything',
      entities: [Conversation, ConversationMemory, Deployment, User, Subscription, UsageRecord, HostedServer],
      synchronize: process.env.NODE_ENV !== 'production', // Auto-sync in development
      logging: process.env.NODE_ENV === 'development',
    }),
    TypeOrmModule.forFeature([Conversation, ConversationMemory, Deployment]),
    ChatModule,
    DeploymentModule,
    ValidationModule,
    UserModule,
    SubscriptionModule,
    HostingModule,
  ],
  controllers: [AppController],
  providers: [
    GitHubAnalysisService,
    ConversationService,
    ToolDiscoveryService,
    McpGenerationService
  ],
})
export class AppModule {}