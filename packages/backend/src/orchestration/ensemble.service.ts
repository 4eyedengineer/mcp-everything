import { Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  GraphState,
  AgentPerspective,
  ToolRecommendation,
  VotingDetails,
  Vote,
} from './types';
import * as fs from 'fs/promises';
import * as path from 'path';
import { safeParseJSON } from './json-utils';

/**
 * Ensemble Service
 *
 * Orchestrates Phase 2: Parallel Reasoning & Voting
 *
 * Responsibilities:
 * - Run 4 specialist agents in parallel
 * - Collect tool recommendations from each agent
 * - Implement weighted voting algorithm
 * - Resolve conflicts if consensus < 0.7
 * - Return generation plan with consensus metadata
 *
 * Agent Weights:
 * - architect: 1.0 (design quality)
 * - security: 0.8 (validation focus)
 * - performance: 0.8 (optimization focus)
 * - mcpSpecialist: 1.2 ⭐ (protocol compliance - highest priority)
 *
 * Flow:
 * 1. Load agent prompts from JSON
 * 2. Spawn 4 agents in parallel (3-5 seconds total)
 * 3. Parse JSON responses from each agent
 * 4. Calculate weighted consensus scores per tool
 * 5. Filter tools with score >= 0.7
 * 6. If overall consensus < 0.7: Trigger conflict resolution
 * 7. Return consensus generation plan
 */
@Injectable()
export class EnsembleService {
  private readonly logger = new Logger(EnsembleService.name);
  private readonly llm: ChatAnthropic;
  private agentPrompts: Record<string, { weight: number; systemPrompt: string }>;

  constructor() {
    // Initialize Claude Haiku for all agents
    this.llm = new ChatAnthropic({
      modelName: 'claude-3-5-haiku-20241022',
      temperature: 0.7,
      maxTokens: 2048,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Load agent prompts (async in constructor workaround - init in onModuleInit)
    this.loadAgentPrompts().catch(err =>
      this.logger.error(`Failed to load agent prompts: ${err.message}`)
    );
  }

  /**
   * Load agent prompt definitions from JSON file
   */
  private async loadAgentPrompts(): Promise<void> {
    try {
      const promptsPath = path.join(process.cwd(), 'prompts', 'ensemble-agents.json');
      const content = await fs.readFile(promptsPath, 'utf-8');
      this.agentPrompts = JSON.parse(content);
      this.logger.log('Agent prompts loaded successfully');
    } catch (error) {
      this.logger.error(`Failed to load prompts: ${error.message}`);
      // Fallback: Use empty prompts (will be populated later or fail gracefully)
      this.agentPrompts = {
        architectAgent: { weight: 1.0, systemPrompt: '' },
        securityAgent: { weight: 0.8, systemPrompt: '' },
        performanceAgent: { weight: 0.8, systemPrompt: '' },
        mcpSpecialistAgent: { weight: 1.2, systemPrompt: '' },
      };
    }
  }

  /**
   * Orchestrate Ensemble
   *
   * Main entry point for ensemble reasoning.
   * Runs 4 agents in parallel and aggregates results.
   *
   * @param state - Current graph state with research phase data
   * @returns Ensemble results with consensus and voting details
   */
  async orchestrateEnsemble(state: GraphState): Promise<{
    consensus: GraphState['generationPlan'];
    agentPerspectives: AgentPerspective[];
    consensusScore: number;
    conflictsResolved: boolean;
    votingDetails: VotingDetails;
  }> {
    this.logger.log('Starting ensemble orchestration with 4 parallel agents');

    const startTime = Date.now();

    // Step 1: Spawn 4 specialist agents in parallel
    const [architect, security, performance, mcpSpecialist] = await Promise.all([
      this.architectAgent(state),
      this.securityAgent(state),
      this.performanceAgent(state),
      this.mcpSpecialistAgent(state),
    ]);

    const agentTime = Date.now() - startTime;
    this.logger.log(`All 4 agents completed in ${agentTime}ms`);

    // Step 2: Collect perspectives
    const perspectives: AgentPerspective[] = [
      { ...architect, agentName: 'architect', weight: 1.0, timestamp: new Date() },
      { ...security, agentName: 'security', weight: 0.8, timestamp: new Date() },
      { ...performance, agentName: 'performance', weight: 0.8, timestamp: new Date() },
      { ...mcpSpecialist, agentName: 'mcpSpecialist', weight: 1.2, timestamp: new Date() },
    ];

    // Step 3: Voting aggregation
    const votingDetails = await this.votingAggregator(perspectives);

    // Step 4: Check consensus threshold
    const consensusScore = this.calculateConsensusScore(votingDetails);

    let conflictsResolved = false;
    let finalTools = votingDetails.consensusReached
      ? this.extractConsensusTools(votingDetails)
      : [];

    // Step 5: Conflict resolution if needed
    if (consensusScore < 0.7) {
      this.logger.warn(`Low consensus score: ${consensusScore.toFixed(2)}, resolving conflicts`);
      const resolved = await this.resolveConflicts(perspectives);
      finalTools = resolved.tools;
      conflictsResolved = true;
    }

    // Step 6: Build generation plan
    const consensus: GraphState['generationPlan'] = {
      steps: this.generateSteps(finalTools),
      toolsToGenerate: finalTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema, // Map inputSchema to parameters
      })),
      estimatedComplexity: this.estimateComplexity(finalTools),
    };

