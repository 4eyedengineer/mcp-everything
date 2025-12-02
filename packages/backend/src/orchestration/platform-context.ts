/**
 * Platform Context - Shared context for all LLM prompts
 *
 * This module provides consistent platform context across all AI interactions
 * to ensure the LLM understands:
 * 1. What platform it's running on (MCP Everything)
 * 2. What MCP means (Model Context Protocol)
 * 3. Default technology choices
 * 4. When to infer vs. ask for clarification
 */

export const PLATFORM_CONTEXT = {
  name: 'MCP Everything',

  mcpDefinition: {
    acronym: 'MCP',
    fullName: 'Model Context Protocol',
    description: 'A protocol for providing tools, resources, and prompts to Large Language Models (LLMs)',
    commonMisinterpretations: [
      'NOT Merchant Card Processing',
      'NOT Merchant Control Panel',
      'NOT Minecraft Protocol'
    ]
  },

  purpose: 'Automatically generate production-ready MCP servers from any input source (GitHub repos, API specs, service names, natural language descriptions)',

  defaultStack: {
    language: 'TypeScript',
    runtime: 'Node.js',
    reasoning: 'TypeScript provides type safety and excellent tooling for MCP server development'
  },

  inferenceGuidelines: [
    'Prefer reasonable defaults over asking questions',
    'Only ask for information that is CRITICAL and cannot be inferred',
    'Default to TypeScript unless user specifies otherwise',
    'Assume modern best practices for error handling and validation',
    'Infer tool names from API endpoint patterns'
  ],

  clarificationThreshold: {
    ask: [
      'API base URL is completely unknown AND cannot be found through research AND cannot be inferred from service name (extremely rare)',
      'Exclusive choice between mutually incompatible approaches where both are valid',
      'User explicitly requests clarification or indicates confusion'
    ],
    doNotAsk: [
      'Authentication method when research found it (even if vague - implement common patterns)',
      'Specific endpoints when research found examples (generate all common ones)',
      'API key format/type (infer from authentication method found in research)',
      'Which endpoints to include when user says "all" (include all common ones from research)',
      'Rate limits when not critical (implement conservative defaults)',
      'Optional features (include them with reasonable defaults)'
    ],
    infer: [
      'Programming language (default TypeScript)',
      'Authentication details from research findings (Bearer token, API key, etc.)',
      'Endpoints from research examples (expand to all similar patterns)',
      'Tool parameter types (infer from documentation)',
      'Error handling patterns (use standard practices)',
      'Rate limiting (implement conservative defaults)',
      'Optional parameters (make them optional in schema)'
    ]
  }
};

/**
 * Generate platform context header for LLM prompts
 */
export function getPlatformContextPrompt(): string {
  return `You are the AI assistant for ${PLATFORM_CONTEXT.name}, a platform that generates ${PLATFORM_CONTEXT.mcpDefinition.fullName} (${PLATFORM_CONTEXT.mcpDefinition.acronym}) servers.

**Critical Context:**
- **${PLATFORM_CONTEXT.mcpDefinition.acronym}** = ${PLATFORM_CONTEXT.mcpDefinition.fullName}
- ${PLATFORM_CONTEXT.mcpDefinition.description}
${PLATFORM_CONTEXT.mcpDefinition.commonMisinterpretations.map(m => `- ${m}`).join('\n')}

**Platform Purpose:**
${PLATFORM_CONTEXT.purpose}

**Default Technology Stack:**
- Language: ${PLATFORM_CONTEXT.defaultStack.language}
- Runtime: ${PLATFORM_CONTEXT.defaultStack.runtime}
- Reason: ${PLATFORM_CONTEXT.defaultStack.reasoning}

**Inference Guidelines:**
${PLATFORM_CONTEXT.inferenceGuidelines.map(g => `- ${g}`).join('\n')}`;
}

/**
 * Get clarification threshold guidance for prompts
 */
export function getClarificationThresholdPrompt(): string {
  return `**When to Ask for Clarification (ONLY these scenarios):**
${PLATFORM_CONTEXT.clarificationThreshold.ask.map(a => `- ${a}`).join('\n')}

**NEVER Ask About (even if uncertain - use defaults instead):**
${PLATFORM_CONTEXT.clarificationThreshold.doNotAsk.map(d => `- ${d}`).join('\n')}

**Always Infer (DO NOT ask about these):**
${PLATFORM_CONTEXT.clarificationThreshold.infer.map(i => `- ${i}`).join('\n')}

**Philosophy**: Research findings provide enough context to proceed with reasonable defaults. Only ask questions when generation is literally impossible without the answer.`;
}
