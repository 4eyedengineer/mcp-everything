import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import {
  McpServerConfig,
  ServerDetailsResponse,
  UpdateServerRequest,
  ListServersRequest,
  API_ENDPOINTS,
  MCP_SERVER_STATUSES
} from '@mcp-everything/shared';

export interface ServerListItem {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sourceType: string;
  deploymentUrl?: string;
  tags: string[];
  toolsCount: number;
  resourcesCount: number;
}

export interface ServerMetrics {
  totalRequests: number;
  successfulRequests: number;
  errorRate: number;
  avgResponseTime: number;
  lastUsed?: string;
  usageToday: number;
  usageThisWeek: number;
  usageThisMonth: number;
}

@Injectable({
  providedIn: 'root'
})
export class McpServerService {
  constructor(private apiService: ApiService) {}

  /**
   * Get list of MCP servers
   */
  getServers(params?: ListServersRequest): Observable<{
    data: ServerListItem[];
    meta: any;
  }> {
    return this.apiService.getPaginated<ServerListItem>(
      API_ENDPOINTS.SERVERS.LIST,
      params
    );
  }

  /**
   * Get server details
   */
  getServerDetails(serverId: string): Observable<ServerDetailsResponse> {
    return this.apiService.get<ServerDetailsResponse>(
      API_ENDPOINTS.SERVERS.DETAILS.replace(':id', serverId)
    );
  }

  /**
   * Update server
   */
  updateServer(serverId: string, updates: UpdateServerRequest): Observable<McpServerConfig> {
    return this.apiService.put<McpServerConfig>(
      API_ENDPOINTS.SERVERS.UPDATE.replace(':id', serverId),
      updates
    );
  }

  /**
   * Delete server
   */
  deleteServer(serverId: string): Observable<void> {
    return this.apiService.delete<void>(
      API_ENDPOINTS.SERVERS.DELETE.replace(':id', serverId)
    );
  }

  /**
   * Deploy server
   */
  deployServer(
    serverId: string,
    deploymentConfig: {
      target: 'gist' | 'private-repo' | 'vercel' | 'cloud-run';
      settings?: Record<string, any>;
    }
  ): Observable<{
    deploymentId: string;
    url?: string;
    status: 'pending' | 'deploying' | 'success' | 'failed';
  }> {
    return this.apiService.post(
      API_ENDPOINTS.SERVERS.DEPLOY.replace(':id', serverId),
      deploymentConfig
    );
  }

  /**
   * Get server logs
   */
  getServerLogs(
    serverId: string,
    options?: {
      level?: 'info' | 'warn' | 'error';
      limit?: number;
      since?: Date;
    }
  ): Observable<Array<{
    timestamp: string;
    level: string;
    message: string;
    step?: string;
  }>> {
    return this.apiService.get(
      API_ENDPOINTS.SERVERS.LOGS.replace(':id', serverId),
      options
    );
  }

  /**
   * Get server metrics
   */
  getServerMetrics(
    serverId: string,
    timeRange: '1h' | '24h' | '7d' | '30d' = '24h'
  ): Observable<ServerMetrics> {
    return this.apiService.get(
      `${API_ENDPOINTS.SERVERS.DETAILS.replace(':id', serverId)}/metrics`,
      { timeRange }
    );
  }

  /**
   * Test server connection
   */
  testServer(serverId: string): Observable<{
    status: 'online' | 'offline' | 'error';
    responseTime?: number;
    lastChecked: string;
    error?: string;
    capabilities: {
      tools: string[];
      resources: string[];
    };
  }> {
    return this.apiService.post(
      `${API_ENDPOINTS.SERVERS.DETAILS.replace(':id', serverId)}/test`,
      {}
    );
  }

  /**
   * Clone server
   */
  cloneServer(serverId: string, newName: string): Observable<McpServerConfig> {
    return this.apiService.post(
      `${API_ENDPOINTS.SERVERS.DETAILS.replace(':id', serverId)}/clone`,
      { name: newName }
    );
  }

  /**
   * Archive server
   */
  archiveServer(serverId: string): Observable<void> {
    return this.apiService.post(
      `${API_ENDPOINTS.SERVERS.DETAILS.replace(':id', serverId)}/archive`,
      {}
    );
  }

  /**
   * Restore archived server
   */
  restoreServer(serverId: string): Observable<void> {
    return this.apiService.post(
      `${API_ENDPOINTS.SERVERS.DETAILS.replace(':id', serverId)}/restore`,
      {}
    );
  }

  /**
   * Get server configuration as downloadable file
   */
  downloadServerConfig(serverId: string, format: 'json' | 'yaml' = 'json'): Observable<Blob> {
    return this.apiService.downloadFile(
      `${API_ENDPOINTS.SERVERS.DETAILS.replace(':id', serverId)}/download?format=${format}`
    );
  }

  /**
   * Import server from configuration file
   */
  importServer(configFile: File): Observable<McpServerConfig> {
    return this.apiService.uploadFile<McpServerConfig>(
      `${API_ENDPOINTS.SERVERS.LIST}/import`,
      configFile
    );
  }

  /**
   * Search servers
   */
  searchServers(
    query: string,
    filters?: {
      status?: string[];
      sourceType?: string[];
      tags?: string[];
      dateRange?: {
        start: Date;
        end: Date;
      };
    }
  ): Observable<{
    data: ServerListItem[];
    meta: any;
  }> {
    return this.apiService.search<ServerListItem>(
      API_ENDPOINTS.SERVERS.LIST,
      {
        query,
        filters
      }
    );
  }

