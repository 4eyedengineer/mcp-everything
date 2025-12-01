import { Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  GraphState,
  KnowledgeGap,
  ClarificationQuestion,
} from './types';

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

  constructor() {
    // Initialize Claude Haiku for gap detection and question formulation
    this.llm = new ChatAnthropic({
      modelName: 'claude-3-5-haiku-20241022',
      temperature: 0.7,
      maxTokens: 1024,
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

      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('No JSON found in gap detection response');
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);

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

    return `You are an expert at identifying missing information needed for MCP server generation.

Analyze the current state and identify CRITICAL gaps that would block or significantly degrade generation quality.

**User Request**:
"${userInput}"

**Research Summary**:
${research?.synthesizedPlan?.summary || 'No research available'}

**Key Insights**:
${research?.synthesizedPlan?.keyInsights?.join('\n- ') || 'No insights'}

**Ensemble Results**:
- Consensus Score: ${consensusScore.toFixed(2)}
- Tools Recommended: ${ensemble?.agentPerspectives?.[0]?.recommendations?.tools?.length || 0}
- Agent Concerns: ${ensemble?.agentPerspectives?.flatMap(a => a.recommendations.concerns).join(', ') || 'None'}

**Previous Clarifications**: ${state.clarificationHistory?.length || 0} rounds completed

**Task**: Identify gaps that would block successful MCP server generation.

**Gap Categories**:
1. **Ambiguous Requirements**: Unclear tool behaviors, vague descriptions
2. **Missing Technical Details**:
   - API endpoints (base URL, paths)
   - Authentication (API keys, OAuth, tokens)
   - Rate limits (requests per minute, quotas)
   - Data formats (JSON, XML, binary)
3. **Incomplete Specifications**:
   - Input parameters (required vs optional)
   - Output formats (structure, error codes)
   - Edge cases (empty results, errors)

**Priority Levels**:
- **HIGH**: Blocks generation entirely (e.g., missing base API URL)
- **MEDIUM**: Degrades quality significantly (e.g., unclear auth method)
- **LOW**: Nice to have but not critical (e.g., optional parameters)

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

✅ Good Gap:
{
  "issue": "API base URL not specified",
  "priority": "HIGH",
  "suggestedQuestion": "What is the base URL for the API? (e.g., https://api.example.com)",
  "context": "Required to construct endpoint URLs for all tools"
}

❌ Bad Gap:
{
  "issue": "Need more information",
  "priority": "MEDIUM",
  "suggestedQuestion": "Can you provide more details?",
  "context": "To generate better tools"
}

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
}
