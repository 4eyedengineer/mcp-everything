/**
 * Implementation Example: Ensemble Agent Integration
 *
 * This file demonstrates how to integrate the ensemble agent prompts
 * into the MCP Everything ToolDiscoveryService.
 */

import Anthropic from '@anthropic-ai/sdk';
import agentPrompts from './ensemble-agents.json';
import type {
  ResearchPhaseData,
  AgentResponse,
  WeightedToolRecommendation,
  EnsembleVotingResult,
  AgentWeights,
  AgentMetrics,
  EnsembleValidation,
} from './ensemble-agents.types';

// ============================================================================
// Configuration
// ============================================================================

const ANTHROPIC_CONFIG = {
  model: 'claude-haiku-3.5-20240307',
  maxTokens: 2000,
  temperature: 0.3, // Low temperature for consistency
};

const AGENT_WEIGHTS: AgentWeights = {
  architectAgent: 1.0,
  securityAgent: 0.8,
  performanceAgent: 0.8,
  mcpSpecialistAgent: 1.2, // Highest weight - protocol compliance critical
};

const VOTING_CONFIG = {
  minConsensus: 0.5, // At least 50% of weighted votes
  topToolsCount: 10,
  schemaConflictResolution: 'MCP_SPECIALIST_WINS' as const,
};

// ============================================================================
// Core Implementation
// ============================================================================

export class EnsembleAgentService {
  private readonly anthropic: Anthropic;

  constructor(apiKey: string) {
    this.anthropic = new Anthropic({ apiKey });
  }

  /**
   * Execute all 4 agents in parallel and aggregate recommendations
   */
  async executeEnsembleVoting(
    researchData: ResearchPhaseData,
  ): Promise<EnsembleVotingResult> {
    const startTime = Date.now();

    // Parallel execution for 4x speed improvement
    const agentPromises = [
      this.callAgent('architectAgent', researchData),
      this.callAgent('securityAgent', researchData),
      this.callAgent('performanceAgent', researchData),
      this.callAgent('mcpSpecialistAgent', researchData),
    ];

    const results = await Promise.allSettled(agentPromises);

    // Extract successful responses
    const recommendations: AgentResponse[] = [];
    const errors: string[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        recommendations.push(result.value.response);
      } else {
        errors.push(result.reason?.message || 'Unknown error');
      }
    }

    // Require at least 3/4 agents to succeed
    if (recommendations.length < 3) {
      throw new Error(
        `Insufficient agent responses: ${recommendations.length}/4 succeeded. Errors: ${errors.join(', ')}`,
      );
    }

    // Weighted voting
    const topTools = this.weightedVote(recommendations);

    // Calculate consensus level
    const consensusLevel = this.calculateConsensusLevel(recommendations, topTools);

    // Calculate overall confidence
    const overallConfidence = this.calculateOverallConfidence(recommendations);

    const totalTime = Date.now() - startTime;
    const totalCost = this.estimateCost(recommendations);

