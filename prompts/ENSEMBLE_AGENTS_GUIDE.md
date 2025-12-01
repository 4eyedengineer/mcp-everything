# Ensemble Agents Prompt Engineering Guide

## Overview

This document explains the design strategy for 4 specialized AI agents that analyze research data and vote on MCP tool recommendations. Each agent runs Claude Haiku 3.5 in parallel to provide different perspectives on optimal MCP server design.

## Agent Architecture

```typescript
// Voting System
const weights = {
  architectAgent: 1.0,      // Design quality & maintainability
  securityAgent: 0.8,       // Security & validation
  performanceAgent: 0.8,    // Efficiency & optimization
  mcpSpecialistAgent: 1.2   // MCP protocol compliance ⭐ MOST IMPORTANT
};

// Parallel execution
const recommendations = await Promise.all([
  callAgent('architectAgent', researchData),
  callAgent('securityAgent', researchData),
  callAgent('performanceAgent', researchData),
  callAgent('mcpSpecialistAgent', researchData)
]);

// Weighted voting
const finalTools = weightedVote(recommendations, weights);
```

## Prompt Design Strategy

### 1. Structured Format (Consistency)

Each prompt follows identical structure:
- **Role Definition**: Clear identity and purpose
- **Analysis Framework**: Numbered checklist of what to evaluate
- **Input Data Structure**: TypeScript definition for reference
- **Required Output Format**: Exact JSON schema with example
- **Specific Guidelines**: Role-specific best practices
- **Success Criteria**: Validation checklist

**Why**: Consistent structure reduces hallucination and improves JSON parsing reliability.

### 2. Explicit JSON Schema (Parseability)

Every prompt includes the exact output schema TWICE:
1. TypeScript definition (developer-friendly)
2. Complete JSON example (LLM-friendly)

**Why**: LLMs perform better with concrete examples than abstract schemas. Showing both ensures understanding.

### 3. Role-Specific Constraints (Specialization)

Each agent has a unique analysis framework:
- **Architect**: 5 design principles (Single Responsibility, Consistent Naming, etc.)
- **Security**: 5 security checks (Input Validation, Authentication, etc.)
- **Performance**: 5 optimization strategies (Caching, Batching, etc.)
- **MCP Specialist**: 6 compliance rules (Naming, Schema, Error Handling, etc.)

**Why**: Specialization prevents agents from producing identical recommendations. Each lens reveals different tool design considerations.

### 4. Confidence Scoring (Self-Critique)

All agents must return `confidence: 0.0-1.0` based on:
- Quality of code examples in repository
- Completeness of API documentation
- Clarity of usage patterns
- Presence of tests and examples

**Why**: Confidence scores allow downstream voting to weight recommendations by analysis quality, not just agent weight.

### 5. Token Efficiency (<500 tokens/prompt)

Optimization techniques used:
- **Bullet points** instead of paragraphs
- **Code examples** in triple backticks (more compact than prose)
- **Checklists** instead of explanations
- **Abbreviations** for repeated concepts (MCP, API, JSON)
- **Reference syntax**: "See Input Data Structure above" to avoid repetition

**Why**: Claude Haiku pricing is $0.001/turn. Shorter prompts = lower latency + lower cost at scale.

### 6. Example-Driven Instruction (Clarity)

Critical sections include examples:
- **Tool Naming**: ✅ `get_user` vs ❌ `getUser`
- **JSON Schema**: Complete valid example
- **Output Format**: Exact structure with field types
- **Common Mistakes**: What NOT to do

**Why**: Examples are more effective than rules for LLM instruction. "Show, don't tell."

### 7. Multi-Pass Validation (Quality)

Each prompt embeds validation checkpoints:
- **Input**: "Analyze these 5 aspects..."
- **Processing**: "Apply these design patterns..."
- **Output**: "Validate against these success criteria..."
- **Self-Check**: "Respond ONLY with valid JSON"

**Why**: Multi-pass instructions reduce errors. Agent thinks through analysis → recommendations → validation → output.

## Agent Specialization Details

### Architect Agent (Weight 1.0)

**Focus**: Design quality, maintainability, extensibility

**Key Differentiators**:
- Evaluates code organization and module boundaries
- Recommends tools based on API structure patterns
- Flags poor naming conventions or overlapping functionality
- Considers future extensibility and plugin patterns

**Expected Output**:
- 5-10 tools with clear, distinct purposes
- Consistent naming conventions (verb_noun)
- Minimal, well-designed input schemas
- Concerns about complex APIs or inconsistent patterns

**Confidence Calibration**:
- 0.9+: Well-structured repo with clear modules
- 0.7-0.9: Good structure but some ambiguity
- 0.5-0.7: Complex codebase with unclear boundaries
- <0.5: Poorly organized or undocumented code

