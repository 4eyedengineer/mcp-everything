import { Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  GraphState,
  KnowledgeGap,
  ClarificationQuestion,
  RequiredEnvVar,
} from './types';
import { getPlatformContextPrompt, getClarificationThresholdPrompt } from './platform-context';
import { EnvVariableService } from '../env-variable.service';
import { CollectedEnvVar } from '../types/env-variable.types';
import { safeParseJSON } from './json-utils';

/**
 * Clarification Service
 *
 * Orchestrates Phase 3: Iterative Clarification
 *
 * Responsibilities:
 * - AI-powered gap detection in user requirements
 * - Formulate targeted clarification questions
 * - Track clarification history (max 3 rounds)
 * - Determine when enough information is gathered
 *
 * Flow:
 * 1. Analyze user input, research, and ensemble results
 * 2. AI detects gaps (HIGH, MEDIUM, LOW priority)
 * 3. Formulate 1-2 specific questions
 * 4. Pause execution (needsUserInput = true)
 * 5. Resume after user responds
 * 6. Repeat if needed (max 3 rounds)
 *
 * Gap Detection Categories:
 * - Ambiguous requirements (unclear tool behaviors)
 * - Missing technical details (API keys, endpoints, auth methods)
 * - Incomplete specifications (input/output formats)
 *
 * Design Principle:
 * Ask targeted, specific questions rather than generic "tell me more"
 */
@Injectable()
export class ClarificationService {
  private readonly logger = new Logger(ClarificationService.name);
  private readonly llm: ChatAnthropic;

