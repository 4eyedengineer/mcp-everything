import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import {
  McpTool,
  ToolDiscoveryResult,
  ToolDiscoveryService as IToolDiscoveryService,
  RepositoryContext,
  DiscoveryConfig,
  DiscoveryMetadata,
  ToolCategory,
  AiToolSuggestion,
  AiQualityJudgment,
  ToolQuality,
  ImplementationHints,
  JsonSchema,
  ToolDiscoveryError,
  DiscoveryMethod,
  COMMON_TOOL_TEMPLATES
} from './types/tool-discovery.types';
import { RepositoryAnalysis, ApiPattern } from './types/github-analysis.types';

@Injectable()
export class ToolDiscoveryService implements IToolDiscoveryService {
  private readonly logger = new Logger(ToolDiscoveryService.name);

  private readonly defaultConfig: DiscoveryConfig = {
    maxIterations: 5,
    qualityThreshold: 0.7,
    maxToolsPerCategory: 5,
    preferredCategories: ['data', 'api', 'analysis', 'utility'],
    complexityBias: 'balanced'
  };

  constructor(private conversationService: ConversationService) {}

  /**
   * Main discovery method that uses AI to discover potential MCP tools
   */
  async discoverTools(
    analysis: RepositoryAnalysis,
    config: DiscoveryConfig = this.defaultConfig
  ): Promise<ToolDiscoveryResult> {
    const startTime = Date.now();
    this.logger.log(`Starting tool discovery for ${analysis.metadata.fullName}`);

    try {
      // Build repository context for AI reasoning
      const context = this.buildRepositoryContext(analysis);

      // Generate initial tools using AI
      const discoveredTools: McpTool[] = [];
      let iterationCount = 0;

      // Discover tools through multiple methods
      const codeTools = await this.generateToolsFromAnalysis(analysis, context);
      const readmeTools = await this.extractToolsFromReadme(analysis.readme.content || '', context);
      const apiTools = await this.mapApiToTools(analysis.apiPatterns, context);

      // Combine all discovered tools
      const allCandidateTools = [...codeTools, ...readmeTools, ...apiTools];

      // Use judge pattern to validate and improve tools
      for (const candidateTool of allCandidateTools) {
        if (iterationCount >= config.maxIterations) break;

        const validatedTool = await this.validateAndImproveToolWithJudge(
          candidateTool,
          context,
          config.qualityThreshold,
          config.maxIterations - iterationCount
        );

        if (validatedTool && validatedTool.quality.overallScore >= config.qualityThreshold) {
          discoveredTools.push(validatedTool);
        }

        iterationCount++;
      }

      // Filter and organize by category limits
      const finalTools = this.filterByCategory(discoveredTools, config);

      const metadata: DiscoveryMetadata = {
        repositoryContext: context,
        discoveryMethod: 'ai_inference',
        aiReasoning: 'Used multi-method discovery with AI validation',
        processingTime: Date.now() - startTime,
        iterationCount,
        qualityThreshold: config.qualityThreshold
      };

      this.logger.log(`Discovered ${finalTools.length} high-quality tools in ${metadata.processingTime}ms`);

      return {
        success: true,
        tools: finalTools,
        metadata
      };

    } catch (error) {
      this.logger.error(`Tool discovery failed: ${error.message}`);
      return {
        success: false,
        tools: [],
        metadata: {
          repositoryContext: this.buildRepositoryContext(analysis),
          discoveryMethod: 'ai_inference',
          aiReasoning: 'Discovery failed due to error',
          processingTime: Date.now() - startTime,
          iterationCount: 0,
          qualityThreshold: config.qualityThreshold
        },
        error: error.message
      };
    }
  }