### Security Agent (Weight 0.8)

**Focus**: Input validation, authentication, secret handling

**Key Differentiators**:
- Adds validation constraints (pattern, enum, min/max) to ALL inputs
- Identifies authentication requirements per tool
- Flags high-risk operations (file access, shell execution, DB queries)
- Recommends secret management strategies

**Expected Output**:
- 5-10 tools with security-enhanced schemas
- Every string parameter has validation constraints
- 2-5 specific security concerns identified
- High-risk tools marked priority="high"

**Confidence Calibration**:
- 0.8+: Repository has security tests, input validation examples
- 0.6-0.8: Some security practices visible
- 0.4-0.6: No obvious security measures
- <0.4: Security anti-patterns detected

### Performance Agent (Weight 0.8)

**Focus**: Efficiency, caching, rate limiting

**Key Differentiators**:
- Categorizes tools by expected response time (<100ms, 100ms-1s, >1s)
- Adds caching parameters (useCache, ttl) to frequently-called tools
- Suggests batching for operations called repeatedly
- Adds pagination (limit, offset) for large result sets

**Expected Output**:
- 5-10 tools with performance characteristics documented
- Slow operations include caching or batching strategies
- Concerns about rate limits, quotas, timeouts
- Reasoning explains performance trade-offs

**Confidence Calibration**:
- 0.9+: API documentation includes rate limits, response times
- 0.7-0.9: Performance patterns inferable from code
- 0.5-0.7: No explicit performance data
- <0.5: Evidence of performance issues

### MCP Specialist Agent (Weight 1.2) ⭐

**Focus**: MCP protocol compliance, JSON schema correctness

**Key Differentiators** (MOST IMPORTANT AGENT):
- Validates tool names (lowercase_underscore only)
- Ensures JSON schemas are valid Draft 7
- Minimizes required fields (2-3 max per tool)
- Documents exact output formats including errors
- Catches common MCP violations (missing descriptions, invalid types)

**Expected Output**:
- 5-10 tools that are protocol-perfect
- Every tool has complete, valid JSON Schema
- Output formats explicitly documented
- ANY schema issues flagged in concerns array
- High confidence (0.8-0.95) for well-documented repos

**Confidence Calibration**:
- 0.95+: API docs include JSON schemas, examples
- 0.8-0.95: Clear API contracts, good documentation
- 0.6-0.8: Inferable from code but not documented
- <0.6: Ambiguous API patterns or missing docs

**Why Weighted 1.2x**: Protocol compliance is non-negotiable. A brilliant design that violates MCP specs is useless. This agent has veto power on malformed tools.

## Voting Algorithm

```typescript
interface ToolRecommendation {
  name: string;
  votes: number; // weighted sum
  sources: string[]; // which agents recommended
  averageConfidence: number;
  consensusSchema: object; // merged from agent recommendations
}

function weightedVote(
  recommendations: AgentRecommendation[],
  weights: Record<string, number>
): ToolRecommendation[] {
  const toolMap = new Map<string, ToolRecommendation>();

  // Aggregate votes
  for (const rec of recommendations) {
    const weight = weights[rec.agentName];
    const confidence = rec.confidence;

    for (const tool of rec.recommendations.tools) {
      if (!toolMap.has(tool.name)) {
        toolMap.set(tool.name, {
          name: tool.name,
          votes: 0,
          sources: [],
          averageConfidence: 0,
          consensusSchema: tool.inputSchema
        });
      }

      const existing = toolMap.get(tool.name);
      existing.votes += weight * confidence; // weighted by both agent weight AND confidence
      existing.sources.push(rec.agentName);
      existing.averageConfidence =
        (existing.averageConfidence + confidence) / existing.sources.length;

      // Schema merging: MCP specialist wins on conflicts
      if (rec.agentName === 'mcpSpecialistAgent') {
        existing.consensusSchema = tool.inputSchema;
      }
    }
  }

  // Sort by weighted votes
  return Array.from(toolMap.values())
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 10); // Top 10 tools
}
```

## Usage Example

```typescript
import { architectAgent, securityAgent, performanceAgent, mcpSpecialistAgent } from './prompts/ensemble-agents.json';

async function getToolRecommendations(researchData: ResearchPhaseData) {
  const agents = [
    { name: 'architectAgent', prompt: architectAgent.systemPrompt, weight: architectAgent.weight },
    { name: 'securityAgent', prompt: securityAgent.systemPrompt, weight: securityAgent.weight },
    { name: 'performanceAgent', prompt: performanceAgent.systemPrompt, weight: performanceAgent.weight },
    { name: 'mcpSpecialistAgent', prompt: mcpSpecialistAgent.systemPrompt, weight: mcpSpecialistAgent.weight }
  ];

  // Parallel execution
  const recommendations = await Promise.all(
    agents.map(async (agent) => {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-3.5-20240307',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `${agent.prompt}\n\nAnalyze this research data:\n${JSON.stringify(researchData, null, 2)}`
        }]
      });

      return {
        agentName: agent.name,
        weight: agent.weight,
        ...JSON.parse(response.content[0].text)
      };
    })
  );

  // Weighted voting
  return weightedVote(recommendations, {
    architectAgent: 1.0,
    securityAgent: 0.8,
    performanceAgent: 0.8,
    mcpSpecialistAgent: 1.2
  });
}
```

