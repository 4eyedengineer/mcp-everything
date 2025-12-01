import { Injectable } from '@angular/core';
import { Observable, interval, timer } from 'rxjs';
import { takeUntil, takeWhile, switchMap, startWith } from 'rxjs/operators';
import { ApiService } from './api.service';
import {
  GenerateServerRequest,
  GenerateServerResponse,
  GenerationStatusResponse,
  McpServerGeneration,
  API_ENDPOINTS,
  GENERATION_STATUSES
} from '@mcp-everything/shared';

export interface GenerationProgress {
  id: string;
  status: string;
  progress: number;
  currentStep: string;
  logs: Array<{
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    message: string;
  }>;
  result?: any;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class McpGenerationService {
  private readonly POLL_INTERVAL = 2000; // 2 seconds
  private readonly MAX_POLL_DURATION = 900000; // 15 minutes

  constructor(private apiService: ApiService) {}

  /**
   * Start MCP server generation
   */
  generateServer(request: GenerateServerRequest): Observable<GenerateServerResponse> {
    return this.apiService.post<GenerateServerResponse>(
      API_ENDPOINTS.GENERATION.GENERATE,
      request
    );
  }

  /**
   * Get generation status
   */
  getGenerationStatus(generationId: string): Observable<GenerationStatusResponse> {
    return this.apiService.get<GenerationStatusResponse>(
      API_ENDPOINTS.GENERATION.STATUS.replace(':id', generationId)
    );
  }

  /**
   * Monitor generation progress with polling
   */
  monitorGeneration(generationId: string): Observable<GenerationProgress> {
    const maxTime = timer(this.MAX_POLL_DURATION);

    return interval(this.POLL_INTERVAL).pipe(
      startWith(0), // Start immediately
      takeUntil(maxTime),
      switchMap(() => this.getGenerationStatus(generationId)),
      takeWhile(
        (status) =>
          status.status !== GENERATION_STATUSES.COMPLETED &&
          status.status !== GENERATION_STATUSES.FAILED,
        true // Include the final status
      )
    );
  }

  /**
   * Get generation history
   */
  getGenerationHistory(
    page: number = 1,
    limit: number = 20,
    filters?: {
      status?: string;
      sourceType?: string;
      dateFrom?: Date;
      dateTo?: Date;
    }
  ): Observable<{
    data: McpServerGeneration[];
    meta: any;
  }> {
    const params = {
      page,
      limit,
      ...filters
    };

    return this.apiService.getPaginated<McpServerGeneration>(
      API_ENDPOINTS.GENERATION.HISTORY,
      params
    );
  }

  /**
   * Cancel generation
   */
  cancelGeneration(generationId: string): Observable<any> {
    return this.apiService.post(
      `${API_ENDPOINTS.GENERATION.STATUS.replace(':id', generationId)}/cancel`,
      {}
    );
  }

  /**
   * Retry failed generation
   */
  retryGeneration(generationId: string): Observable<GenerateServerResponse> {
    return this.apiService.post<GenerateServerResponse>(
      `${API_ENDPOINTS.GENERATION.STATUS.replace(':id', generationId)}/retry`,
      {}
    );
  }

  /**
   * Get generation logs
   */
  getGenerationLogs(
    generationId: string,
    level?: 'info' | 'warn' | 'error',
    limit?: number
  ): Observable<Array<{
    timestamp: string;
    level: string;
    message: string;
    step?: string;
  }>> {
    const params: any = {};
    if (level) params.level = level;
    if (limit) params.limit = limit;

    return this.apiService.get(
      `${API_ENDPOINTS.GENERATION.STATUS.replace(':id', generationId)}/logs`,
      params
    );
  }

  /**
   * Get generation statistics
   */
  getGenerationStats(): Observable<{
    total: number;
    completed: number;
    failed: number;
    active: number;
    avgGenerationTime: number;
    successRate: number;
    popularSourceTypes: Array<{ type: string; count: number }>;
    popularLanguages: Array<{ language: string; count: number }>;
  }> {
    return this.apiService.get(`${API_ENDPOINTS.GENERATION.HISTORY}/stats`);
  }

  /**
   * Validate generation request
   */
  validateGenerationRequest(request: GenerateServerRequest): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate source type and input
    if (!request.sourceType) {
      errors.push('Source type is required');
    }

    if (!request.input) {
      errors.push('Source input is required');
    }

    // Validate GitHub input
    if (request.sourceType === 'github' && typeof request.input === 'string') {
      const urlPattern = /^https?:\/\/github\.com\/[^\/]+\/[^\/]+/;
      if (!urlPattern.test(request.input)) {
        errors.push('Invalid GitHub repository URL');
      }
    }

    // Validate API spec input
    if (request.sourceType === 'api-spec' && typeof request.input === 'object') {
      const apiSpec = request.input as any;
      if (!apiSpec.type || !apiSpec.content) {
        errors.push('API specification must include type and content');
      }
    }

    // Validate description input
    if (request.sourceType === 'description' && typeof request.input === 'string') {
      if (request.input.length < 50) {
        warnings.push('Description is quite short - consider providing more details');
      }
      if (request.input.length > 5000) {
        warnings.push('Description is very long - consider summarizing key points');
      }
    }

    // Validate options
    if (!request.options) {
      warnings.push('No generation options specified - using defaults');
    } else {
      if (!['typescript', 'python', 'go'].includes(request.options.targetLanguage)) {
        errors.push('Invalid target language');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Get generation templates
   */
  getGenerationTemplates(): Observable<Array<{
    id: string;
    name: string;
    description: string;
    sourceType: string;
    language: string;
    features: string[];
    example?: any;
  }>> {
    return this.apiService.get(`${API_ENDPOINTS.GENERATION.GENERATE}/templates`);
  }

  /**
   * Estimate generation time
   */
  estimateGenerationTime(request: GenerateServerRequest): Observable<{
    estimatedMinutes: number;
    factors: string[];
    complexity: 'simple' | 'moderate' | 'complex';
  }> {
    return this.apiService.post(
      `${API_ENDPOINTS.GENERATION.GENERATE}/estimate`,
      request
    );
  }

  /**
   * Get supported languages and their capabilities
   */
  getSupportedLanguages(): Observable<Array<{
    language: string;
    displayName: string;
    description: string;
    features: string[];
    maturity: 'stable' | 'beta' | 'experimental';
    examples: string[];
  }>> {
    return this.apiService.get(`${API_ENDPOINTS.GENERATION.GENERATE}/languages`);
  }

  /**
   * Preview generation (dry run)
   */
  previewGeneration(request: GenerateServerRequest): Observable<{
    structure: {
      files: Array<{
        path: string;
        type: 'typescript' | 'json' | 'markdown' | 'yaml';
        size: number;
        description: string;
      }>;
      tools: Array<{
        name: string;
        description: string;
        complexity: 'simple' | 'moderate' | 'complex';
      }>;
      resources: Array<{
        name: string;
        description: string;
        type: string;
      }>;
    };
    estimatedTime: number;
    warnings: string[];
  }> {
    return this.apiService.post(
      `${API_ENDPOINTS.GENERATION.GENERATE}/preview`,
      request
    );
  }

  /**
   * Get generation best practices
   */
  getBestPractices(): Array<{
    category: string;
    title: string;
    description: string;
    importance: 'high' | 'medium' | 'low';
  }> {
    return [
      {
        category: 'GitHub Repository',
        title: 'Use repositories with clear API structure',
        description: 'Repositories with well-documented API endpoints or clear function exports generate better MCP servers.',
        importance: 'high'
      },
      {
        category: 'GitHub Repository',
        title: 'Prefer actively maintained repositories',
        description: 'Recently updated repositories are more likely to generate working MCP servers.',
        importance: 'medium'
      },
      {
        category: 'Description',
        title: 'Provide specific, actionable descriptions',
        description: 'Instead of "social media tool", use "tool to post tweets and get user timelines from Twitter API".',
        importance: 'high'
      },
      {
        category: 'Description',
        title: 'Include expected inputs and outputs',
        description: 'Specify what data the tools should accept and what they should return.',
        importance: 'high'
      },
      {
        category: 'API Specification',
        title: 'Use complete OpenAPI specifications',
        description: 'Complete specs with examples and descriptions generate more functional MCP servers.',
        importance: 'high'
      },
      {
        category: 'Options',
        title: 'Enable tests for production use',
        description: 'Generated tests help ensure your MCP server works correctly.',
        importance: 'medium'
      },
      {
        category: 'Options',
        title: 'Include documentation for sharing',
        description: 'Auto-generated documentation makes your MCP server easier for others to use.',
        importance: 'medium'
      }
    ];
  }
}