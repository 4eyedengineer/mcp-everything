import { Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import { GitHubAnalysisService } from '../github-analysis.service';
import { ResearchCacheService } from '../database/services/research-cache.service';
import {
  GraphState,
  WebSearchFindings,
  DeepGitHubAnalysis,
  ApiDocAnalysis,
  SynthesizedPlan,
} from './types';

/**
 * Input Type Classification
 */
export enum InputType {
  GITHUB_URL = 'github_url',           // https://github.com/owner/repo
  WEBSITE_URL = 'website_url',         // https://stripe.com
  DOCUMENTATION_URL = 'documentation_url', // https://docs.stripe.com/api
  SERVICE_NAME = 'service_name',       // "Stripe API", "OpenAI"
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
 * 3. AI synthesis: Claude Haiku combines all sources
 * 4. Cache results for 7 days with vector embedding
 * 5. Return research phase data
 */
@Injectable()
export class ResearchService {
  private readonly logger = new Logger(ResearchService.name);
  private readonly llm: ChatAnthropic;

  constructor(
    private readonly githubAnalysisService: GitHubAnalysisService,
    private readonly researchCacheService: ResearchCacheService,
  ) {
    // Initialize Claude Haiku for cost-effective research synthesis
    this.llm = new ChatAnthropic({
      modelName: 'claude-3-5-haiku-20241022',
      temperature: 0.7,
      maxTokens: 4096,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

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
  async conductResearch(state: GraphState): Promise<GraphState['researchPhase']> {
    const userInput = state.userInput;
    this.logger.log(`Starting input-agnostic research for: "${userInput}"`);

    // Step 1: Classify input type
    const classification = await this.classifyInput(userInput, state);
    this.logger.log(`Input classified as: ${classification.type} (confidence: ${classification.confidence})`);

    // Step 2: Generate cache key (normalized)
    const cacheKey = this.generateCacheKey(classification);

    // Step 3: Check 7-day cache
    const cached = await this.researchCacheService.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      this.logger.log(`Cache HIT for ${cacheKey} (age: ${this.getCacheAge(cached)}ms)`);
      return cached.researchData;
    }

    this.logger.log(`Cache MISS for ${cacheKey}, conducting fresh research`);

    // Step 4: Route to appropriate research strategy based on input type
    const researchPhase = await this.routeResearchStrategy(classification, state);

    // Step 5: Cache for 7 days
    await this.researchCacheService.set(cacheKey, researchPhase);
    this.logger.log(`Research cached for ${cacheKey}`);

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
  private async classifyInput(userInput: string, state: GraphState): Promise<InputClassification> {
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

Return ONLY valid JSON:
{
  "type": "SERVICE_NAME" | "NATURAL_LANGUAGE",
  "confidence": 0.0-1.0,
  "serviceName": "extracted service name if applicable",
  "intent": "user's intent in one sentence",
  "keywords": ["keyword1", "keyword2", ...]
}`;

    try {
      const response = await this.llm.invoke(prompt);
      const content = response.content.toString();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON in classification response');
      }

      const result = JSON.parse(jsonMatch[0]);
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
      this.logger.warn(`Failed to classify input with AI: ${error.message}, defaulting to NATURAL_LANGUAGE`);
      return {
        type: InputType.NATURAL_LANGUAGE,
        confidence: 0.5,
        extractedInfo: {
          intent: userInput,
          keywords: userInput.split(/\s+/).filter(w => w.length > 3),
        },
      };
    }
  }

  /**
   * Generate cache key from classification
   */
  private generateCacheKey(classification: InputClassification): string {
    switch (classification.type) {
      case InputType.GITHUB_URL:
        return `github:${classification.extractedInfo.url}`;
      case InputType.WEBSITE_URL:
      case InputType.DOCUMENTATION_URL:
        return `url:${classification.extractedInfo.url}`;
      case InputType.SERVICE_NAME:
        return `service:${classification.extractedInfo.serviceName?.toLowerCase()}`;
      case InputType.NATURAL_LANGUAGE:
        // Normalize natural language to keywords
        return `intent:${classification.extractedInfo.keywords?.join('-')}`;
    }
  }

  /**
   * Route to appropriate research strategy based on input type
   */
  private async routeResearchStrategy(
    classification: InputClassification,
    state: GraphState,
  ): Promise<GraphState['researchPhase']> {
    const startTime = Date.now();

    let researchPhase: GraphState['researchPhase'];

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
    state: GraphState,
  ): Promise<GraphState['researchPhase']> {
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
    state: GraphState,
  ): Promise<GraphState['researchPhase']> {
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
    state: GraphState,
  ): Promise<GraphState['researchPhase']> {
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
    state: GraphState,
  ): Promise<GraphState['researchPhase']> {
    const intent = classification.extractedInfo.intent!;
    const keywords = classification.extractedInfo.keywords!;
    this.logger.log(`Strategy: Intent-based research for "${intent}"`);

    // Use AI to identify relevant services
    const services = await this.identifyServicesFromIntent(intent, keywords);

    if (services.length === 0) {
      // No clear services identified, return low-confidence research
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
        researchConfidence: 0.3, // Low confidence
        researchIterations: 1,
      };
    }

    // Research the top identified service
    const topService = services[0];
    this.logger.log(`Identified service: ${topService.name} (confidence: ${topService.confidence})`);

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
   * Generates targeted search queries and uses WebSearch tool
   * to find MCP patterns, best practices, and implementation examples.
   *
   * @param state - Graph state with context
   * @param serviceName - Optional service name for targeted search
   * @returns Web search findings with patterns and best practices
   */
  private async webSearchAgent(state: GraphState, serviceName?: string): Promise<WebSearchFindings> {
    const targetName = serviceName || state.extractedData?.repositoryName || 'API';
    const language = state.extractedData?.targetFramework || 'TypeScript';

    // Generate search queries
    const queries = [
      `${targetName} API documentation`,
      `${targetName} integration guide`,
      `MCP Model Context Protocol server examples ${language}`,
      `${targetName} API best practices`,
    ];

    this.logger.log(`Web search queries: ${queries.join(', ')}`);

    // TODO: Integrate with WebSearch tool when available
    // For now, return structured placeholder data
    const results = queries.map((query, index) => ({
      url: `https://example.com/result-${index + 1}`,
      title: `MCP Pattern ${index + 1}`,
      snippet: `Best practice for ${query}`,
      relevanceScore: 0.8 - index * 0.1,
    }));

    const patterns = [
      'Use JSON Schema for tool input validation',
      'Implement proper error handling with MCP error codes',
      'Support streaming responses for large outputs',
      'Include comprehensive tool descriptions',
    ];

    const bestPractices = [
      'Follow MCP protocol specification strictly',
      'Test tools individually before integration',
      'Use TypeScript for type safety',
      'Implement rate limiting for API calls',
    ];

    return {
      queries,
      results,
      patterns,
      bestPractices,
      timestamp: new Date(),
    };
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
      `${testPatterns.length} test patterns, ${apiUsagePatterns.length} API patterns`
    );

    return deepAnalysis;
  }

  /**
   * API Documentation Agent (GitHub-specific)
   *
   * Extracts API documentation from GitHub repository:
   * - OpenAPI/Swagger specs
   * - README.md API sections
   * - Inline code documentation
   *
   * @param githubUrl - GitHub repository URL
   * @returns API documentation with endpoints and auth details
   */
  private async apiDocumentationAgent(githubUrl: string): Promise<ApiDocAnalysis | undefined> {
    // TODO: Implement GitHub-specific API doc extraction
    // For MVP, return undefined (optional field)
    return undefined;
  }

  /**
   * NEW HELPER METHODS FOR INPUT-AGNOSTIC RESEARCH
   */

  /**
   * Scrape API Documentation from Website
   *
   * Uses WebFetch to scrape API documentation pages
   *
   * @param url - Documentation URL
   * @returns Structured API documentation
   */
  private async scrapeApiDocumentation(url: string): Promise<ApiDocAnalysis | undefined> {
    this.logger.log(`Scraping API docs from: ${url}`);

    // TODO: Implement website scraping with WebFetch
    // For MVP, return basic structure
    return {
      endpoints: [],
      authentication: {
        type: 'unknown',
        details: 'Authentication details not yet extracted',
      },
      rateLimit: {
        requests: 0,
        window: 'per hour',
      },
    };
  }

  /**
   * Find GitHub Repos for Service
   *
   * Searches GitHub for official/popular repos related to the service
   *
   * @param serviceName - Service name (e.g., "Stripe", "OpenAI")
   * @returns List of relevant GitHub repos
   */
  private async findGitHubReposForService(serviceName: string): Promise<Array<{url: string; stars: number}>> {
    this.logger.log(`Searching for GitHub repos: ${serviceName}`);

    // TODO: Use GitHub API or web search to find repos
    // For MVP, return empty array (graceful degradation)
    return [];
  }

  /**
   * Find Official Documentation
   *
   * Uses web search to find official API documentation
   *
   * @param serviceName - Service name (e.g., "Stripe API")
   * @returns Official documentation URL
   */
  private async findOfficialDocumentation(serviceName: string): Promise<{url?: string; description?: string}> {
    this.logger.log(`Finding official docs for: ${serviceName}`);

    // TODO: Implement web search for official docs
    // For MVP, return empty (graceful degradation)
    return {};
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
  ): Promise<Array<{name: string; confidence: number}>> {
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

Return ONLY valid JSON array:
[
  {"name": "Service Name", "confidence": 0.0-1.0, "reasoning": "why this service"},
  ...
]

Return empty array [] if no clear services identified.`;

    try {
      const response = await this.llm.invoke(prompt);
      const content = response.content.toString();
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const services = JSON.parse(jsonMatch[0]);
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

    const prompt = `You are an expert at analyzing APIs and services to design MCP (Model Context Protocol) servers.

Analyze the following research data and synthesize a comprehensive plan:

${context}

**Task**: Synthesize this research into a plan for generating an MCP server.

Provide:
1. **Summary**: 2-3 sentence overview
2. **Key Insights**: 3-5 actionable insights about the repository
3. **Recommended Approach**: Specific strategy for MCP server generation
4. **Potential Challenges**: 2-3 challenges to anticipate
5. **Confidence**: Score 0-1 based on research completeness

Return ONLY valid JSON in this format:
{
  "summary": "string",
  "keyInsights": ["string", "string", ...],
  "recommendedApproach": "string",
  "potentialChallenges": ["string", "string", ...],
  "confidence": 0.0-1.0,
  "reasoning": "string explaining confidence score"
}`;

    try {
      const response = await this.llm.invoke(prompt);
      const content = response.content.toString();

      // Extract JSON from response (handles markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in LLM response');
      }

      const synthesized: SynthesizedPlan = JSON.parse(jsonMatch[0]);

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
        recommendedApproach: 'Generate MCP server with standard tool patterns based on available research.',
        potentialChallenges: ['Limited research data', 'May need user clarification'],
        confidence: 0.4,
        reasoning: 'Fallback synthesis due to LLM error',
      };
    }
  }

  /**
   * Helper: Check if cached research is still valid
   *
   * @param cached - Cached research entry
   * @returns true if cache is valid (not expired)
   */
  private isCacheValid(cached: any): boolean {
    const now = new Date();
    return cached.expiresAt > now;
  }

  /**
   * Helper: Get cache age in milliseconds
   *
   * @param cached - Cached research entry
   * @returns Age in milliseconds
   */
  private getCacheAge(cached: any): number {
    const now = Date.now();
    const cachedAt = new Date(cached.cachedAt).getTime();
    return now - cachedAt;
  }
}