## Prompt Evolution Strategy

### Phase 1: Baseline (Current)
- Template-based prompts with examples
- Explicit JSON schema requirements
- Role-specific guidelines

### Phase 2: Few-Shot Learning (Future)
- Add 2-3 real examples of good tool recommendations
- Include bad examples with explanations
- Fine-tune based on actual generation results

### Phase 3: Self-Critique Loop (Future)
- Add validation step: "Review your recommendations against MCP spec"
- Implement fix loop: "If schema is invalid, correct it"
- Track error patterns and update prompts

### Phase 4: Dynamic Prompts (Future)
- Adjust prompts based on repository type (API wrapper vs library vs CLI)
- Add domain-specific guidelines (database tools, file operations, etc.)
- Personalize based on user feedback patterns

## Cost & Performance Estimates

**Per Generation**:
- 4 agents × 500 tokens/prompt = 2,000 input tokens
- 4 agents × 1,500 tokens/response = 6,000 output tokens
- Total: ~8,000 tokens/generation

**Claude Haiku 3.5 Pricing**:
- Input: $0.80/million tokens
- Output: $4.00/million tokens
- Cost per generation: ~$0.026 (2.6 cents)

**Latency**:
- Parallel execution: ~3-5 seconds (limited by slowest agent)
- Sequential execution: ~12-20 seconds (4× longer)

**Optimization**: Always run agents in parallel. 4× faster for same cost.

## Validation Checklist

Before deploying prompts:

- [ ] All agents return valid JSON (test with sample data)
- [ ] JSON schemas pass Draft 7 validator
- [ ] Tool names follow lowercase_underscore convention
- [ ] Confidence scores are diverse (not all 0.9)
- [ ] Each agent provides unique recommendations (not copying each other)
- [ ] Concerns arrays identify real issues (not generic placeholders)
- [ ] Output format matches expected TypeScript interface
- [ ] Token count < 500 per prompt
- [ ] Examples are clear and actionable
- [ ] Success criteria are measurable

## Debugging Guide

**Issue**: Agents return identical recommendations
**Fix**: Strengthen role-specific constraints, add exclusive evaluation criteria

**Issue**: Invalid JSON output
**Fix**: Add more examples, emphasize "Respond ONLY with valid JSON" instruction

**Issue**: Missing required fields in output
**Fix**: Show complete example JSON in prompt, validate programmatically

**Issue**: Low confidence scores across all agents
**Fix**: Provide better research data quality, improve confidence calibration guidance

**Issue**: MCP specialist disagrees with all other agents
**Fix**: Expected behavior - specialist should catch protocol violations

**Issue**: Tools have 10+ required parameters
**Fix**: Strengthen "minimal required fields" instruction, add negative examples

## Success Metrics

Track these metrics to evaluate prompt effectiveness:

1. **JSON Parse Rate**: % of responses that parse successfully (target: >95%)
2. **Schema Validity**: % of tools with valid JSON Schema (target: >98%)
3. **Protocol Compliance**: % of tools passing MCP validator (target: >90%)
4. **Recommendation Diversity**: Unique tools per agent (target: 60-80%)
5. **Confidence Calibration**: Correlation between confidence and actual quality (target: 0.7+ R²)
6. **Voting Consensus**: % of top-10 tools recommended by 2+ agents (target: 70-90%)
7. **Generation Success Rate**: % of recommended tools that compile and work (target: >85%)

## Files

- `/home/garrett/dev/mcp-everything/prompts/ensemble-agents.json` - Agent prompt definitions
- `/home/garrett/dev/mcp-everything/prompts/ENSEMBLE_AGENTS_GUIDE.md` - This guide

## Integration Points

These prompts integrate with:
- `ToolDiscoveryService` - Executes ensemble voting
- `LangGraph planGeneration node` - Consumes tool recommendations
- `McpGenerationService` - Uses consensus schemas for code generation
- `CodeValidationService` - Validates against MCP protocol compliance

---

**Next Steps**:
1. Test prompts with 5 diverse repositories (API wrapper, CLI tool, library, database client, file processor)
2. Measure JSON parse rate and schema validity
3. Iterate based on failure patterns
4. Add few-shot examples to Phase 2 prompts
5. Implement self-critique loop for Phase 3