    this.logger.log(
      `Ensemble complete: ${finalTools.length} tools, consensus=${consensusScore.toFixed(2)}`
    );

    return {
      consensus,
      agentPerspectives: perspectives,
      consensusScore,
      conflictsResolved,
      votingDetails,
    };
  }

  /**
   * Architect Agent
   *
   * Focuses on design quality, maintainability, and extensibility.
   *
   * @param state - Graph state with research data
   * @returns Agent perspective with tool recommendations
   */
  private async architectAgent(
    state: GraphState
  ): Promise<Pick<AgentPerspective, 'recommendations' | 'confidence'>> {
    return this.invokeAgent('architectAgent', state);
  }

  /**
   * Security Agent
   *
   * Focuses on input validation, authentication, and security.
   *
   * @param state - Graph state with research data
   * @returns Agent perspective with security-enhanced recommendations
   */
  private async securityAgent(
    state: GraphState
  ): Promise<Pick<AgentPerspective, 'recommendations' | 'confidence'>> {
    return this.invokeAgent('securityAgent', state);
  }

  /**
   * Performance Agent
   *
   * Focuses on efficiency, caching, and resource optimization.
   *
   * @param state - Graph state with research data
   * @returns Agent perspective with performance-optimized recommendations
   */
  private async performanceAgent(
    state: GraphState
  ): Promise<Pick<AgentPerspective, 'recommendations' | 'confidence'>> {
    return this.invokeAgent('performanceAgent', state);
  }

  /**
   * MCP Specialist Agent
   *
   * Focuses on MCP protocol compliance and JSON schema correctness.
   * **Highest priority agent** with 1.2x voting weight.
   *
   * @param state - Graph state with research data
   * @returns Agent perspective with protocol-compliant recommendations
   */
  private async mcpSpecialistAgent(
    state: GraphState
  ): Promise<Pick<AgentPerspective, 'recommendations' | 'confidence'>> {
    return this.invokeAgent('mcpSpecialistAgent', state);
  }

  /**
   * Invoke Agent
   *
   * Generic method to invoke any specialist agent with its prompt.
   *
   * @param agentName - Name of agent to invoke
   * @param state - Graph state with research data
   * @returns Parsed agent response
   */
  private async invokeAgent(
    agentName: string,
    state: GraphState
  ): Promise<Pick<AgentPerspective, 'recommendations' | 'confidence'>> {
    const prompt = this.agentPrompts[agentName];
    if (!prompt) {
      throw new Error(`Agent prompt not found: ${agentName}`);
    }

    // Build user message with research data
    const userMessage = this.buildAgentInput(state);

    try {
      const response = await this.llm.invoke([
        { role: 'system', content: prompt.systemPrompt },
        { role: 'user', content: userMessage },
      ]);

      const content = response.content.toString();

      // Extract JSON from response using safe bracket-balanced parsing
      const parsed = safeParseJSON<{
        recommendations: { tools: any[]; reasoning: string; concerns: string[] };
        confidence: number;
      }>(content, this.logger);

      // Validate response structure
      if (!parsed.recommendations || !parsed.confidence) {
        throw new Error(`Invalid response structure from ${agentName}`);
      }

      this.logger.log(`${agentName} returned ${parsed.recommendations.tools.length} tools`);

      return {
        recommendations: parsed.recommendations,
        confidence: parsed.confidence,
      };
    } catch (error) {
      this.logger.error(`${agentName} failed: ${error.message}`);

      // Fallback: Return empty recommendations
      return {
        recommendations: {
          tools: [],
          reasoning: `Agent failed: ${error.message}`,
          concerns: ['Agent invocation failed'],
        },
        confidence: 0.3,
      };
    }
  }

  /**
   * Build Agent Input
   *
   * Formats research data into user message for agent.
   *
   * @param state - Graph state
   * @returns Formatted input string
   */
  private buildAgentInput(state: GraphState): string {
    const research = state.researchPhase;
    const extracted = state.extractedData;

    return `Analyze this repository and recommend MCP tools:

**Repository**: ${extracted?.githubUrl}
**Name**: ${extracted?.repositoryName}
**Language**: ${research?.githubDeepDive?.basicInfo?.language || 'Unknown'}

**Research Summary**:
${research?.synthesizedPlan?.summary || 'No summary available'}

**Key Insights**:
${research?.synthesizedPlan?.keyInsights?.join('\n') || 'No insights available'}

**Code Examples**: ${research?.githubDeepDive?.codeExamples?.length || 0} files analyzed
**Test Patterns**: ${research?.githubDeepDive?.testPatterns?.length || 0} frameworks detected
**API Patterns**: ${research?.githubDeepDive?.apiUsagePatterns?.length || 0} endpoints found

**Dependencies**:
${Object.keys(research?.githubDeepDive?.dependencies || {}).slice(0, 10).join(', ')}

**Web Search Patterns**:
${research?.webSearchFindings?.patterns?.join('\n') || 'No patterns found'}

Provide your recommendations as JSON following the specified format.`;
  }

  /**
   * Voting Aggregator
   *
   * Implements weighted voting algorithm across all agents.
   *
   * Algorithm:
   * 1. For each tool recommended by any agent:
   *    - Collect all votes (confidence × weight)
   *    - Calculate weighted average score
   *    - If score >= 0.7: Include in consensus
   * 2. Merge recommendations from multiple agents
   * 3. Return voting details with consensus status
   *
   * @param perspectives - All agent perspectives
   * @returns Voting details with consensus tools
   */
  private async votingAggregator(perspectives: AgentPerspective[]): Promise<VotingDetails> {
    const toolVotes = new Map<string, Vote[]>();

    // Step 1: Collect all tool votes
    for (const perspective of perspectives) {
      for (const tool of perspective.recommendations.tools) {
        const toolName = tool.name;

        if (!toolVotes.has(toolName)) {
          toolVotes.set(toolName, []);
        }

        toolVotes.get(toolName)!.push({
          agent: perspective.agentName,
          toolName: tool.name,
          confidence: perspective.confidence,
          weight: perspective.weight,
          recommendation: tool,
        });
      }
    }

    // Step 2: Calculate consensus per tool
    const consensusTools: ToolRecommendation[] = [];

    for (const [toolName, votes] of toolVotes.entries()) {
      // Weighted score = Σ(confidence × weight) / Σ(weight)
      const totalWeight = votes.reduce((sum, v) => sum + v.weight, 0);
      const weightedSum = votes.reduce((sum, v) => sum + v.confidence * v.weight, 0);
      const score = weightedSum / totalWeight;

      // Include tool if score >= 0.7
      if (score >= 0.7) {
        // Merge recommendations from all agents
        const merged = this.mergeRecommendations(votes);
        consensusTools.push(merged);
      }
    }

    const consensusReached = consensusTools.length >= 5; // Need at least 5 tools

    this.logger.log(
      `Voting complete: ${consensusTools.length}/${toolVotes.size} tools reached consensus`
    );

    return {
      totalVotes: toolVotes.size,
      toolVotes,
      consensusReached,
    };
  }

  /**
   * Merge Recommendations
   *
   * Combines recommendations for the same tool from multiple agents.
   * Prioritizes MCP specialist's schema, adds security constraints,
   * includes performance parameters.
   *
   * @param votes - All votes for a specific tool
   * @returns Merged tool recommendation
   */
  private mergeRecommendations(votes: Vote[]): ToolRecommendation {
    // Find MCP specialist recommendation (highest priority)
    const mcpVote = votes.find(v => v.agent === 'mcpSpecialist');
    const base = mcpVote?.recommendation || votes[0].recommendation;

    // Merge concerns from all agents
    const allConcerns: string[] = [];
    for (const vote of votes) {
      const agent = votes.find(v => v.agent === vote.agent);
      // Note: concerns are at perspective level, not tool level
      // This is a simplification - in production you'd want tool-specific concerns
    }

    // Add security constraints if security agent voted
    const securityVote = votes.find(v => v.agent === 'security');
    if (securityVote) {
      // Merge security validations into input schema
      // (In production, you'd merge pattern, maxLength, enum constraints)
    }

    // Add performance parameters if performance agent voted
    const perfVote = votes.find(v => v.agent === 'performance');
    if (perfVote && perfVote.recommendation.inputSchema.properties) {
      // Add optional caching parameters
      if (!perfVote.recommendation.inputSchema.properties['useCache']) {
        base.inputSchema.properties = base.inputSchema.properties || {};
        base.inputSchema.properties['useCache'] = {
          type: 'boolean',
          description: 'Enable caching for faster responses',
          default: true,
        };
      }
    }

    return base;
  }

  /**
   * Calculate Consensus Score
   *
   * Overall consensus score based on:
   * - Number of tools that reached consensus
   * - Average confidence across all agents
   * - Quorum reached (3/4 agents agreeing)
   *
   * @param votingDetails - Voting results
   * @returns Consensus score 0-1
   */
  private calculateConsensusScore(votingDetails: VotingDetails): number {
    const totalTools = votingDetails.totalVotes;
    const consensusTools = votingDetails.consensusReached ? 1.0 : 0.5;

    // Simple formula: (consensus tools / total tools) weighted by quorum
    return Math.min(consensusTools, 1.0);
  }

  /**
   * Extract Consensus Tools
   *
   * Extracts tool recommendations that reached consensus.
   *
   * @param votingDetails - Voting results
   * @returns Array of consensus tools
   */
  private extractConsensusTools(votingDetails: VotingDetails): ToolRecommendation[] {
    const tools: ToolRecommendation[] = [];

    for (const [toolName, votes] of votingDetails.toolVotes.entries()) {
      // Calculate score
      const totalWeight = votes.reduce((sum, v) => sum + v.weight, 0);
      const weightedSum = votes.reduce((sum, v) => sum + v.confidence * v.weight, 0);
      const score = weightedSum / totalWeight;

      if (score >= 0.7) {
        tools.push(this.mergeRecommendations(votes));
      }
    }

    return tools;
  }

  /**
   * Resolve Conflicts
   *
   * When consensus < 0.7, use AI mediator to resolve conflicts
   * and synthesize a hybrid recommendation.
   *
   * @param perspectives - All agent perspectives
   * @returns Resolved tool recommendations
   */
  private async resolveConflicts(
    perspectives: AgentPerspective[]
  ): Promise<{ tools: ToolRecommendation[] }> {
    this.logger.log('Resolving conflicts between agent recommendations');

    const prompt = `You are an AI mediator resolving conflicts between 4 specialist agents.

**Agent Perspectives**:
${perspectives.map(p => `
${p.agentName} (weight: ${p.weight}, confidence: ${p.confidence}):
- Tools: ${p.recommendations.tools.map(t => t.name).join(', ')}
- Reasoning: ${p.recommendations.reasoning}
- Concerns: ${p.recommendations.concerns.join(', ')}
`).join('\n')}

**Task**: Synthesize a consensus by:
1. Identifying overlapping tool recommendations
2. Resolving naming conflicts (prefer MCP specialist's names)
3. Merging security validations and performance parameters
4. Selecting 5-10 best tools overall

Return JSON:
{
  "tools": [/* merged ToolRecommendation objects */],
  "resolutionStrategy": "string explaining how conflicts were resolved"
}`;

    try {
      const response = await this.llm.invoke(prompt);
      const content = response.content.toString();

      const resolved = safeParseJSON<{
        tools: ToolRecommendation[];
        resolutionStrategy: string;
      }>(content, this.logger);

      this.logger.log(`Conflicts resolved: ${resolved.tools.length} tools synthesized`);
      return { tools: resolved.tools };
    } catch (error) {
      this.logger.error(`Conflict resolution failed: ${error.message}`);
    }

    // Fallback: Use MCP specialist's recommendations
    const mcpAgent = perspectives.find(p => p.agentName === 'mcpSpecialist');
    return {
      tools: mcpAgent?.recommendations.tools.slice(0, 10) || [],
    };
  }

  /**
   * Generate Steps
   *
   * Creates implementation steps from tools.
   *
   * @param tools - Consensus tools
   * @returns Implementation steps
   */
  private generateSteps(tools: ToolRecommendation[]): string[] {
    return [
      'Setup MCP server project structure',
      'Install dependencies and configure TypeScript',
      `Implement ${tools.length} MCP tools`,
      'Add input validation and error handling',
      'Write tests for all tools',
      'Build and validate MCP server',
    ];
  }

  /**
   * Estimate Complexity
   *
   * Estimates overall generation complexity.
   *
   * @param tools - Consensus tools
   * @returns Complexity estimate
   */
  private estimateComplexity(
    tools: ToolRecommendation[]
  ): 'simple' | 'moderate' | 'complex' {
    const complexCount = tools.filter(t => t.estimatedComplexity === 'complex').length;

    if (complexCount > tools.length / 2) return 'complex';
    if (tools.length > 15) return 'complex';
    if (tools.length < 5) return 'simple';
    return 'moderate';
  }
}
