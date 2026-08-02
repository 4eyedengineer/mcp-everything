import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Controller, Get } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard, SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { Public } from './auth/decorators/public.decorator';
import { GitHubAnalysisService } from './github-analysis.service';
import { AiModule } from './ai/ai.module';
import { ChatModule } from './chat/chat.module';
import { DeploymentModule } from './deployment/deployment.module';
import { ValidationModule } from './validation/validation.module';
import { UserModule } from './user/user.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { HostingModule } from './hosting/hosting.module';
import { EmailModule } from './email/email.module';
import { LoggingModule } from './logging/logging.module';
import { AuthModule } from './auth/auth.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { ApiKeyModule } from './api-key/api-key.module';
import { UsageStatsModule } from './usage-stats/usage-stats.module';
import { GitHubModule } from './github/github.module';
import { McpServerModule } from './mcp-server/mcp-server.module';
import { MyServersModule } from './my-servers/my-servers.module';
import {
  Conversation,
  PipelineRun,
  Deployment,
  User,
  Subscription,
  UsageRecord,
  HostedServer,
  HostedServerApiKey,
  ErrorLog,
  McpServer,
  ApiKey,
} from './database/entities';

/**
 * Root controller.
 *
 * NOTE: The previous unauthenticated debug endpoints (POST /chat, /analyze,
 * /discover-tools, /generate-mcp, /generate) were removed - they exposed
 * unmetered Anthropic + GitHub spend to anonymous callers. Use the
 * authenticated /api/chat/* endpoints instead.
 */
@Controller()
export class AppController {
  @Public()
  @SkipThrottle()
  @Get()
  getHello(): string {
    return 'MCP Everything Backend is running!';
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
      entities: [
        Conversation,
        PipelineRun,
        Deployment,
        User,
        Subscription,
        UsageRecord,
        HostedServer,
        HostedServerApiKey,
        ErrorLog,
        McpServer,
        ApiKey,
      ],
      synchronize: process.env.NODE_ENV !== 'production', // Auto-sync in development
      logging: process.env.NODE_ENV === 'development',
    }),
    TypeOrmModule.forFeature([Conversation, PipelineRun, Deployment]),
    // Global rate limiting defaults (ThrottlerModule is @Global()).
    // Stricter route/controller level limits are applied with @Throttle(),
    // and @SkipThrottle() is used for SSE/health/metrics endpoints.
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1 minute
        limit: 100, // 100 requests per minute per IP
      },
    ]),
    LoggingModule, // Global error logging - must be early for filter availability
    MetricsModule, // Global metrics - AiModule records token/cost counters into it
    AiModule, // Global Anthropic seam - single configured Claude client
    ChatModule,
    DeploymentModule,
    ValidationModule,
    UserModule,
    SubscriptionModule,
    HostingModule,
    EmailModule,
    AuthModule,
    MarketplaceModule,
    HealthModule,
    ApiKeyModule,
    UsageStatsModule,
    GitHubModule,
    McpServerModule,
    MyServersModule,
  ],
  controllers: [AppController],
  providers: [
    // Global rate limiting guard - runs before authentication so unauthenticated
    // floods are cheap to reject. Use @SkipThrottle() / @Throttle() to adjust.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Global JWT authentication guard - protects all routes by default
    // Use @Public() decorator to make specific routes accessible without authentication
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    GitHubAnalysisService,
  ],
})
export class AppModule {}
