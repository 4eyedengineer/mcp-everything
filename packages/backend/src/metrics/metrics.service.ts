import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry: Registry;

  // Application Metrics
  private readonly generationTotal: Counter;
  private readonly generationDuration: Histogram;
  private readonly generationErrors: Counter;
  private readonly activeConversations: Gauge;
  private readonly apiRequestsTotal: Counter;
  private readonly apiLatency: Histogram;

  // Business Metrics
  private readonly usersTotal: Gauge;
  private readonly deploymentsTotal: Counter;
  private readonly marketplaceDownloads: Counter;

  constructor() {
    this.registry = new Registry();

    // Application Metrics
    this.generationTotal = new Counter({
      name: 'mcp_generation_total',
      help: 'Total number of MCP server generations',
      labelNames: ['status', 'source_type'],
      registers: [this.registry],
    });

    this.generationDuration = new Histogram({
      name: 'mcp_generation_duration_seconds',
      help: 'Duration of MCP server generation in seconds',
      labelNames: ['source_type'],
      buckets: [5, 10, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });

    this.generationErrors = new Counter({
      name: 'mcp_generation_errors_total',
      help: 'Total number of MCP server generation errors',
      labelNames: ['error_type', 'source_type'],
      registers: [this.registry],
    });

    this.activeConversations = new Gauge({
      name: 'mcp_active_conversations',
      help: 'Number of currently active conversations',
      registers: [this.registry],
    });

    this.apiRequestsTotal = new Counter({
      name: 'mcp_api_requests_total',
      help: 'Total number of API requests',
      labelNames: ['method', 'endpoint', 'status_code'],
      registers: [this.registry],
    });

    this.apiLatency = new Histogram({
      name: 'mcp_api_latency_seconds',
      help: 'API request latency in seconds',
      labelNames: ['method', 'endpoint'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // Business Metrics
    this.usersTotal = new Gauge({
      name: 'mcp_users_total',
      help: 'Total number of users by subscription tier',
      labelNames: ['tier'],
      registers: [this.registry],
    });

    this.deploymentsTotal = new Counter({
      name: 'mcp_deployments_total',
      help: 'Total number of MCP server deployments',
      labelNames: ['type', 'status'],
      registers: [this.registry],
    });

    this.marketplaceDownloads = new Counter({
      name: 'mcp_marketplace_downloads_total',
      help: 'Total number of marketplace downloads',
      labelNames: ['server_id', 'server_name'],
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    // Collect default Node.js metrics (CPU, memory, etc.)
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'mcp_',
    });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  async getContentType(): Promise<string> {
    return this.registry.contentType;
  }

  // Generation Metrics Methods
  recordGeneration(status: 'success' | 'failure', sourceType: string): void {
    this.generationTotal.inc({ status, source_type: sourceType });
  }

  startGenerationTimer(sourceType: string): () => void {
    return this.generationDuration.startTimer({ source_type: sourceType });
  }

  recordGenerationError(errorType: string, sourceType: string): void {
    this.generationErrors.inc({ error_type: errorType, source_type: sourceType });
  }

  // Conversation Metrics Methods
  incrementActiveConversations(): void {
    this.activeConversations.inc();
  }

  decrementActiveConversations(): void {
    this.activeConversations.dec();
  }

  setActiveConversations(count: number): void {
    this.activeConversations.set(count);
  }

  // API Metrics Methods
  recordApiRequest(
    method: string,
    endpoint: string,
    statusCode: number,
  ): void {
    this.apiRequestsTotal.inc({
      method,
      endpoint,
      status_code: statusCode.toString(),
    });
  }

  startApiTimer(method: string, endpoint: string): () => void {
    return this.apiLatency.startTimer({ method, endpoint });
  }

  // Business Metrics Methods
  setUserCount(tier: string, count: number): void {
    this.usersTotal.set({ tier }, count);
  }

  recordDeployment(type: string, status: 'success' | 'failure'): void {
    this.deploymentsTotal.inc({ type, status });
  }

  recordMarketplaceDownload(serverId: string, serverName: string): void {
    this.marketplaceDownloads.inc({ server_id: serverId, server_name: serverName });
  }
}