    return {
      topTools,
      allRecommendations: recommendations,
      consensusLevel,
      overallConfidence,
      votingMetadata: {
        totalAgents: 4,
        successfulResponses: recommendations.length,
        averageResponseTime: totalTime / recommendations.length,
        totalCost,
      },
    };
  }

  /**
   * Call individual agent with research data
   */
  private async callAgent(
    agentName: keyof typeof agentPrompts,
    researchData: ResearchPhaseData,
  ): Promise<{
    response: AgentResponse;
    metadata: { tokenCount: { input: number; output: number }; responseTime: number; cost: number };
  }> {
    const startTime = Date.now();
    const agentConfig = agentPrompts[agentName];

    const userMessage = `${agentConfig.systemPrompt}\n\nAnalyze this research data and provide tool recommendations:\n\n${JSON.stringify(researchData, null, 2)}`;

    try {
      const response = await this.anthropic.messages.create({
        model: ANTHROPIC_CONFIG.model,
        max_tokens: ANTHROPIC_CONFIG.maxTokens,
        temperature: ANTHROPIC_CONFIG.temperature,
        messages: [
          {
            role: 'user',
            content: userMessage,
          },
        ],
      });

      const responseTime = Date.now() - startTime;
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;

      // Parse JSON response
      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Expected text response from agent');
      }

      const agentResponse: AgentResponse = JSON.parse(content.text);

      // Validate response structure
      this.validateAgentResponse(agentResponse, agentName);

      return {
        response: agentResponse,
        metadata: {
          tokenCount: { input: inputTokens, output: outputTokens },
          responseTime,
          cost: this.calculateCost(inputTokens, outputTokens),
        },
      };
    } catch (error) {
      throw new Error(`Agent ${agentName} failed: ${error.message}`);
    }
  }

  /**
   * Weighted voting algorithm
   */
  private weightedVote(recommendations: AgentResponse[]): WeightedToolRecommendation[] {
    const toolMap = new Map<string, WeightedToolRecommendation>();

    for (const rec of recommendations) {
      const weight = AGENT_WEIGHTS[rec.agentName];
      const confidence = rec.confidence;

      for (const tool of rec.recommendations.tools) {
        if (!toolMap.has(tool.name)) {
          toolMap.set(tool.name, {
            ...tool,
            votes: 0,
            sources: [],
            averageConfidence: 0,
            consensusSchema: tool.inputSchema,
          });
        }

        const existing = toolMap.get(tool.name)!;

        // Weighted vote: agent weight × agent confidence
        existing.votes += weight * confidence;
        existing.sources.push(rec.agentName);

        // Update average confidence
        const totalConfidence = existing.averageConfidence * (existing.sources.length - 1) + confidence;
        existing.averageConfidence = totalConfidence / existing.sources.length;

        // Schema conflict resolution: MCP specialist wins
        if (
          rec.agentName === 'mcpSpecialistAgent' ||
          VOTING_CONFIG.schemaConflictResolution === 'MCP_SPECIALIST_WINS'
        ) {
          existing.consensusSchema = tool.inputSchema;
        }

        // Aggregate security enhancements
        if (rec.agentName === 'securityAgent') {
          existing.securityEnhancements = {
            validationConstraints: this.extractValidationConstraints(tool.inputSchema),
            authRequirements: this.extractAuthRequirements(tool.description),
            riskLevel: this.assessRiskLevel(tool),
          };
        }

        // Aggregate performance characteristics
        if (rec.agentName === 'performanceAgent') {
          existing.performanceCharacteristics = {
            expectedResponseTime: this.extractResponseTime(tool.description),
            cachingStrategy: this.extractCachingStrategy(tool.inputSchema),
            rateLimitConsiderations: this.extractRateLimits(tool.description),
          };
        }
      }
    }

    // Sort by weighted votes and return top N
    return Array.from(toolMap.values())
      .sort((a, b) => b.votes - a.votes)
      .slice(0, VOTING_CONFIG.topToolsCount);
  }

  /**
   * Calculate consensus level (how much agents agreed)
   */
  private calculateConsensusLevel(
    recommendations: AgentResponse[],
    topTools: WeightedToolRecommendation[],
  ): number {
    const toolsWithMultipleSources = topTools.filter((tool) => tool.sources.length >= 2);
    return toolsWithMultipleSources.length / topTools.length;
  }

  /**
   * Calculate overall confidence (weighted average)
   */
  private calculateOverallConfidence(recommendations: AgentResponse[]): number {
    let totalWeightedConfidence = 0;
    let totalWeight = 0;

    for (const rec of recommendations) {
      const weight = AGENT_WEIGHTS[rec.agentName];
      totalWeightedConfidence += rec.confidence * weight;
      totalWeight += weight;
    }

    return totalWeightedConfidence / totalWeight;
  }

  /**
   * Validate agent response structure
   */
  private validateAgentResponse(response: AgentResponse, expectedAgentName: string): void {
    if (!response.agentName || response.agentName !== expectedAgentName) {
      throw new Error(`Invalid agentName: expected ${expectedAgentName}, got ${response.agentName}`);
    }

    if (!response.recommendations || !Array.isArray(response.recommendations.tools)) {
      throw new Error('Missing or invalid recommendations.tools array');
    }

    if (typeof response.confidence !== 'number' || response.confidence < 0 || response.confidence > 1) {
      throw new Error('Invalid confidence score (must be 0.0-1.0)');
    }

    // Validate each tool
    for (const tool of response.recommendations.tools) {
      this.validateTool(tool);
    }
  }

  /**
   * Validate individual tool recommendation
   */
  private validateTool(tool: any): void {
    const required = ['name', 'description', 'inputSchema', 'outputFormat', 'priority', 'estimatedComplexity'];

    for (const field of required) {
      if (!tool[field]) {
        throw new Error(`Tool missing required field: ${field}`);
      }
    }

    // Validate naming convention: lowercase_underscore
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name} (must be lowercase_underscore)`);
    }

    // Validate JSON Schema structure
    if (tool.inputSchema.type !== 'object' || !tool.inputSchema.properties) {
      throw new Error(`Invalid JSON Schema for tool: ${tool.name}`);
    }
  }

  /**
   * Calculate API cost for Haiku tokens
   */
  private calculateCost(inputTokens: number, outputTokens: number): number {
    const INPUT_COST_PER_MILLION = 0.8;
    const OUTPUT_COST_PER_MILLION = 4.0;

    return (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION + (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION;
  }

  /**
   * Estimate total cost for all agent calls
   */
  private estimateCost(recommendations: AgentResponse[]): number {
    // Average: 500 input tokens + 1500 output tokens per agent
    const AVG_INPUT_TOKENS = 500;
    const AVG_OUTPUT_TOKENS = 1500;

    return recommendations.reduce((total, _) => {
      return total + this.calculateCost(AVG_INPUT_TOKENS, AVG_OUTPUT_TOKENS);
    }, 0);
  }

  // ============================================================================
  // Helper Methods for Schema Analysis
  // ============================================================================

  private extractValidationConstraints(schema: any): string[] {
    const constraints: string[] = [];
    for (const [key, prop] of Object.entries(schema.properties || {})) {
      const p = prop as any;
      if (p.pattern) constraints.push(`${key}: pattern=${p.pattern}`);
      if (p.minLength) constraints.push(`${key}: minLength=${p.minLength}`);
      if (p.maxLength) constraints.push(`${key}: maxLength=${p.maxLength}`);
      if (p.enum) constraints.push(`${key}: enum=${p.enum.join('|')}`);
    }
    return constraints;
  }

  private extractAuthRequirements(description: string): string[] {
    const requirements: string[] = [];
    if (/api[_ ]?key/i.test(description)) requirements.push('API Key');
    if (/oauth/i.test(description)) requirements.push('OAuth');
    if (/token/i.test(description)) requirements.push('Bearer Token');
    return requirements;
  }

  private assessRiskLevel(tool: any): 'low' | 'medium' | 'high' {
    const desc = tool.description.toLowerCase();
    if (desc.includes('delete') || desc.includes('remove') || desc.includes('drop')) return 'high';
    if (desc.includes('create') || desc.includes('update') || desc.includes('modify')) return 'medium';
    return 'low';
  }

  private extractResponseTime(description: string): string {
    if (/fast|quick|instant/i.test(description)) return '<100ms';
    if (/slow|heavy|large/i.test(description)) return '>1s';
    return '100ms-1s';
  }

  private extractCachingStrategy(schema: any): string | undefined {
    for (const prop of Object.values(schema.properties || {})) {
      const p = prop as any;
      if (p.description && /cache/i.test(p.description)) {
        return p.description;
      }
    }
    return undefined;
  }

  private extractRateLimits(description: string): string | undefined {
    const match = description.match(/(\d+)\s*(req|request)s?\s*\/\s*(hour|min|sec)/i);
    return match ? match[0] : undefined;
  }
}

// ============================================================================
// NestJS Service Integration Example
// ============================================================================

/**
 * Example integration into ToolDiscoveryService
 */
export class ToolDiscoveryService {
  private readonly ensembleService: EnsembleAgentService;

  constructor(private readonly anthropicApiKey: string) {
    this.ensembleService = new EnsembleAgentService(anthropicApiKey);
  }

  /**
   * Main entry point: discover tools from research data
   */
  async discoverTools(researchData: ResearchPhaseData): Promise<WeightedToolRecommendation[]> {
    console.log('Starting ensemble voting...');

    const result = await this.ensembleService.executeEnsembleVoting(researchData);

    console.log(`Ensemble voting complete:
      - Top tools: ${result.topTools.length}
      - Consensus level: ${(result.consensusLevel * 100).toFixed(1)}%
      - Overall confidence: ${(result.overallConfidence * 100).toFixed(1)}%
      - Total cost: $${result.votingMetadata.totalCost.toFixed(4)}
      - Avg response time: ${result.votingMetadata.averageResponseTime.toFixed(0)}ms
    `);

    // Log top 5 tools
    console.log('\nTop 5 recommended tools:');
    for (const [i, tool] of result.topTools.slice(0, 5).entries()) {
      console.log(
        `  ${i + 1}. ${tool.name} (${tool.votes.toFixed(2)} votes, ${tool.sources.length} agents, ${(tool.averageConfidence * 100).toFixed(0)}% confidence)`,
      );
    }

    return result.topTools;
  }

  /**
   * Validate tool recommendations against MCP protocol
   */
  async validateToolRecommendations(tools: WeightedToolRecommendation[]): Promise<EnsembleValidation> {
    const validations = tools.map((tool) => this.validateTool(tool));
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const validation of validations) {
      errors.push(...validation.errors);
      warnings.push(...validation.warnings);
    }

    const jsonParseRate = 1.0; // Already parsed successfully
    const schemaValidityRate = validations.filter((v) => v.schemaValid).length / validations.length;
    const protocolComplianceRate = validations.filter((v) => v.namingCompliant && v.hasDescriptions).length / validations.length;
    const recommendationDiversity = new Set(tools.map((t) => t.name)).size / tools.length;

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      jsonParseRate,
      schemaValidityRate,
      protocolComplianceRate,
      recommendationDiversity,
      toolValidations: validations,
    };
  }

  private validateTool(tool: WeightedToolRecommendation): any {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate naming
    const namingCompliant = /^[a-z][a-z0-9_]*$/.test(tool.name);
    if (!namingCompliant) {
      errors.push(`Tool name '${tool.name}' must be lowercase_underscore`);
    }

    // Validate schema
    const schemaValid = tool.inputSchema.type === 'object' && tool.inputSchema.properties !== undefined;
    if (!schemaValid) {
      errors.push(`Tool '${tool.name}' has invalid JSON Schema`);
    }

    // Validate descriptions
    const hasDescriptions = Object.values(tool.inputSchema.properties || {}).every((prop: any) => prop.description);
    if (!hasDescriptions) {
      warnings.push(`Tool '${tool.name}' has parameters without descriptions`);
    }

    // Validate required fields
    const requiredCount = tool.inputSchema.required?.length || 0;
    const requiredFieldsMinimal = requiredCount <= 3;
    if (!requiredFieldsMinimal) {
      warnings.push(`Tool '${tool.name}' has ${requiredCount} required fields (recommend ≤3)`);
    }

    // Validate output format
    const outputFormatSpecified = tool.outputFormat && tool.outputFormat.length > 10;
    if (!outputFormatSpecified) {
      warnings.push(`Tool '${tool.name}' has vague output format`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      toolName: tool.name,
      schemaValid,
      namingCompliant,
      hasDescriptions,
      requiredFieldsMinimal,
      outputFormatSpecified,
    };
  }
}

// ============================================================================
// Usage Example
// ============================================================================

async function main() {
  const service = new ToolDiscoveryService(process.env.ANTHROPIC_API_KEY!);

  // Load test data
  const testData = require('./test-sample-data.json');
  const researchData: ResearchPhaseData = testData.testData;

  // Execute ensemble voting
  const tools = await service.discoverTools(researchData);

  // Validate recommendations
  const validation = await service.validateToolRecommendations(tools);

  console.log(`\nValidation Results:
    - JSON parse rate: ${(validation.jsonParseRate * 100).toFixed(1)}%
    - Schema validity: ${(validation.schemaValidityRate * 100).toFixed(1)}%
    - Protocol compliance: ${(validation.protocolComplianceRate * 100).toFixed(1)}%
    - Recommendation diversity: ${(validation.recommendationDiversity * 100).toFixed(1)}%
    - Errors: ${validation.errors.length}
    - Warnings: ${validation.warnings.length}
  `);

  if (validation.valid) {
    console.log('\n✅ All tools passed validation!');
  } else {
    console.log('\n❌ Validation failed:');
    validation.errors.forEach((error) => console.log(`  - ${error}`));
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
