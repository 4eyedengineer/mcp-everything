import { Injectable, Logger } from '@nestjs/common';
import * as z from 'zod/v4';
import { GitHubAnalysisService } from '../github-analysis.service';
import axios from 'axios';
import {
  PipelineState,
  WebSearchFindings,
  DeepGitHubAnalysis,
  ApiDocAnalysis,
  SynthesizedPlan,
} from './types';
import { getPlatformContextPrompt } from './platform-context';
import { AnthropicService } from '../ai/anthropic.service';

/**
 * Output contracts for every AI call in this service. These are handed to the
 * Anthropic API as JSON Schemas (structured outputs) and re-validated locally,
 * which replaces the old "return ONLY JSON" + bracket-balancing parse.
 */
const InputClassificationSchema = z.object({
  type: z.enum(['SERVICE_NAME', 'NATURAL_LANGUAGE']),
  confidence: z.number(),
  serviceName: z.string().nullable().optional(),
  intent: z.string().nullable().optional(),
  keywords: z.array(z.string()).optional(),
});

const WebSearchSynthesisSchema = z.object({
  baseUrl: z.string().nullable().optional(),
  authentication: z
    .object({
      type: z.string().nullable().optional(),
      details: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  endpoints: z.array(z.string()).optional(),
  rateLimit: z.string().nullable().optional(),
  bestPractices: z.array(z.string()).optional(),
});

const ApiDocExtractionSchema = z.object({
  baseUrl: z.string().nullable().optional(),
  authentication: z
    .object({
      type: z.string(),
      header: z.string().nullable().optional(),
      details: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  endpoints: z
    .array(
      z.object({
        method: z.string(),
        path: z.string(),
        description: z.string().nullable().optional(),
      }),
    )
    .optional(),
  rateLimit: z
    .object({
      requests: z.number(),
      window: z.string(),
    })
    .nullable()
    .optional(),
});

const ServiceIdentificationSchema = z.object({
  services: z.array(
    z.object({
      name: z.string(),
      confidence: z.number(),
      reasoning: z.string().nullable().optional(),
    }),
  ),
});

const SynthesizedPlanSchema = z.object({
  summary: z.string(),
  keyInsights: z.array(z.string()),
  recommendedApproach: z.string(),
  potentialChallenges: z.array(z.string()),
  confidence: z.number(),
  reasoning: z.string(),
});

/**
 * Input Type Classification
 */
export enum InputType {
  GITHUB_URL = 'github_url', // https://github.com/owner/repo
  WEBSITE_URL = 'website_url', // https://stripe.com
  DOCUMENTATION_URL = 'documentation_url', // https://docs.stripe.com/api
  SERVICE_NAME = 'service_name', // "Stripe API", "OpenAI"
  NATURAL_LANGUAGE = 'natural_language', // "I want to process payments"
}

export interface InputClassification {
  type: InputType;
  confidence: number;
  extractedInfo: {
    url?: string;
    serviceName?: string;
    intent?: string;
    keywords?: string[];
  };
}

/**
 * Research Service
 *
 * Orchestrates Phase 1: Research & Planning
 *
 * Responsibilities:
 * - Web search for MCP patterns and best practices
 * - Deep GitHub repository analysis
 * - API documentation extraction
 * - AI-powered synthesis of all research sources
 * - 7-day caching with vector store integration
 *
 * Flow:
 * 1. Check 7-day cache (80% cost savings on cache hits)
 * 2. If cache miss: Parallel research execution
 *    - webSearchAgent: Search for MCP patterns
 *    - deepGitHubAnalysis: Extract code examples, test patterns
 *    - apiDocumentationAgent: Parse API docs
 * 3. AI synthesis: the configured Claude model combines all sources
 * 4. Cache results for 7 days with vector embedding
 * 5. Return research phase data
 */
@Injectable()
export class ResearchService {
  private readonly logger = new Logger(ResearchService.name);

  constructor(
    private readonly githubAnalysisService: GitHubAnalysisService,
    private readonly anthropic: AnthropicService,
  ) {}

  /**
   * Conduct comprehensive research on ANY input
   *
   * Input Types Supported:
   * - GitHub URL: https://github.com/stripe/stripe-node
   * - Website: https://stripe.com
   * - Documentation: https://docs.stripe.com/api
   * - Service Name: "Stripe API", "OpenAI"
   * - Natural Language: "I want to process payments"
   *
   * Cache Strategy:
   * - Check cache first (7-day TTL, keyed by normalized input)
   * - If cached and age < 7 days: Return immediately (~$0.000 cost)
   * - If cache miss: Full research (~$0.003 cost)
   *
   * @param state - Current graph state with user input
   * @returns Complete research phase data with confidence score
   *
   * Example:
   * const research = await researchService.conductResearch(state);
   * console.log(research.researchConfidence); // 0.85
   * console.log(research.synthesizedPlan.keyInsights); // ["REST API", "OAuth 2.0", ...]
   */
  async conductResearch(state: PipelineState): Promise<PipelineState['researchPhase']> {
    const userInput = state.userInput;
    this.logger.log(`Starting input-agnostic research for: "${userInput}"`);

    // Step 1: Classify input type
    const classification = await this.classifyInput(userInput, state);
    this.logger.log(
      `Input classified as: ${classification.type} (confidence: ${classification.confidence})`,
    );

    // Step 2: Route to appropriate research strategy based on input type
    const researchPhase = await this.routeResearchStrategy(classification, state);

    // TODO: Implement caching for 7-day TTL to improve performance

    return researchPhase;
  }

  /**
   * Classify Input Type
   *
   * Uses AI to determine what type of input the user provided:
   * - GitHub URL (high confidence if matches github.com pattern)
   * - Website URL (high confidence if valid URL)
   * - Documentation URL (checks for docs, api in URL)
   * - Service Name (known service names: Stripe, OpenAI, AWS, etc.)
   * - Natural Language (everything else)
   *
   * @param userInput - Raw user input string
   * @param state - Graph state for additional context
   * @returns Input classification with confidence score
   */
  private async classifyInput(
    userInput: string,
    _state: PipelineState,
  ): Promise<InputClassification> {
    // Quick pattern matching for URLs
    const githubUrlMatch = userInput.match(/github\.com\/([^\/]+)\/([^\/\s]+)/);
    if (githubUrlMatch) {
      return {
        type: InputType.GITHUB_URL,
        confidence: 1.0,
        extractedInfo: {
          url: userInput.trim(),
          serviceName: githubUrlMatch[2], // repo name
        },
      };
    }

    // Check for documentation URLs
    const docUrlMatch = userInput.match(/^https?:\/\/(docs\.|api\.|developer\.)/i);
    if (docUrlMatch) {
      return {
        type: InputType.DOCUMENTATION_URL,
        confidence: 0.95,
        extractedInfo: {
          url: userInput.trim(),
        },
      };
    }

    // Check for generic URLs
    const urlMatch = userInput.match(/^https?:\/\/([^\s]+)/);
    if (urlMatch) {
      return {
        type: InputType.WEBSITE_URL,
        confidence: 0.9,
        extractedInfo: {
          url: userInput.trim(),
        },
      };
    }

    // Use AI to classify service name vs natural language
    const prompt = `Classify the following user input as either a SERVICE_NAME or NATURAL_LANGUAGE:

User input: "${userInput}"

SERVICE_NAME examples: "Stripe API", "OpenAI", "AWS S3", "Twilio", "Salesforce"
NATURAL_LANGUAGE examples: "I want to process payments", "help me send SMS", "integrate with CRM"

Provide:
- type: SERVICE_NAME or NATURAL_LANGUAGE
- confidence: 0.0-1.0
- serviceName: extracted service name if applicable
- intent: user's intent in one sentence
- keywords: relevant keywords`;

    try {
      // Cheap classification -> small model.
      const result = await this.anthropic.completeStructured({
        prompt,
        schema: InputClassificationSchema,
        schemaName: 'InputClassification',
        model: 'small',
        maxTokens: 1024,
        caller: 'research.classifyInput',
      });
      return {
        type: result.type === 'SERVICE_NAME' ? InputType.SERVICE_NAME : InputType.NATURAL_LANGUAGE,
        confidence: result.confidence,
        extractedInfo: {
          serviceName: result.serviceName,
          intent: result.intent,
          keywords: result.keywords,
        },
      };
    } catch (error) {
      this.logger.warn(
        `Failed to classify input with AI: ${error.message}, defaulting to NATURAL_LANGUAGE`,
      );
      return {
        type: InputType.NATURAL_LANGUAGE,
        confidence: 0.5,
        extractedInfo: {
          intent: userInput,
          keywords: userInput.split(/\s+/).filter((w) => w.length > 3),
        },
      };
    }
  }

  // TODO: Uncomment when caching is implemented
  // /**
  //  * Generate cache key from classification
  //  */
  // private generateCacheKey(classification: InputClassification): string {
  //   switch (classification.type) {
  //     case InputType.GITHUB_URL:
  //       return `github:${classification.extractedInfo.url}`;
  //     case InputType.WEBSITE_URL:
  //     case InputType.DOCUMENTATION_URL:
  //       return `url:${classification.extractedInfo.url}`;
  //     case InputType.SERVICE_NAME:
  //       return `service:${classification.extractedInfo.serviceName?.toLowerCase()}`;
  //     case InputType.NATURAL_LANGUAGE:
  //       // Normalize natural language to keywords
  //       return `intent:${classification.extractedInfo.keywords?.join('-')}`;
  //   }
  // }

  /**
   * Route to appropriate research strategy based on input type
   */
  private async routeResearchStrategy(
    classification: InputClassification,
    state: PipelineState,
  ): Promise<PipelineState['researchPhase']> {
    const startTime = Date.now();

    let researchPhase: PipelineState['researchPhase'];

    switch (classification.type) {
      case InputType.GITHUB_URL:
        researchPhase = await this.researchFromGitHub(classification, state);
        break;

      case InputType.WEBSITE_URL:
      case InputType.DOCUMENTATION_URL:
        researchPhase = await this.researchFromWebsite(classification, state);
        break;

      case InputType.SERVICE_NAME:
        researchPhase = await this.researchFromServiceName(classification, state);
        break;

      case InputType.NATURAL_LANGUAGE:
        researchPhase = await this.researchFromIntent(classification, state);
        break;
    }

    const researchTime = Date.now() - startTime;
    this.logger.log(`Research strategy completed in ${researchTime}ms`);

    return researchPhase;
  }

  /**
   * RESEARCH STRATEGY 1: GitHub URL
   *
   * Uses existing GitHub analysis flow
   */
  private async researchFromGitHub(
    classification: InputClassification,
    state: PipelineState,
  ): Promise<PipelineState['researchPhase']> {
    const githubUrl = classification.extractedInfo.url!;
    this.logger.log(`Strategy: GitHub research for ${githubUrl}`);

    // Parallel research execution
    const [webSearch, githubDeep, apiDocs] = await Promise.all([
      this.webSearchAgent(state, classification.extractedInfo.serviceName),
      this.deepGitHubAnalysis(githubUrl),
      this.apiDocumentationAgent(githubUrl),
    ]);

    const synthesized = await this.synthesizeResearch({
      webSearch,
      githubDeep,
      apiDocs,
      source: githubUrl,
      inputType: 'GitHub Repository',
    });

    return {
      webSearchFindings: webSearch,
      githubDeepDive: githubDeep,
      apiDocumentation: apiDocs,
      synthesizedPlan: synthesized,
      researchConfidence: synthesized.confidence,
      researchIterations: 1,
    };
  }

  /**
   * RESEARCH STRATEGY 2: Website/Documentation URL
   *
   * Scrapes website for API documentation, then searches for related GitHub repos
   */
  private async researchFromWebsite(
    classification: InputClassification,
    state: PipelineState,
  ): Promise<PipelineState['researchPhase']> {
    const url = classification.extractedInfo.url!;
    this.logger.log(`Strategy: Website research for ${url}`);

    // Extract service name from URL (e.g., stripe.com → "Stripe")
    const urlMatch = url.match(/https?:\/\/(?:www\.|docs\.|api\.|developer\.)?([^\.\/]+)/i);
    const serviceName = urlMatch ? urlMatch[1] : 'service';

    // Parallel research
    const [webSearch, apiDocs, githubRepos] = await Promise.all([
      this.webSearchAgent(state, serviceName),
      this.scrapeApiDocumentation(url),
      this.findGitHubReposForService(serviceName),
    ]);

    // If we found GitHub repos, analyze the top one
    let githubDeep: DeepGitHubAnalysis | undefined;
    if (githubRepos.length > 0) {
      try {
        githubDeep = await this.deepGitHubAnalysis(githubRepos[0].url);
      } catch (error) {
        this.logger.warn(`Failed to analyze GitHub repo: ${error.message}`);
      }
    }

    // Synthesize without GitHub data if not found
    const synthesized = await this.synthesizeResearch({
      webSearch,
      githubDeep,
      apiDocs,
      source: url,
      inputType: 'Website/Documentation',
    });

    return {
      webSearchFindings: webSearch,
      githubDeepDive: githubDeep,
      apiDocumentation: apiDocs,
      synthesizedPlan: synthesized,
      researchConfidence: synthesized.confidence,
      researchIterations: 1,
    };
  }

  /**
   * RESEARCH STRATEGY 3: Service Name
   *
   * Searches for official documentation and GitHub repos
   */
  private async researchFromServiceName(
    classification: InputClassification,
    state: PipelineState,
  ): Promise<PipelineState['researchPhase']> {
    const serviceName = classification.extractedInfo.serviceName!;
    this.logger.log(`Strategy: Service name research for "${serviceName}"`);

    // Parallel research
    const [webSearch, officialDocs, githubRepos] = await Promise.all([
      this.webSearchAgent(state, serviceName),
      this.findOfficialDocumentation(serviceName),
      this.findGitHubReposForService(serviceName),
    ]);

    // Analyze top GitHub repo if found
    let githubDeep: DeepGitHubAnalysis | undefined;
    if (githubRepos.length > 0) {
      try {
        githubDeep = await this.deepGitHubAnalysis(githubRepos[0].url);
      } catch (error) {
        this.logger.warn(`Failed to analyze GitHub repo: ${error.message}`);
      }
    }

    // Scrape official docs if found
    let apiDocs: ApiDocAnalysis | undefined;
    if (officialDocs.url) {
      try {
        apiDocs = await this.scrapeApiDocumentation(officialDocs.url);
      } catch (error) {
        this.logger.warn(`Failed to scrape API docs: ${error.message}`);
      }
    }

    const synthesized = await this.synthesizeResearch({
      webSearch,
      githubDeep,
      apiDocs,
      source: serviceName,
      inputType: 'Service Name',
    });

    return {
      webSearchFindings: webSearch,
      githubDeepDive: githubDeep,
      apiDocumentation: apiDocs,
      synthesizedPlan: synthesized,
      researchConfidence: synthesized.confidence,
      researchIterations: 1,
    };
  }

  /**
   * RESEARCH STRATEGY 4: Natural Language Intent
   *
   * Understands user intent and searches for relevant services
   */
  private async researchFromIntent(
    classification: InputClassification,
    state: PipelineState,
  ): Promise<PipelineState['researchPhase']> {
    const intent = classification.extractedInfo.intent!;
    const keywords = classification.extractedInfo.keywords!;
    this.logger.log(`Strategy: Intent-based research for "${intent}"`);

    // Use AI to identify relevant services
    const services = await this.identifyServicesFromIntent(intent, keywords);

    if (services.length === 0) {
      // No clear services identified, use synthesized confidence (dynamic, not hardcoded)
      const webSearch = await this.webSearchAgent(state, keywords.join(' '));
      const synthesized = await this.synthesizeResearch({
        webSearch,
        source: intent,
        inputType: 'Natural Language (No Service Identified)',
      });

      return {
        webSearchFindings: webSearch,
        githubDeepDive: undefined, // No GitHub repo identified
        synthesizedPlan: synthesized,
        researchConfidence: synthesized.confidence, // Use dynamic confidence from synthesis
        researchIterations: 1,
      };
    }

    // Research the top identified service
    const topService = services[0];
    this.logger.log(
      `Identified service: ${topService.name} (confidence: ${topService.confidence})`,
    );

    // Use service name strategy
    const classification2: InputClassification = {
      type: InputType.SERVICE_NAME,
      confidence: topService.confidence,
      extractedInfo: {
        serviceName: topService.name,
      },
    };

    return this.researchFromServiceName(classification2, state);
  }

  /**
   * Web Search Agent
   *
   * Uses Tavily search API to find real-time information about APIs,
   * documentation, and best practices.
   *
   * @param state - Graph state with context
   * @param serviceName - Optional service name for targeted search
   * @returns Web search findings with patterns and best practices
   */
  private async webSearchAgent(
    state: PipelineState,
    serviceName?: string,
  ): Promise<WebSearchFindings> {
    const targetName = serviceName || state.extractedData?.repositoryName || 'API';
    const language = state.extractedData?.targetFramework || 'TypeScript';

    const queries = [
      `${targetName} API documentation`,
      `${targetName} API authentication guide`,
      `${targetName} API endpoints reference`,
      `MCP Model Context Protocol ${language} examples`,
    ];

    this.logger.log(`Tavily search queries: ${queries.join(', ')}`);

    const tavilyApiKey = process.env.TAVILY_API_KEY;
    if (!tavilyApiKey) {
      throw new Error('TAVILY_API_KEY not configured in environment');
    }

    try {
      // Execute all queries in parallel
      const searchPromises = queries.map((query) =>
        axios.post(
          'https://api.tavily.com/search',
          {
            api_key: tavilyApiKey,
            query,
            search_depth: 'advanced',
            include_answer: true,
            include_raw_content: false,
            max_results: 3,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          },
        ),
      );

      const searchResponses = await Promise.all(searchPromises);

      // Aggregate results from all searches
      const allResults: any[] = [];
      searchResponses.forEach((response, index) => {
        if (response.data?.results) {
          response.data.results.forEach((result: any) => {
            allResults.push({
              url: result.url,
              title: result.title,
              snippet: result.content || result.snippet || '',
              relevanceScore: result.score || 0.5,
              query: queries[index],
            });
          });
        }
      });

      // Sort by relevance score
      allResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

      // Extract unique results (top 10)
      const uniqueUrls = new Set<string>();
      const results = allResults
        .filter((r) => {
          if (uniqueUrls.has(r.url)) return false;
          uniqueUrls.add(r.url);
          return true;
        })
        .slice(0, 10);

      this.logger.log(`Tavily search complete: ${results.length} results found for ${targetName}`);

      // Use LLM to synthesize the search results into structured API information
      const synthesisPrompt = `${getPlatformContextPrompt()}

**Task**: Analyze these web search results and extract structured API information for "${targetName}".

**Search Results**:
${results.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`).join('\n\n')}

**Extract**:
1. API Base URL (if mentioned)
2. Authentication method and details
3. Key endpoints and their purposes
4. Rate limits
5. Common use cases
6. MCP tool patterns and best practices

**Provide**:
- baseUrl: e.g. https://api.example.com, or null if not found
- authentication: { type: api_key|oauth|bearer_token|basic_auth, details: how auth works }
- endpoints: list of endpoint names
- rateLimit: limit info or "Unknown"
- bestPractices: list of practices`;

      let apiInfo: z.infer<typeof WebSearchSynthesisSchema> = {};
      try {
        apiInfo = await this.anthropic.completeStructured({
          prompt: synthesisPrompt,
          schema: WebSearchSynthesisSchema,
          schemaName: 'WebSearchSynthesis',
          maxTokens: 8000,
          caller: 'research.webSearchSynthesis',
        });
      } catch (e) {
        this.logger.warn(`Failed to synthesize web search results: ${e.message}`);
      }

      // Build best practices from search results and synthesis
      const bestPractices = [
        ...(apiInfo.bestPractices || []),
        'Use TypeScript for type safety',
        'Implement proper error handling',
        'Test tools individually before integration',
      ];

      if (apiInfo.baseUrl) {
        bestPractices.unshift(`Base URL: ${apiInfo.baseUrl}`);
      }
      if (apiInfo.authentication?.type) {
        bestPractices.unshift(`Authentication: ${apiInfo.authentication.type}`);
      }
      if (apiInfo.rateLimit && apiInfo.rateLimit !== 'Unknown') {
        bestPractices.unshift(`Rate Limit: ${apiInfo.rateLimit}`);
      }

      const patterns = [
        'Use JSON Schema for tool input validation',
        'Implement proper error handling with MCP error codes',
        'Support streaming responses for large outputs',
        'Include comprehensive tool descriptions',
        'Cache API responses where appropriate',
      ];

      return {
        queries,
        results: results.map((r) => ({
          url: r.url,
          title: r.title,
          snippet: r.snippet,
          relevanceScore: r.relevanceScore,
        })),
        patterns,
        bestPractices,
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(`Tavily search failed: ${error.message}`);
      throw new Error(`Web search for ${targetName} failed: ${error.message}`);
    }
  }

  /**
   * Deep GitHub Analysis
   *
   * Enhances basic repository analysis with:
   * - Code examples (top 5 representative files)
   * - Test patterns and frameworks used
   * - API usage patterns and endpoint mapping
   *
   * @param githubUrl - GitHub repository URL
   * @returns Deep analysis with code examples and patterns
   */
  private async deepGitHubAnalysis(githubUrl: string): Promise<DeepGitHubAnalysis> {
    // Use existing GitHubAnalysisService for basic analysis
    const basicAnalysis = await this.githubAnalysisService.analyzeRepository(githubUrl);

    // Parallel deep analysis methods
    const [codeExamples, testPatterns, apiUsagePatterns] = await Promise.all([
      this.githubAnalysisService.extractCodeExamples(githubUrl, 5),
      this.githubAnalysisService.analyzeTestPatterns(githubUrl),
      this.githubAnalysisService.extractApiUsagePatterns(githubUrl),
    ]);

    const deepAnalysis: DeepGitHubAnalysis = {
      basicInfo: {
        name: basicAnalysis.metadata.name,
        description: basicAnalysis.metadata.description || '',
        language: basicAnalysis.metadata.language || 'TypeScript',
        stars: basicAnalysis.metadata.stargazersCount || 0,
        topics: basicAnalysis.metadata.topics || [],
      },
      codeExamples,
      testPatterns,
      apiUsagePatterns,
      dependencies: {}, // TODO: Extract dependencies from package.json or similar files
    };

    this.logger.log(
      `Deep analysis complete: ${codeExamples.length} code examples, ` +
        `${testPatterns.length} test patterns, ${apiUsagePatterns.length} API patterns`,
    );

    return deepAnalysis;
  }

  /**
   * API Documentation Agent (GitHub-specific)
   *
   * Extracts API documentation from a GitHub repository:
   * - README.md API sections
   * - API patterns detected by GitHubAnalysisService
   * - Inline code documentation and source snippets
   *
   * NOTE: this does NOT fetch or parse OpenAPI/Swagger spec files, despite
   * what this comment used to claim - there is no spec parser anywhere in the
   * backend and no way for a user to submit a spec. Everything here is
   * README/source text synthesised by the LLM. Do not reintroduce the claim
   * without the parser to back it.
   *
   * Uses LLM to synthesize API patterns from repository content.
   *
   * @param githubUrl - GitHub repository URL
   * @returns API documentation with endpoints and auth details
   */
  private async apiDocumentationAgent(githubUrl: string): Promise<ApiDocAnalysis | undefined> {
    this.logger.log(`Extracting API docs from GitHub: ${githubUrl}`);

    try {
      // Use existing GitHubAnalysisService for repository analysis
      const analysis = await this.githubAnalysisService.analyzeRepository(githubUrl);

      if (!analysis) {
        this.logger.warn(`Failed to analyze repository: ${githubUrl}`);
        return undefined;
      }

      // Collect content for LLM analysis
      const contentParts: string[] = [];

      // Add README content (prioritize API sections)
      if (analysis.readme?.content) {
        const readme = analysis.readme.content.slice(0, 6000);
        contentParts.push(`## README\n${readme}`);
      }

      // Add API patterns from source analysis
      if (analysis.apiPatterns && analysis.apiPatterns.length > 0) {
        const patterns = analysis.apiPatterns
          .map((p) => `- ${p.type}: ${p.endpoints.join(', ')}`)
          .join('\n');
        contentParts.push(`## API Patterns Detected\n${patterns}`);
      }

      // Add source file snippets (looking for API client code)
      if (analysis.sourceFiles && analysis.sourceFiles.length > 0) {
        const apiFiles = analysis.sourceFiles
          .filter(
            (f) =>
              f.path.includes('api') ||
              f.path.includes('client') ||
              f.path.includes('service') ||
              f.content.includes('fetch(') ||
              f.content.includes('axios') ||
              f.content.includes('request('),
          )
          .slice(0, 3);

        for (const file of apiFiles) {
          const snippet = file.content.slice(0, 1500);
          contentParts.push(
            `## ${file.path}\n\`\`\`${file.language || 'javascript'}\n${snippet}\n\`\`\``,
          );
        }
      }

      if (contentParts.length === 0) {
        this.logger.warn(`No API-relevant content found in ${githubUrl}`);
        return undefined;
      }

      // Use LLM to extract API info from GitHub content
      const prompt = `${getPlatformContextPrompt()}

**Task**: Analyze this SDK/API client repository content and extract API information.

**Repository**: ${analysis.metadata.name}
**Description**: ${analysis.metadata.description || 'No description'}
**Language**: ${analysis.metadata.language || 'Unknown'}

**Content**:
${contentParts.join('\n\n').slice(0, 10000)}

**Extract**:
1. API Base URL (if mentioned in code or docs)
2. Authentication method from code patterns or docs
3. API endpoints/operations from code or documentation
4. Any rate limit information

**Provide**:
- baseUrl: e.g. https://api.example.com, or null
- authentication: { type: api_key|oauth|bearer_token|basic_auth|none|unknown, details: how auth works }
- endpoints: [{ method, path, description }]
- rateLimit: { requests, window } if documented`;

      const parsed = await this.anthropic.completeStructured({
        prompt,
        schema: ApiDocExtractionSchema,
        schemaName: 'GitHubApiDocExtraction',
        maxTokens: 8000,
        caller: 'research.extractApiDocsFromGitHub',
      });

      this.logger.log(`Extracted ${parsed.endpoints?.length || 0} endpoints from GitHub repo`);

      return {
        endpoints:
          parsed.endpoints?.map((ep) => ({
            method: ep.method,
            path: ep.path,
            description: ep.description,
          })) || [],
        authentication: {
          type: parsed.authentication?.type || 'unknown',
          details: parsed.authentication?.details || 'Authentication details not extracted',
        },
        rateLimit: parsed.rateLimit
          ? {
              requests: parsed.rateLimit.requests,
              window: parsed.rateLimit.window,
            }
          : undefined,
        baseUrl: parsed.baseUrl || undefined,
      };
    } catch (error) {
      this.logger.warn(`GitHub API doc extraction failed: ${error.message}`);
      return undefined;
    }
  }

  /**
   * NEW HELPER METHODS FOR INPUT-AGNOSTIC RESEARCH
   */

  /**
   * Scrape API Documentation from Website
   *
   * Fetches API documentation pages and uses LLM to extract structured
   * API information including endpoints, authentication, and rate limits.
   *
   * @param url - Documentation URL
   * @returns Structured API documentation
   */
  private async scrapeApiDocumentation(url: string): Promise<ApiDocAnalysis | undefined> {
    this.logger.log(`Scraping API docs from: ${url}`);

    try {
      // Fetch the documentation page
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MCPEverything/1.0; +https://mcp-everything.dev)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      const html = response.data;

      // Convert HTML to text (basic strip)
      const text = this.htmlToText(html).slice(0, 12000); // Limit context for LLM

      if (text.length < 100) {
        this.logger.warn(`Insufficient content extracted from ${url}`);
        return undefined;
      }

      // Use LLM to extract structured API information
      const prompt = `${getPlatformContextPrompt()}

**Task**: Analyze this API documentation and extract structured information.

**Documentation content**:
${text}

**Extract the following**:
1. Base URL for the API (look for patterns like "api.example.com", "https://...")
2. Authentication method (API key, OAuth, Bearer token, Basic Auth, etc.)
3. Main API endpoints with their HTTP methods and paths
4. Rate limits if mentioned

**Provide** (use null or empty values when information is unavailable):
- baseUrl: e.g. https://api.example.com, or null if not found
- authentication: { type: api_key|oauth|bearer_token|basic_auth|none|unknown, header: header name if applicable, details: how auth works }
- endpoints: [{ method, path, description }]
- rateLimit: { requests, window } e.g. { requests: 1000, window: "per minute" }`;

      const parsed = await this.anthropic.completeStructured({
        prompt,
        schema: ApiDocExtractionSchema,
        schemaName: 'ApiDocExtraction',
        maxTokens: 8000,
        caller: 'research.scrapeApiDocumentation',
      });

      this.logger.log(`Extracted ${parsed.endpoints?.length || 0} endpoints from ${url}`);

      return {
        endpoints:
          parsed.endpoints?.map((ep) => ({
            method: ep.method,
            path: ep.path,
            description: ep.description,
          })) || [],
        authentication: {
          type: parsed.authentication?.type || 'unknown',
          details: parsed.authentication?.details || 'Authentication details not extracted',
        },
        rateLimit: parsed.rateLimit
          ? {
              requests: parsed.rateLimit.requests,
              window: parsed.rateLimit.window,
            }
          : undefined,
        baseUrl: parsed.baseUrl || undefined,
      };
    } catch (error) {
      this.logger.warn(`API doc scraping failed for ${url}: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Helper: Convert HTML to plain text
   *
   * Basic HTML stripping for LLM consumption
   *
   * @param html - HTML content
   * @returns Plain text content
   */
  private htmlToText(html: string): string {
    return (
      html
        // Remove script and style tags and their contents
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        // Remove HTML comments
        .replace(/<!--[\s\S]*?-->/g, '')
        // Remove tags but keep content
        .replace(/<[^>]+>/g, ' ')
        // Decode common HTML entities
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  /**
   * Find GitHub Repos for Service
   *
   * Searches GitHub for official/popular repos related to the service using:
   * 1. GitHub Search API for SDK/client repositories
   * 2. Tavily web search as a fallback for additional repos
   *
   * @param serviceName - Service name (e.g., "Stripe", "OpenAI")
   * @returns List of relevant GitHub repos sorted by stars
   */
  private async findGitHubReposForService(
    serviceName: string,
  ): Promise<Array<{ url: string; stars: number }>> {
    this.logger.log(`Searching for GitHub repos: ${serviceName}`);
    const repos: Array<{ url: string; stars: number }> = [];

    // 1. Search GitHub directly using GitHubAnalysisService's Octokit
    try {
      const searchQuery = `${serviceName} sdk OR api OR client in:name,description`;
      const response = await this.searchGitHubRepos(searchQuery, 5);

      for (const repo of response) {
        repos.push({
          url: repo.url,
          stars: repo.stars,
        });
      }
      this.logger.log(`Found ${repos.length} repos via GitHub Search API`);
    } catch (error) {
      this.logger.warn(`GitHub search failed: ${error.message}`);
    }

    // 2. Web search for SDK repositories as fallback
    if (repos.length < 3 && process.env.TAVILY_API_KEY) {
      try {
        const searchResults = await this.tavilySearch(
          `${serviceName} official SDK GitHub repository`,
          3,
        );
        for (const result of searchResults) {
          if (result.url.includes('github.com') && !repos.some((r) => r.url === result.url)) {
            repos.push({
              url: result.url,
              stars: 0, // Unknown from web search
            });
          }
        }
        this.logger.log(`Added ${repos.length} total repos after Tavily search`);
      } catch (error) {
        this.logger.warn(`Tavily search for repos failed: ${error.message}`);
      }
    }

    // Sort by stars (descending) and limit to 5
    return repos.sort((a, b) => b.stars - a.stars).slice(0, 5);
  }

  /**
   * Helper: Search GitHub repositories
   *
   * Uses Octokit to search GitHub repositories
   *
   * @param query - Search query string
   * @param limit - Maximum number of results
   * @returns Array of repository info
   */
  private async searchGitHubRepos(
    query: string,
    limit: number,
  ): Promise<Array<{ url: string; stars: number; name: string }>> {
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    const response = await octokit.search.repos({
      q: query,
      sort: 'stars',
      order: 'desc',
      per_page: limit,
    });

    return response.data.items.map((repo) => ({
      url: repo.html_url,
      stars: repo.stargazers_count,
      name: repo.full_name,
    }));
  }

  /**
   * Find Official Documentation
   *
   * Uses Tavily web search to find official API documentation.
   * Prioritizes official domains and developer documentation sites.
   *
   * @param serviceName - Service name (e.g., "Stripe API")
   * @returns Official documentation URL and description
   */
  private async findOfficialDocumentation(
    serviceName: string,
  ): Promise<{ url?: string; description?: string }> {
    this.logger.log(`Finding official docs for: ${serviceName}`);

    if (!process.env.TAVILY_API_KEY) {
      this.logger.warn('TAVILY_API_KEY not configured, skipping doc search');
      return {};
    }

    try {
      // Search for official documentation with multiple queries
      const queries = [
        `${serviceName} API documentation official`,
        `${serviceName} developer docs REST API`,
        `${serviceName} API reference`,
      ];

      for (const query of queries) {
        const results = await this.tavilySearch(query, 5);

        for (const result of results) {
          // Prioritize official domains
          if (this.isOfficialDomain(result.url, serviceName)) {
            this.logger.log(`Found official docs: ${result.url}`);
            return {
              url: result.url,
              description: result.title || result.snippet,
            };
          }
        }
      }

      // If no official domain found, return the first documentation-like result
      const fallbackResults = await this.tavilySearch(`${serviceName} API documentation`, 3);
      for (const result of fallbackResults) {
        if (this.isDocumentationUrl(result.url)) {
          this.logger.log(`Found fallback docs: ${result.url}`);
          return {
            url: result.url,
            description: result.title || result.snippet,
          };
        }
      }

      this.logger.warn(`No official documentation found for ${serviceName}`);
      return {};
    } catch (error) {
      this.logger.warn(`Documentation search failed: ${error.message}`);
      return {};
    }
  }

  /**
   * Helper: Check if URL is from an official domain for the service
   *
   * @param url - URL to check
   * @param serviceName - Service name to match
   * @returns true if URL appears to be official
   */
  private isOfficialDomain(url: string, serviceName: string): boolean {
    try {
      const lowerService = serviceName.toLowerCase().replace(/\s+/g, '').replace(/api$/i, '');
      const domain = new URL(url).hostname.toLowerCase();

      // Check if domain contains service name
      if (domain.includes(lowerService)) {
        return true;
      }

      // Check for common official patterns
      if (
        domain.startsWith('developer.') ||
        domain.startsWith('docs.') ||
        domain.startsWith('api.')
      ) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Helper: Check if URL looks like documentation
   *
   * @param url - URL to check
   * @returns true if URL appears to be documentation
   */
  private isDocumentationUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return (
      lowerUrl.includes('/docs') ||
      lowerUrl.includes('/api') ||
      lowerUrl.includes('/reference') ||
      lowerUrl.includes('/documentation') ||
      lowerUrl.includes('developer')
    );
  }

  /**
   * Helper: Search using Tavily API
   *
   * Performs web search using Tavily's search API for finding documentation,
   * repositories, and other relevant content.
   *
   * @param query - Search query string
   * @param maxResults - Maximum number of results to return
   * @returns Array of search results with url, title, and snippet
   */
  private async tavilySearch(
    query: string,
    maxResults: number = 5,
  ): Promise<Array<{ url: string; title: string; snippet: string; score: number }>> {
    const tavilyApiKey = process.env.TAVILY_API_KEY;

    if (!tavilyApiKey) {
      throw new Error('TAVILY_API_KEY not configured');
    }

    try {
      const response = await axios.post(
        'https://api.tavily.com/search',
        {
          api_key: tavilyApiKey,
          query,
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
          max_results: maxResults,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      );

      if (!response.data?.results) {
        return [];
      }

      return response.data.results.map((result: any) => ({
        url: result.url,
        title: result.title || '',
        snippet: result.content || result.snippet || '',
        score: result.score || 0.5,
      }));
    } catch (error) {
      this.logger.warn(`Tavily search failed for "${query}": ${error.message}`);
      throw error;
    }
  }

  /**
   * Identify Services from Natural Language Intent
   *
   * Uses AI to extract relevant service names from user intent
   *
   * @param intent - User's intent in natural language
   * @param keywords - Extracted keywords
   * @returns List of identified services with confidence scores
   */
  private async identifyServicesFromIntent(
    intent: string,
    keywords: string[],
  ): Promise<Array<{ name: string; confidence: number }>> {
    this.logger.log(`Identifying services from intent: "${intent}"`);

    const prompt = `Given this user intent, identify relevant API services or platforms they might want to integrate with.

User intent: "${intent}"
Keywords: ${keywords.join(', ')}

Common services:
- Payment: Stripe, PayPal, Square
- SMS: Twilio, Nexmo, MessageBird
- Email: SendGrid, Mailgun, AWS SES
- CRM: Salesforce, HubSpot, Pipedrive
- Storage: AWS S3, Google Cloud Storage, Azure Blob
- AI: OpenAI, Anthropic Claude, Google AI

Provide a "services" list, each entry with:
- name: service name
- confidence: 0.0-1.0
- reasoning: why this service

Use an empty list if no clear services are identified.`;

    try {
      // Cheap identification -> small model.
      const { services } = await this.anthropic.completeStructured({
        prompt,
        schema: ServiceIdentificationSchema,
        schemaName: 'ServiceIdentification',
        model: 'small',
        maxTokens: 2048,
        caller: 'research.identifyServicesFromIntent',
      });
      this.logger.log(`Identified ${services.length} services`);
      return services;
    } catch (error) {
      this.logger.warn(`Failed to identify services: ${error.message}`);
      return [];
    }
  }

  /**
   * Synthesize Research
   *
   * Uses Claude Haiku to synthesize all research sources into
   * a coherent plan with key insights and recommendations.
   *
   * Handles multiple input types gracefully.
   *
   * @param sources - All research sources (flexible based on what's available)
   * @returns Synthesized plan with confidence score
   */
  private async synthesizeResearch(sources: {
    webSearch?: WebSearchFindings;
    githubDeep?: DeepGitHubAnalysis;
    apiDocs?: ApiDocAnalysis;
    source: string;
    inputType: string;
  }): Promise<SynthesizedPlan> {
    // Build context from available sources
    let context = `**Input Type**: ${sources.inputType}\n**Source**: ${sources.source}\n\n`;

    if (sources.githubDeep) {
      context += `**GitHub Analysis**:
- Repository: ${sources.githubDeep.basicInfo.name}
- Language: ${sources.githubDeep.basicInfo.language}
- Description: ${sources.githubDeep.basicInfo.description}
- Stars: ${sources.githubDeep.basicInfo.stars}
- Topics: ${sources.githubDeep.basicInfo.topics.join(', ')}
- Code Examples: ${sources.githubDeep.codeExamples.length} files analyzed
- Test Patterns: ${sources.githubDeep.testPatterns.length} patterns found

`;
    }

    if (sources.webSearch) {
      context += `**Web Search Findings**:
- Patterns: ${sources.webSearch.patterns.join(', ')}
- Best Practices: ${sources.webSearch.bestPractices.join(', ')}
- Results: ${sources.webSearch.results.length} relevant articles found

`;
    }

    if (sources.apiDocs) {
      context += `**API Documentation**:
- Endpoints: ${sources.apiDocs.endpoints.length} endpoints documented
- Auth: ${sources.apiDocs.authentication.type}
- Rate Limit: ${sources.apiDocs.rateLimit?.requests || 'unknown'} requests per ${sources.apiDocs.rateLimit?.window || 'hour'}

`;
    }

    const prompt = `${getPlatformContextPrompt()}

**Your Role**: Synthesize research into actionable MCP server generation plans. Prefer reasonable defaults over flagging gaps.

Analyze the following research data and synthesize a comprehensive plan:

${context}

**Task**: Synthesize this research into a plan for generating an MCP server.

**Synthesis Guidelines**:
- Focus on what CAN be built, not what's missing
- Recommend TypeScript unless research suggests otherwise
- Infer tool patterns from API structures
- Only flag truly blocking issues in challenges
- High confidence (>0.7) if we have enough to generate working tools

Provide:
1. **Summary**: 2-3 sentence overview of what we'll build
2. **Key Insights**: 3-5 actionable insights from the research
3. **Recommended Approach**: Specific strategy for MCP server generation
4. **Potential Challenges**: 2-3 REAL blockers only (not "might need clarification")
5. **Confidence**: Score 0-1 based on ability to generate working server
6. **Reasoning**: explanation of the confidence score`;

    try {
      const synthesized: SynthesizedPlan = await this.anthropic.completeStructured({
        prompt,
        schema: SynthesizedPlanSchema,
        schemaName: 'SynthesizedPlan',
        maxTokens: 8000,
        caller: 'research.synthesizeResearch',
      });

      this.logger.log(`Research synthesized with confidence: ${synthesized.confidence}`);
      return synthesized;
    } catch (error) {
      this.logger.error(`Failed to synthesize research: ${error.message}`);

      // Fallback: Return basic synthesis from available data
      const summary = sources.githubDeep
        ? `${sources.inputType} "${sources.githubDeep.basicInfo.name}" - ${sources.githubDeep.basicInfo.language} project with ${sources.githubDeep.basicInfo.stars} stars.`
        : `${sources.inputType}: ${sources.source}`;

      const insights = sources.webSearch
        ? sources.webSearch.patterns.slice(0, 3)
        : ['Standard MCP tool patterns', 'Error handling best practices', 'TypeScript type safety'];

      return {
        summary,
        keyInsights: insights,
        recommendedApproach:
          'Generate MCP server with standard tool patterns based on available research.',
        potentialChallenges: ['Limited research data', 'May need user clarification'],
        confidence: 0.4,
        reasoning: 'Fallback synthesis due to LLM error',
      };
    }
  }

  // TODO: Uncomment when caching is implemented
  // /**
  //  * Helper: Check if cached research is still valid
  //  *
  //  * @param cached - Cached research entry
  //  * @returns true if cache is valid (not expired)
  //  */
  // private isCacheValid(cached: any): boolean {
  //   const now = new Date();
  //   return cached.expiresAt > now;
  // }

  // /**
  //  * Helper: Get cache age in milliseconds
  //  *
  //  * @param cached - Cached research entry
  //  * @returns Age in milliseconds
  //  */
  // private getCacheAge(cached: any): number {
  //   const now = Date.now();
  //   const cachedAt = new Date(cached.cachedAt).getTime();
  //   return now - cachedAt;
  // }
}