  /**
   * Generate MCP tool from code snippet using AI analysis
   */
  async generateToolFromCode(code: string, context: RepositoryContext): Promise<McpTool[]> {
    const prompt = this.buildCodeAnalysisPrompt(code, context);

    try {
      const response = await this.callAnthropicForTools(prompt);
      const suggestions = this.parseJsonWithFallback(response, 'code analysis') as AiToolSuggestion;

      if (!suggestions || !suggestions.tools) {
        this.logger.warn('No valid tools returned from code analysis');
        return [];
      }

      const tools: McpTool[] = [];
      for (const suggestion of suggestions.tools) {
        if (this.isValidToolSuggestion(suggestion)) {
          const tool = await this.convertSuggestionToTool(suggestion, context);
          tools.push(tool);
        }
      }

      return tools;
    } catch (error) {
      this.logger.error(`Code analysis failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Find tools mentioned in documentation using AI
   */
  async extractToolsFromReadme(readme: string, context: RepositoryContext): Promise<McpTool[]> {
    if (!readme || readme.trim().length === 0) {
      return [];
    }

    const prompt = this.buildReadmeAnalysisPrompt(readme, context);

    try {
      const response = await this.callAnthropicForTools(prompt);
      const suggestions = this.parseJsonWithFallback(response, 'README analysis') as AiToolSuggestion;

      if (!suggestions || !suggestions.tools) {
        this.logger.warn('No valid tools returned from README analysis');
        return [];
      }

      const tools: McpTool[] = [];
      for (const suggestion of suggestions.tools) {
        if (this.isValidToolSuggestion(suggestion)) {
          const tool = await this.convertSuggestionToTool(suggestion, context);
          tools.push(tool);
        }
      }

      return tools;
    } catch (error) {
      this.logger.error(`README analysis failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Convert API endpoints to MCP tools
   */
  async mapApiToTools(apiPatterns: ApiPattern[], context: RepositoryContext): Promise<McpTool[]> {
    if (!apiPatterns || apiPatterns.length === 0) {
      return [];
    }

    const prompt = this.buildApiMappingPrompt(apiPatterns, context);

    try {
      const response = await this.callAnthropicForTools(prompt);
      const suggestions = this.parseJsonWithFallback(response, 'API mapping') as AiToolSuggestion;

      if (!suggestions || !suggestions.tools) {
        this.logger.warn('No valid tools returned from API mapping');
        return [];
      }

      const tools: McpTool[] = [];
      for (const suggestion of suggestions.tools) {
        if (this.isValidToolSuggestion(suggestion)) {
          const tool = await this.convertSuggestionToTool(suggestion, context);
          tools.push(tool);
        }
      }

      return tools;
    } catch (error) {
      this.logger.error(`API mapping failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Use AI to judge if a tool is useful/valid
   */
  async judgeToolQuality(tool: Partial<McpTool>, context: RepositoryContext): Promise<AiQualityJudgment> {
    const prompt = this.buildQualityJudgePrompt(tool, context);

    try {
      const response = await this.callAnthropicForJudge(prompt);
      const judgment = this.parseJsonWithFallback(response, 'quality judgment') as AiQualityJudgment;

      if (!judgment || !judgment.quality) {
        throw new Error('Invalid judgment structure returned');
      }

      return judgment;
    } catch (error) {
      this.logger.error(`Quality judgment failed: ${error.message}`);
      // Return default low-quality judgment
      return {
        toolName: tool.name || 'unknown',
        isValid: false,
        quality: {
          usefulness: 0.1,
          specificity: 0.1,
          implementability: 0.1,
          uniqueness: 0.1,
          overallScore: 0.1,
          reasoning: 'Failed to evaluate due to error'
        },
        feedback: 'Could not evaluate tool quality',
        suggestedImprovements: []
      };
    }
  }

  /**
   * Use Judge LLM pattern to validate and improve tools
   */
  private async validateAndImproveToolWithJudge(
    tool: Partial<McpTool>,
    context: RepositoryContext,
    qualityThreshold: number,
    maxIterations: number
  ): Promise<McpTool | null> {
    let currentTool = tool;
    let iteration = 0;

    while (iteration < maxIterations) {
      const judgment = await this.judgeToolQuality(currentTool, context);

      if (judgment.isValid && judgment.quality.overallScore >= qualityThreshold) {
        // Tool passes validation
        return this.convertSuggestionToTool(currentTool, context);
      }

      if (!judgment.isValid || iteration === maxIterations - 1) {
        // Tool is invalid or we've reached max iterations
        this.logger.debug(`Tool ${currentTool.name} failed validation: ${judgment.feedback}`);
        return null;
      }

      // Regenerate tool with feedback
      currentTool = await this.regenerateToolWithFeedback(currentTool, judgment.feedback, context);
      iteration++;
    }

    return null;
  }

  /**
   * Regenerate tool based on judge feedback
   */
  private async regenerateToolWithFeedback(
    tool: Partial<McpTool>,
    feedback: string,
    context: RepositoryContext
  ): Promise<Partial<McpTool>> {
    const prompt = this.buildRegenerationPrompt(tool, feedback, context);

    try {
      const response = await this.callAnthropicForTools(prompt);
      const suggestions = this.parseJsonWithFallback(response, 'tool regeneration') as AiToolSuggestion;

      if (suggestions && suggestions.tools && suggestions.tools.length > 0) {
        return suggestions.tools[0];
      }

      return tool; // Return original if regeneration fails
    } catch (error) {
      this.logger.error(`Tool regeneration failed: ${error.message}`);
      return tool;
    }
  }

  /**
   * Generate tools from comprehensive repository analysis
   */
  private async generateToolsFromAnalysis(
    analysis: RepositoryAnalysis,
    context: RepositoryContext
  ): Promise<Partial<McpTool>[]> {
    const prompt = this.buildComprehensiveAnalysisPrompt(analysis, context);

    try {
      const response = await this.callAnthropicForTools(prompt);
      const suggestions = this.parseJsonWithFallback(response, 'comprehensive analysis') as AiToolSuggestion;

      if (!suggestions || !suggestions.tools) {
        this.logger.warn('No valid tools returned from comprehensive analysis');
        return [];
      }

      return suggestions.tools;
    } catch (error) {
      this.logger.error(`Comprehensive analysis failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Build repository context from analysis
   */
  private buildRepositoryContext(analysis: RepositoryAnalysis): RepositoryContext {
    const primaryLanguage = analysis.metadata.language || 'unknown';
    const frameworks = analysis.techStack.frameworks;

    // Infer repository type from analysis
    let repositoryType: 'library' | 'application' | 'tool' | 'service' | 'other' = 'other';
    if (analysis.features.hasApi) repositoryType = 'service';
    else if (analysis.features.hasCli) repositoryType = 'tool';
    else if (frameworks.length > 0) repositoryType = 'application';
    else repositoryType = 'library';

    // Determine complexity
    const complexity = analysis.sourceFiles.length > 50 ? 'complex' :
                      analysis.sourceFiles.length > 10 ? 'medium' : 'simple';

    // Infer domain from languages and frameworks
    const domain = this.inferDomain(primaryLanguage, frameworks);

    return {
      primaryLanguage,
      frameworks,
      repositoryType,
      complexity,
      domain
    };
  }

  /**
   * Infer domain from language and frameworks
   */
  private inferDomain(language: string, frameworks: string[]): string {
    const webFrameworks = ['react', 'vue', 'angular', 'express', 'fastify', 'next'];
    const mobileFrameworks = ['react-native', 'flutter', 'ionic'];
    const mlFrameworks = ['tensorflow', 'pytorch', 'scikit-learn'];

    if (frameworks.some(f => webFrameworks.includes(f.toLowerCase()))) return 'web';
    if (frameworks.some(f => mobileFrameworks.includes(f.toLowerCase()))) return 'mobile';
    if (frameworks.some(f => mlFrameworks.includes(f.toLowerCase()))) return 'ml';
    if (language.toLowerCase() === 'python') return 'data';

    return 'general';
  }

  /**
   * Filter tools by category limits
   */
  private filterByCategory(tools: McpTool[], config: DiscoveryConfig): McpTool[] {
    const categoryCounts: Record<string, number> = {};
    const filtered: McpTool[] = [];

    // Sort by quality score descending
    const sortedTools = tools.sort((a, b) => b.quality.overallScore - a.quality.overallScore);

    for (const tool of sortedTools) {
      const categoryCount = categoryCounts[tool.category] || 0;

      if (categoryCount < config.maxToolsPerCategory) {
        filtered.push(tool);
        categoryCounts[tool.category] = categoryCount + 1;
      }
    }

    return filtered;
  }

  /**
   * Build AI prompts for different discovery methods
   */
  private buildCodeAnalysisPrompt(code: string, context: RepositoryContext): string {
    return `Respond ONLY with valid JSON. No markdown. No explanations.

Analyze ${context.primaryLanguage} code and suggest MCP tools.

Repository: ${context.repositoryType} (${context.primaryLanguage})
Frameworks: ${context.frameworks.join(', ')}
Domain: ${context.domain}

Code snippet (${code.length} chars):
${code.substring(0, 1500)}${code.length > 1500 ? '...' : ''}

Generate 1-3 specific tools using this EXACT JSON structure:

{
  "tools": [
    {
      "name": "analyze_code",
      "description": "Analyze repository code structure and patterns",
      "category": "analysis",
      "inputSchema": {
        "type": "object",
        "properties": {
          "file_path": {"type": "string", "description": "Path to analyze"}
        },
        "required": ["file_path"]
      },
      "implementationHints": {
        "primaryAction": "Code analysis",
        "requiredData": ["source files"],
        "dependencies": [],
        "complexity": "simple",
        "outputFormat": "text",
        "errorHandling": ["file not found"],
        "examples": []
      }
    }
  ],
  "reasoning": "Tool usefulness explanation",
  "confidence": 0.8
}

Requirements:
- Tool names in snake_case
- Repository-specific functionality
- Clear descriptions
- Valid JSON Schema

JSON response:`;
  }

  private buildReadmeAnalysisPrompt(readme: string, context: RepositoryContext): string {
    return `Extract MCP tools from README. Respond ONLY with JSON.

Repository: ${context.repositoryType} (${context.primaryLanguage}, ${context.domain})

README content (${readme.length} chars):
${readme.substring(0, 2500)}${readme.length > 2500 ? '...' : ''}

Extract 1-4 tools focusing on:
- API endpoints
- CLI commands
- Main features
- Usage patterns

Use this EXACT JSON format:

{
  "tools": [
    {
      "name": "get_documentation",
      "description": "Retrieve project documentation and usage guides",
      "category": "documentation",
      "inputSchema": {
        "type": "object",
        "properties": {
          "section": {"type": "string", "description": "Documentation section"}
        },
        "required": []
      },
      "implementationHints": {
        "primaryAction": "Documentation retrieval",
        "requiredData": ["README content"],
        "dependencies": [],
        "complexity": "simple",
        "outputFormat": "text",
        "errorHandling": ["section not found"],
        "examples": []
      }
    }
  ],
  "reasoning": "Documentation-based tools for user interaction",
  "confidence": 0.85
}

JSON response:`;
  }

  private buildApiMappingPrompt(apiPatterns: ApiPattern[], context: RepositoryContext): string {
    const patternsText = apiPatterns.map(p =>
      `${p.type}: ${p.endpoints.slice(0, 3).join(', ')} (${p.methods.join(', ')})`
    ).join(' | ');

    return `Convert API patterns to MCP tools. JSON response only.

Repository: ${context.repositoryType} (${context.primaryLanguage})
API Patterns: ${patternsText}

Create 1-3 tools for API interaction.

EXACT JSON format:

{
  "tools": [
    {
      "name": "call_api_endpoint",
      "description": "Make HTTP requests to repository API endpoints",
      "category": "api",
      "inputSchema": {
        "type": "object",
        "properties": {
          "endpoint": {"type": "string", "description": "API endpoint path"},
          "method": {"type": "string", "description": "HTTP method"},
          "data": {"type": "object", "description": "Request payload"}
        },
        "required": ["endpoint"]
      },
      "implementationHints": {
        "primaryAction": "HTTP API request",
        "requiredData": ["endpoint URLs"],
        "dependencies": ["fetch"],
        "complexity": "medium",
        "outputFormat": "json",
        "errorHandling": ["network errors", "auth errors"],
        "examples": []
      }
    }
  ],
  "reasoning": "API wrapper tools for easy access",
  "confidence": 0.75
}

JSON response:`;
  }

  private buildQualityJudgePrompt(tool: Partial<McpTool>, context: RepositoryContext): string {
    return `Judge MCP tool quality. JSON response only.

Tool: ${tool.name || 'unnamed'}
Description: ${tool.description || 'no description'}
Category: ${tool.category || 'unknown'}

Repository: ${context.primaryLanguage} ${context.repositoryType} (${context.domain})

Evaluate on:
1. Usefulness (0.0-1.0)
2. Specificity (0.0-1.0)
3. Implementability (0.0-1.0)
4. Uniqueness (0.0-1.0)

EXACT JSON response format:

{
  "toolName": "${tool.name || 'unknown'}",
  "isValid": true,
  "quality": {
    "usefulness": 0.8,
    "specificity": 0.7,
    "implementability": 0.9,
    "uniqueness": 0.6,
    "overallScore": 0.75,
    "reasoning": "Clear, specific reasoning for scores"
  },
  "feedback": "Constructive feedback about tool quality",
  "suggestedImprovements": ["specific improvement 1", "specific improvement 2"]
}

JSON judgment:`
  }

  private buildRegenerationPrompt(
    tool: Partial<McpTool>,
    feedback: string,
    context: RepositoryContext
  ): string {
    return `Improve MCP tool based on feedback. JSON only.

Original tool: ${tool.name} - ${tool.description}
Feedback: ${feedback}
Repository: ${context.primaryLanguage} ${context.repositoryType}

Generate improved version using EXACT JSON format:

{
  "tools": [
    {
      "name": "improved_tool_name",
      "description": "Enhanced, more specific description",
      "category": "utility",
      "inputSchema": {
        "type": "object",
        "properties": {
          "param": {"type": "string", "description": "Parameter description"}
        },
        "required": []
      },
      "implementationHints": {
        "primaryAction": "Specific operation",
        "requiredData": ["data needed"],
        "dependencies": [],
        "complexity": "simple",
        "outputFormat": "text",
        "errorHandling": ["error type"],
        "examples": []
      }
    }
  ],
  "reasoning": "Improvement explanation",
  "confidence": 0.85
}

Address feedback and improve:
- Specificity
- Usefulness
- Implementation feasibility

JSON response:`;
  }

  private buildComprehensiveAnalysisPrompt(
    analysis: RepositoryAnalysis,
    context: RepositoryContext
  ): string {
    const features = Object.entries(analysis.features)
      .filter(([_, value]) => value === true)
      .map(([key, _]) => key)
      .slice(0, 8)
      .join(', ');

    return `Generate comprehensive MCP tools for repository. JSON only.

Repository: ${analysis.metadata.fullName}
Description: ${analysis.metadata.description || 'No description'}
Language: ${context.primaryLanguage}
Type: ${context.repositoryType}
Frameworks: ${context.frameworks.slice(0, 3).join(', ')}
Features: ${features}
Files: ${analysis.sourceFiles.length}

Generate 3-5 high-value tools focusing on:
- Core repository functionality
- Common developer use cases
- Unique capabilities
- Productivity enhancement

EXACT JSON format:

{
  "tools": [
    {
      "name": "analyze_repository_structure",
      "description": "Analyze and summarize repository structure and organization",
      "category": "analysis",
      "inputSchema": {
        "type": "object",
        "properties": {
          "depth": {"type": "number", "description": "Analysis depth level"}
        },
        "required": []
      },
      "implementationHints": {
        "primaryAction": "Repository structure analysis",
        "requiredData": ["file tree", "source files"],
        "dependencies": [],
        "complexity": "medium",
        "outputFormat": "text",
        "errorHandling": ["file access errors"],
        "examples": []
      }
    }
  ],
  "reasoning": "Most valuable tools for this repository type and domain",
  "confidence": 0.9
}

JSON response:`;
  }

  /**
   * Helper methods for AI integration and validation
   */
  private async callAnthropicForTools(prompt: string): Promise<string> {
    return await this.conversationService.callAnthropicForService(prompt);
  }

  private async callAnthropicForJudge(prompt: string): Promise<string> {
    return await this.conversationService.callAnthropicForService(prompt);
  }

  /**
   * Minimal JSON cleaning - reduced dependencies on cleanup
   */
  private cleanJsonMinimal(response: string): string {
    if (!response) return '{}';

    let cleaned = response.trim();

    // Remove markdown blocks only
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

    // Extract JSON boundaries
    const openBrace = cleaned.indexOf('{');
    const closeBrace = cleaned.lastIndexOf('}');

    if (openBrace !== -1 && closeBrace > openBrace) {
      return cleaned.substring(openBrace, closeBrace + 1);
    }

    return cleaned;
  }

  /**
   * Parse JSON with enhanced error handling and validation
   */
  private parseJsonWithFallback(jsonString: string, context: string): any {
    if (!jsonString) {
      this.logger.error(`Empty JSON response in ${context}`);
      return this.getContextualFallback(context);
    }

    try {
      const parsed = JSON.parse(jsonString);

      // Validate structure based on context
      if (context.includes('judgment') || context.includes('quality')) {
        if (!parsed.toolName || typeof parsed.isValid !== 'boolean' || !parsed.quality) {
          this.logger.warn(`Invalid judgment structure in ${context}`);
          return this.getContextualFallback(context);
        }
      } else {
        if (!parsed.tools || !Array.isArray(parsed.tools)) {
          this.logger.warn(`Invalid tools structure in ${context}`);
          return this.getContextualFallback(context);
        }
      }

      return parsed;
    } catch (error) {
      this.logger.error(`JSON parsing failed in ${context}: ${error.message}`);
      this.logger.debug(`Failed JSON (first 300 chars): ${jsonString.substring(0, 300)}`);

      // Try basic fixes
      try {
        let fixed = jsonString
          .replace(/,\s*([}\]])/g, '$1') // Remove trailing commas
          .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*):/g, '$1"$2":') // Quote keys
          .replace(/:\s*'([^']*)'/g, ': "$1"'); // Fix single quotes

        const parsed = JSON.parse(fixed);
        this.logger.log(`JSON parsing recovered in ${context}`);
        return parsed;
      } catch (secondError) {
        this.logger.error(`JSON recovery failed in ${context}: ${secondError.message}`);
        return this.getContextualFallback(context);
      }
    }
  }

  private getContextualFallback(context: string): any {
    if (context.includes('judgment') || context.includes('quality')) {
      return {
        toolName: 'unknown',
        isValid: false,
        quality: {
          usefulness: 0.1,
          specificity: 0.1,
          implementability: 0.1,
          uniqueness: 0.1,
          overallScore: 0.1,
          reasoning: `JSON parsing failed in ${context}`
        },
        feedback: 'Could not parse AI response',
        suggestedImprovements: ['Fix response format']
      };
    } else {
      return {
        tools: [],
        reasoning: `JSON parsing failed in ${context}`,
        confidence: 0.0
      };
    }
  }

  private isValidToolSuggestion(suggestion: Partial<McpTool>): boolean {
    return !!(
      suggestion.name &&
      suggestion.description &&
      suggestion.category &&
      suggestion.name.match(/^[a-z_]+$/) // snake_case validation
    );
  }

  private async convertSuggestionToTool(
    suggestion: Partial<McpTool>,
    context: RepositoryContext
  ): Promise<McpTool> {
    // Fill in any missing fields with defaults
    const defaultSchema: JsonSchema = {
      type: 'object',
      properties: {},
      required: []
    };

    const defaultHints: ImplementationHints = {
      primaryAction: suggestion.description || 'Perform operation',
      requiredData: [],
      dependencies: [],
      complexity: 'simple',
      outputFormat: 'text',
      errorHandling: [],
      examples: []
    };

    const defaultQuality: ToolQuality = {
      usefulness: 0.5,
      specificity: 0.5,
      implementability: 0.5,
      uniqueness: 0.5,
      overallScore: 0.5,
      reasoning: 'Default quality assessment'
    };

    return {
      name: suggestion.name!,
      description: suggestion.description!,
      category: suggestion.category!,
      inputSchema: suggestion.inputSchema || defaultSchema,
      implementationHints: suggestion.implementationHints || defaultHints,
      quality: suggestion.quality || defaultQuality
    };
  }
}