  constructor(private readonly envVariableService: EnvVariableService) {
    // Initialize Claude Haiku for gap detection and question formulation
    this.llm = new ChatAnthropic({
      modelName: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      topP: undefined, // Fix for @langchain/anthropic bug sending top_p: -1
      maxTokens: 8000, // Generous limit for clarification questions
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Orchestrate Clarification
   *
   * Main entry point for clarification phase.
   * Detects gaps and formulates questions if needed.
   *
   * @param state - Current graph state
   * @returns Clarification result with questions or completion status
   */
  async orchestrateClarification(state: GraphState): Promise<{
    complete: boolean;
    gaps: KnowledgeGap[];
    questions?: ClarificationQuestion[];
    needsUserInput: boolean;
  }> {
    this.logger.log('Starting clarification orchestration');

    // Check if we've hit max rounds
    const clarificationRounds = state.clarificationHistory?.length || 0;
    if (clarificationRounds >= 3) {
      this.logger.log('Max clarification rounds (3) reached, proceeding with available info');
      return { complete: true, gaps: [], needsUserInput: false };
    }

    // Step 1: Detect gaps using AI
    const gaps = await this.detectGaps(state);

    // Step 2: Check if clarification is needed
    if (gaps.length === 0) {
      this.logger.log('No gaps detected, clarification complete');
      return { complete: true, gaps: [], needsUserInput: false };
    }

    this.logger.log(`Detected ${gaps.length} knowledge gaps`);

    // Step 3: Formulate questions
    const questions = await this.formulateQuestions(gaps);

    // Step 4: Return clarification request (max 2 questions at a time)
    return {
      complete: false,
      gaps,
      questions: questions.slice(0, 2),
      needsUserInput: true,
    };
  }

  /**
   * Detect Gaps
   *
   * Uses AI to analyze current state and identify missing information
   * that would block or degrade MCP server generation.
   *
   * Analysis considers:
   * - User input clarity
   * - Research completeness
   * - Ensemble consensus quality
   * - Technical detail availability
   *
   * @param state - Current graph state
   * @returns Array of knowledge gaps with priority
   */
  private async detectGaps(state: GraphState): Promise<KnowledgeGap[]> {
    const prompt = this.buildGapDetectionPrompt(state);

    try {
      const response = await this.llm.invoke(prompt);
      const content = response.content.toString();

      // Extract JSON from response using safe bracket-balanced parsing
      const parsed = safeParseJSON<{ gaps: KnowledgeGap[] }>(content, this.logger);

      // Validate response structure
      if (!parsed.gaps || !Array.isArray(parsed.gaps)) {
        this.logger.warn('Invalid gap detection response structure');
        return [];
      }

      // Filter to HIGH and MEDIUM priority gaps only
      const criticalGaps = parsed.gaps.filter(
        (gap: KnowledgeGap) => gap.priority === 'HIGH' || gap.priority === 'MEDIUM'
      );

      this.logger.log(`Found ${criticalGaps.length} critical gaps (${parsed.gaps.length} total)`);

      return criticalGaps;
    } catch (error) {
      this.logger.error(`Gap detection failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Build Gap Detection Prompt
   *
   * Constructs prompt for AI gap detection with all available context.
   *
   * @param state - Graph state
   * @returns Formatted prompt
   */
  private buildGapDetectionPrompt(state: GraphState): string {
    const userInput = state.userInput;
    const research = state.researchPhase;
    const ensemble = state.ensembleResults;
    const consensusScore = ensemble?.consensusScore || 0;

    return `${getPlatformContextPrompt()}

**Task**: Identify ONLY THE MOST CRITICAL missing information for MCP server generation.

**Philosophy**: Generate with reasonable defaults rather than asking endless questions. Prefer inference over interrogation.

${getClarificationThresholdPrompt()}

**User Request**:
"${userInput}"

**Research Summary**:
${research?.synthesizedPlan?.summary || 'No research available'}

**Key Insights**:
${research?.synthesizedPlan?.keyInsights?.join('\n- ') || 'No insights'}

**API Research Findings**:
${research?.webSearchFindings?.results?.map((r: any) => `- ${r.title}: ${r.snippet}`).join('\n') || 'No API details found'}

**Best Practices from Research**:
${research?.webSearchFindings?.bestPractices?.join('\n- ') || 'None'}

**Ensemble Results**:
- Consensus Score: ${consensusScore.toFixed(2)}
- Tools Recommended: ${ensemble?.agentPerspectives?.[0]?.recommendations?.tools?.length || 0}
- Agent Concerns: ${ensemble?.agentPerspectives?.flatMap(a => a.recommendations.concerns).join(', ') || 'None'}

**Previous Clarifications**: ${state.clarificationHistory?.length || 0} rounds completed

**Task**: Identify gaps that would block successful MCP server generation. BE EXTREMELY CONSERVATIVE.

**What is NOT a Gap (DO NOT report these)**:
❌ "Base URL not confirmed" when research found https://api.stripe.com/v1 → NOT A GAP
❌ "API key type unclear" when research found "api_key" or "Bearer token" → NOT A GAP
❌ "Which endpoints" when research found /charges, /customers, /payment_intents → NOT A GAP
❌ "Rate limits unknown" → NOT A GAP (use conservative defaults)
❌ Any "confirmation" questions when research already provided the answer → NOT A GAP

**What IS a Gap (ONLY report these)**:
✅ API base URL is completely unknown AND service name provides no clues (EXTREMELY RARE)
✅ User explicitly said "I don't know" or asked for help deciding

**Research Already Provided** (from above):
- Base URL: ${research?.webSearchFindings?.bestPractices?.find((p: string) => p.includes('Base URL'))?.split(': ')[1] || 'Found in research'}
- Authentication: ${research?.webSearchFindings?.bestPractices?.find((p: string) => p.includes('Authentication'))?.split(': ')[1] || 'Found in research'}
- Endpoints: ${research?.webSearchFindings?.results?.filter((r: any) => r.url.includes('/v1/')).map((r: any) => r.title).join(', ') || 'Found in research'}

**If ANY of the above are present in research → DO NOT raise a gap for them.**

**Priority Levels**:
- **HIGH**: Makes generation LITERALLY IMPOSSIBLE - absolutely no way to proceed (e.g., API base URL is completely unknown AND not found in research AND cannot be inferred - EXTREMELY RARE)
- **MEDIUM**: Can work around with reasonable defaults from research findings
- **LOW**: Nice to have but defaults work fine

**CRITICAL RULES**:
1. If research found authentication method (even vague like "api_key" or "Bearer token") → DO NOT raise gap, use that
2. If research found ANY endpoints/examples → DO NOT ask which ones, generate all common ones
3. If user says "all endpoints" → DO NOT ask which specific ones, use all from research
4. If research found base URL or can infer from service name → DO NOT raise gap
5. Only raise HIGH gaps if literally impossible to generate without info

**IMPORTANT**: Only raise HIGH-priority gaps if generation is LITERALLY IMPOSSIBLE. If research provides ANY information, use it with reasonable defaults.

**Output Format** (STRICT JSON):
\`\`\`json
{
  "gaps": [
    {
      "issue": "Specific description of what's missing",
      "priority": "HIGH|MEDIUM|LOW",
      "suggestedQuestion": "Specific question to ask user",
      "context": "Why this information is needed"
    }
  ]
}
\`\`\`

**Quality Guidelines**:
- Only identify gaps where information is ACTUALLY missing from the state
- Don't invent problems if research already provides the answer
- Focus on blockers first (HIGH priority)
- Be specific: "Missing API base URL" not "Need more API details"
- Suggest actionable questions, not vague "tell me more"

**Examples**:

✅ Good Response (when research found everything):
{
  "gaps": []
}

✅ Good Gap (EXTREMELY RARE):
{
  "issue": "API base URL completely unknown and cannot be inferred from service name 'MyCustomAPI'",
  "priority": "HIGH",
  "suggestedQuestion": "What is the base URL for MyCustomAPI? (e.g., https://api.example.com)",
  "context": "Cannot construct any endpoint URLs without this information"
}

❌ Bad Gap (research already found this):
{
  "issue": "API base URL not confirmed",
  "priority": "HIGH",
  "suggestedQuestion": "Can you confirm the base URL is https://api.stripe.com/v1?",
  "context": "To confirm API endpoint"
}

❌ Bad Gap (vague):
{
  "issue": "Need more information",
  "priority": "MEDIUM",
  "suggestedQuestion": "Can you provide more details?",
  "context": "To generate better tools"
}

**REMINDER**: If research found base URL, authentication, or endpoints → Return {"gaps": []}

Return ONLY valid JSON with detected gaps.`;
  }

  /**
   * Formulate Questions
   *
   * Converts knowledge gaps into clear, actionable clarification questions.
   *
   * Question Design Principles:
   * - Specific and targeted (not "tell me more")
   - Provide examples where helpful
   * - Offer options if applicable (multiple choice)
   * - Explain why the information is needed
   *
   * @param gaps - Knowledge gaps to address
   * @returns Array of clarification questions
   */
  private async formulateQuestions(gaps: KnowledgeGap[]): Promise<ClarificationQuestion[]> {
    // Sort gaps by priority
    const sortedGaps = gaps.sort((a, b) => {
      const priorityOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });

    const questions: ClarificationQuestion[] = [];

    for (const gap of sortedGaps) {
      // Use suggested question from gap detection
      const question: ClarificationQuestion = {
        question: gap.suggestedQuestion,
        context: gap.context,
        required: gap.priority === 'HIGH',
      };

      // Add options if applicable (for common patterns)
      if (gap.issue.toLowerCase().includes('authentication')) {
        question.options = [
          'API Key',
          'OAuth 2.0',
          'Bearer Token',
          'Basic Auth',
          'No authentication required',
        ];
      }

      if (gap.issue.toLowerCase().includes('rate limit')) {
        question.options = [
          'No rate limit',
          'Less than 10 requests/minute',
          '10-100 requests/minute',
          'More than 100 requests/minute',
        ];
      }

      questions.push(question);
    }

    this.logger.log(`Formulated ${questions.length} clarification questions`);

    return questions;
  }

  /**
   * Validate User Response
   *
   * Checks if user response adequately addresses the gap.
   * (Future enhancement for intelligent validation)
   *
   * @param gap - Original knowledge gap
   * @param response - User's response
   * @returns Validation result
   */
  private async validateResponse(
    gap: KnowledgeGap,
    response: string
  ): Promise<{ valid: boolean; reason?: string }> {
    // Basic validation: non-empty response
    if (!response || response.trim().length < 5) {
      return { valid: false, reason: 'Response too short' };
    }

    // TODO: Use AI to validate response quality
    // For now, accept any reasonable response
    return { valid: true };
  }

  /**
   * Extract Information from Response
   *
   * Parses user response to extract structured information.
   * (Future enhancement for automatic information extraction)
   *
   * @param response - User's response
   * @returns Extracted structured data
   */
  private async extractInformation(response: string): Promise<Record<string, any>> {
    // TODO: Use AI to extract structured information from free-text response
    // For MVP, return raw response
    return { rawResponse: response };
  }

  /**
   * Calculate Clarification Confidence
   *
   * Estimates how much the clarification improved generation readiness.
   *
   * @param before - State before clarification
   * @param after - State after clarification
   * @returns Confidence improvement score 0-1
   */
  private calculateConfidenceImprovement(
    before: GraphState,
    after: GraphState
  ): number {
    // Simple heuristic: if gaps reduced, confidence improved
    const gapsBefore = before.clarificationHistory?.length || 0;
    const gapsAfter = after.clarificationHistory?.length || 0;

    if (gapsAfter <= gapsBefore) {
      return 0.2; // Some improvement
    }

    return 0; // No improvement
  }

  // ===== ENVIRONMENT VARIABLE COLLECTION =====

  /**
   * Check if environment variables need to be collected
   *
   * Called after tool discovery to determine if we need to ask
   * the user for API keys and other credentials.
   *
   * @param state - Current graph state with detected env vars
   * @returns Whether env var collection is needed
   */
  needsEnvVarCollection(state: GraphState): boolean {
    const detectedVars = state.detectedEnvVars || [];
    const collectedVars = state.collectedEnvVars || [];

    // Check if there are required env vars that haven't been collected
    const requiredVars = detectedVars.filter(v => v.required);
    const collectedNames = new Set(collectedVars.map(v => v.name));

    const uncollected = requiredVars.filter(v => !collectedNames.has(v.name));

    return uncollected.length > 0;
  }

  /**
   * Generate Environment Variable Clarification Questions
   *
   * Creates specific questions for each detected environment variable
   * that needs to be collected from the user.
   *
   * @param state - Current graph state
   * @returns Clarification result with env var questions
   */
  async generateEnvVarQuestions(state: GraphState): Promise<{
    complete: boolean;
    questions: ClarificationQuestion[];
    needsUserInput: boolean;
    envVarNames: string[];
  }> {
    const detectedVars = state.detectedEnvVars || [];
    const collectedVars = state.collectedEnvVars || [];
    const collectedNames = new Set(collectedVars.map(v => v.name));

    // Find vars that still need to be collected
    const uncollectedVars = detectedVars.filter(v => !collectedNames.has(v.name));

    if (uncollectedVars.length === 0) {
      this.logger.log('All environment variables have been collected');
      return { complete: true, questions: [], needsUserInput: false, envVarNames: [] };
    }

    this.logger.log(`Need to collect ${uncollectedVars.length} environment variables`);

    // Generate questions using the EnvVariableService
    const envVarQuestions = this.envVariableService.generateClarificationQuestions(uncollectedVars);

    // Convert to ClarificationQuestion format (max 2 at a time)
    const questions: ClarificationQuestion[] = envVarQuestions.slice(0, 2).map(q => ({
      question: q.question,
      context: q.context,
      options: q.options,
      required: uncollectedVars.find(v => v.name === q.envVarName)?.required ?? true,
    }));

    const envVarNames = envVarQuestions.slice(0, 2).map(q => q.envVarName);

    return {
      complete: false,
      questions,
      needsUserInput: true,
      envVarNames,
    };
  }

  /**
   * Process User's Environment Variable Response
   *
   * Validates and stores the environment variable values provided by the user.
   *
   * @param envVarName - Name of the environment variable
   * @param value - Value provided by the user
   * @param state - Current graph state
   * @returns Updated collected env vars and validation result
   */
  processEnvVarResponse(
    envVarName: string,
    value: string,
    state: GraphState,
  ): {
    collectedEnvVars: CollectedEnvVar[];
    validationResult: { isValid: boolean; errorMessage?: string };
  } {
    const collectedVars = [...(state.collectedEnvVars || [])];

    // Check if user chose to skip
    const isSkipped = value.toLowerCase() === 'skip' || value === '';

    // Validate the value
    const validationResult = isSkipped
      ? { isValid: true }
      : this.envVariableService.validateEnvVarFormat(envVarName, value);

    // Add to collected vars
    collectedVars.push({
      name: envVarName,
      value: isSkipped ? '' : value,
      validated: validationResult.isValid,
      skipped: isSkipped,
    });

    return {
      collectedEnvVars: collectedVars,
      validationResult,
    };
  }

  /**
   * Create Env Var Knowledge Gaps
   *
   * Converts detected environment variables into knowledge gaps
   * that can be included in the standard clarification flow.
   *
   * @param envVars - Detected environment variables
   * @returns Knowledge gaps for env vars
   */
  createEnvVarGaps(envVars: RequiredEnvVar[]): KnowledgeGap[] {
    return envVars.filter(v => v.required).map(envVar => ({
      issue: `Missing ${envVar.description}`,
      priority: 'HIGH' as const,
      suggestedQuestion: `Please provide your ${envVar.description}${envVar.documentationUrl ? `. You can get it from: ${envVar.documentationUrl}` : ''}`,
      context: `Required for the MCP server to function properly. ${envVar.sensitive ? 'This value will be securely stored.' : ''}`,
    }));
  }
}