  /**
   * Get server statistics
   */
  getServerStatistics(): Observable<{
    total: number;
    active: number;
    error: number;
    archived: number;
    byStatus: Record<string, number>;
    bySourceType: Record<string, number>;
    byLanguage: Record<string, number>;
    recentActivity: Array<{
      date: string;
      created: number;
      deployed: number;
      errors: number;
    }>;
  }> {
    return this.apiService.get(`${API_ENDPOINTS.SERVERS.LIST}/stats`);
  }

  /**
   * Get available tags
   */
  getAvailableTags(): Observable<Array<{
    tag: string;
    count: number;
  }>> {
    return this.apiService.get(`${API_ENDPOINTS.SERVERS.LIST}/tags`);
  }

  /**
   * Bulk operations on servers
   */
  bulkOperation(
    operation: 'delete' | 'archive' | 'deploy' | 'tag',
    serverIds: string[],
    options?: any
  ): Observable<{
    success: string[];
    failed: Array<{
      id: string;
      error: string;
    }>;
  }> {
    return this.apiService.post(
      `${API_ENDPOINTS.SERVERS.LIST}/bulk`,
      {
        operation,
        serverIds,
        options
      }
    );
  }

  /**
   * Get server templates
   */
  getServerTemplates(): Observable<Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    language: string;
    features: string[];
    complexity: 'simple' | 'moderate' | 'complex';
    estimatedTime: number;
  }>> {
    return this.apiService.get(`${API_ENDPOINTS.SERVERS.LIST}/templates`);
  }

  /**
   * Create server from template
   */
  createFromTemplate(
    templateId: string,
    config: {
      name: string;
      description: string;
      customization?: Record<string, any>;
    }
  ): Observable<{
    serverId: string;
    generationId: string;
  }> {
    return this.apiService.post(
      `${API_ENDPOINTS.SERVERS.LIST}/from-template`,
      {
        templateId,
        ...config
      }
    );
  }

  /**
   * Get status display information
   */
  getStatusInfo(status: string): {
    label: string;
    color: string;
    icon: string;
    description: string;
  } {
    const statusMap: Record<string, any> = {
      [MCP_SERVER_STATUSES.DRAFT]: {
        label: 'Draft',
        color: 'default',
        icon: 'edit',
        description: 'Server configuration is being prepared'
      },
      [MCP_SERVER_STATUSES.GENERATING]: {
        label: 'Generating',
        color: 'primary',
        icon: 'autorenew',
        description: 'Code generation is in progress'
      },
      [MCP_SERVER_STATUSES.BUILDING]: {
        label: 'Building',
        color: 'accent',
        icon: 'build',
        description: 'Server is being compiled and packaged'
      },
      [MCP_SERVER_STATUSES.VALIDATING]: {
        label: 'Validating',
        color: 'accent',
        icon: 'check_circle',
        description: 'Running validation tests'
      },
      [MCP_SERVER_STATUSES.DEPLOYING]: {
        label: 'Deploying',
        color: 'accent',
        icon: 'cloud_upload',
        description: 'Server is being deployed'
      },
      [MCP_SERVER_STATUSES.ACTIVE]: {
        label: 'Active',
        color: 'primary',
        icon: 'check_circle',
        description: 'Server is running and available'
      },
      [MCP_SERVER_STATUSES.ERROR]: {
        label: 'Error',
        color: 'warn',
        icon: 'error',
        description: 'Server encountered an error'
      },
      [MCP_SERVER_STATUSES.ARCHIVED]: {
        label: 'Archived',
        color: 'default',
        icon: 'archive',
        description: 'Server has been archived'
      }
    };

    return statusMap[status] || {
      label: status,
      color: 'default',
      icon: 'help',
      description: 'Unknown status'
    };
  }

  /**
   * Get deployment options
   */
  getDeploymentOptions(): Array<{
    id: string;
    name: string;
    description: string;
    tier: 'free' | 'pro' | 'enterprise';
    features: string[];
    limitations?: string[];
    estimatedCost?: string;
  }> {
    return [
      {
        id: 'gist',
        name: 'GitHub Gist',
        description: 'Deploy as a public GitHub Gist',
        tier: 'free',
        features: [
          'Free hosting',
          'Version control',
          'Public access',
          'Easy sharing'
        ],
        limitations: [
          'Public only',
          'No custom domain',
          'Limited to 1MB'
        ],
        estimatedCost: 'Free'
      },
      {
        id: 'private-repo',
        name: 'Private Repository',
        description: 'Deploy to a private GitHub repository',
        tier: 'pro',
        features: [
          'Private hosting',
          'Full Git features',
          'Team collaboration',
          'CI/CD integration'
        ],
        limitations: [
          'Requires GitHub Pro',
          'Manual setup required'
        ],
        estimatedCost: '$4/month'
      },
      {
        id: 'vercel',
        name: 'Vercel Functions',
        description: 'Deploy as serverless functions on Vercel',
        tier: 'pro',
        features: [
          'Serverless execution',
          'Auto-scaling',
          'Global CDN',
          'Custom domains'
        ],
        limitations: [
          '10GB bandwidth limit',
          '10 second timeout'
        ],
        estimatedCost: '$20/month'
      },
      {
        id: 'cloud-run',
        name: 'Google Cloud Run',
        description: 'Deploy as containerized service on GCP',
        tier: 'enterprise',
        features: [
          'Full container support',
          'Auto-scaling',
          'Custom networking',
          'Enterprise security'
        ],
        limitations: [
          'Requires GCP account',
          'More complex setup'
        ],
        estimatedCost: 'Pay per use'
      }
    ];
  }
}