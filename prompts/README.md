# Ensemble Agent Prompts

This directory contains optimized prompts for the MCP Everything ensemble voting system, where 4 specialized AI agents analyze repository research data and recommend MCP tools through weighted voting.

## Files

### Core Prompts
- **`ensemble-agents.json`** - Complete prompt definitions for all 4 agents
  - `architectAgent` (weight: 1.0) - Design quality & maintainability
  - `securityAgent` (weight: 0.8) - Input validation & security
  - `performanceAgent` (weight: 0.8) - Efficiency & optimization
  - `mcpSpecialistAgent` (weight: 1.2) - MCP protocol compliance ⭐

### Documentation
- **`ENSEMBLE_AGENTS_GUIDE.md`** - Comprehensive guide covering:
  - Prompt design strategy (7 key principles)
  - Agent specialization details
  - Voting algorithm implementation
  - Usage examples and integration points
  - Cost & performance estimates
  - Validation checklist and debugging guide
  - Success metrics and evolution strategy

### Type Safety
- **`ensemble-agents.types.ts`** - TypeScript interfaces for:
  - Input data structures (`ResearchPhaseData`)
  - Output data structures (`AgentResponse`, `ToolRecommendation`)
  - Voting system types (`WeightedToolRecommendation`)
  - Validation types (`ToolValidation`, `EnsembleValidation`)
  - Metrics and analytics types

### Testing
- **`test-sample-data.json`** - Sample research data for testing:
  - Real-world example: `octokit/rest.js` (GitHub API client)
  - Expected behavior for each agent
  - Voting expectations with consensus predictions

## Quick Start

### 1. Load Agent Prompts

```typescript
import agentPrompts from './prompts/ensemble-agents.json';

const architectPrompt = agentPrompts.architectAgent.systemPrompt;
const architectWeight = agentPrompts.architectAgent.weight;
```

### 2. Execute Ensemble Voting

```typescript
import type { ResearchPhaseData, AgentResponse } from './prompts/ensemble-agents.types';

async function executeEnsembleVoting(
  researchData: ResearchPhaseData
): Promise<AgentResponse[]> {
  const agents = [
    { name: 'architectAgent', prompt: agentPrompts.architectAgent.systemPrompt },
    { name: 'securityAgent', prompt: agentPrompts.securityAgent.systemPrompt },
    { name: 'performanceAgent', prompt: agentPrompts.performanceAgent.systemPrompt },
    { name: 'mcpSpecialistAgent', prompt: agentPrompts.mcpSpecialistAgent.systemPrompt }
  ];

  // Parallel execution (4x faster than sequential)
  return await Promise.all(
    agents.map(agent => callAnthropicAPI(agent, researchData))
  );
}
```

### 3. Aggregate Votes

```typescript
import type { WeightedToolRecommendation } from './prompts/ensemble-agents.types';

function weightedVote(
  recommendations: AgentResponse[]
): WeightedToolRecommendation[] {
  const weights = {
    architectAgent: 1.0,
    securityAgent: 0.8,
    performanceAgent: 0.8,
    mcpSpecialistAgent: 1.2
  };

  const toolMap = new Map<string, WeightedToolRecommendation>();

  for (const rec of recommendations) {
    const weight = weights[rec.agentName];
    const confidence = rec.confidence;

    for (const tool of rec.recommendations.tools) {
      if (!toolMap.has(tool.name)) {
        toolMap.set(tool.name, {
          ...tool,
          votes: 0,
          sources: [],
          averageConfidence: 0,
          consensusSchema: tool.inputSchema
        });
      }

      const existing = toolMap.get(tool.name);
      existing.votes += weight * confidence;
      existing.sources.push(rec.agentName);
      existing.averageConfidence =
        (existing.averageConfidence + confidence) / existing.sources.length;

      // MCP specialist wins schema conflicts
      if (rec.agentName === 'mcpSpecialistAgent') {
        existing.consensusSchema = tool.inputSchema;
      }
    }
  }

  return Array.from(toolMap.values())
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 10);
}
```

## Prompt Design Principles

### 1. Structured Format
Every prompt follows the same structure:
- Role definition
- Analysis framework
- Input data structure
- Required output format (with examples)
- Specific guidelines
- Success criteria

### 2. Explicit JSON Schema
Output format shown TWICE (TypeScript + JSON example) to reduce parsing errors.

### 3. Role Specialization
Each agent has unique evaluation criteria to prevent duplicate recommendations.

### 4. Confidence Scoring
All agents return `confidence: 0.0-1.0` based on code quality and documentation completeness.

### 5. Token Efficiency
Prompts are <500 tokens each using bullet points, code examples, and abbreviations.

### 6. Example-Driven
Critical sections include concrete examples (✅ good vs ❌ bad).

### 7. Multi-Pass Validation
Prompts embed validation checkpoints: analyze → recommend → validate → output.

## Agent Specializations

### Architect Agent (Weight: 1.0)
- **Focus**: Design quality, maintainability, extensibility
- **Key Output**: Well-structured tools with clear separation of concerns
- **Confidence Range**: 0.5-0.9 (higher for well-organized repos)

### Security Agent (Weight: 0.8)
- **Focus**: Input validation, authentication, secret handling
- **Key Output**: Tools with validation constraints on ALL inputs
- **Confidence Range**: 0.4-0.8 (higher when security tests present)

### Performance Agent (Weight: 0.8)
- **Focus**: Efficiency, caching, rate limiting
- **Key Output**: Tools categorized by response time with optimization strategies
- **Confidence Range**: 0.5-0.9 (higher when performance data available)

### MCP Specialist Agent (Weight: 1.2) ⭐
- **Focus**: MCP protocol compliance, JSON schema correctness
- **Key Output**: Protocol-perfect tools with valid schemas
- **Confidence Range**: 0.6-0.95 (higher for well-documented APIs)
- **Note**: Highest weight because protocol compliance is non-negotiable

## Cost & Performance

### Per Generation
- **4 agents** × 500 tokens/prompt = 2,000 input tokens
- **4 agents** × 1,500 tokens/response = 6,000 output tokens
- **Total**: ~8,000 tokens (~$0.026 per generation)

### Latency
- **Parallel execution**: 3-5 seconds
- **Sequential execution**: 12-20 seconds (4x slower)
- **Recommendation**: Always use parallel execution

### Claude Haiku 3.5 Pricing
- **Input**: $0.80/million tokens
- **Output**: $4.00/million tokens
- **Cost per turn**: $0.001 (very cost-effective)

## Validation

Before deployment, verify:

- [ ] All agents return valid JSON (test with sample data)
- [ ] JSON schemas pass Draft 7 validator
- [ ] Tool names follow `lowercase_underscore` convention
- [ ] Confidence scores are diverse (not all 0.9)
- [ ] Each agent provides unique recommendations
- [ ] Concerns arrays identify real issues
- [ ] Output matches TypeScript interface
- [ ] Token count <500 per prompt

Run validation:
```bash
npm run test:ensemble-prompts
```

## Testing

### Unit Test Individual Agents
```typescript
import testData from './prompts/test-sample-data.json';

const response = await callAgent('architectAgent', testData.testData);
console.assert(response.agentName === 'architectAgent');
console.assert(response.recommendations.tools.length >= 5);
console.assert(response.confidence > 0.7);
```

### Integration Test Voting System
```typescript
const recommendations = await executeEnsembleVoting(testData.testData);
const topTools = weightedVote(recommendations);

console.assert(topTools.length === 10);
console.assert(topTools[0].sources.length >= 2); // Consensus
console.assert(topTools[0].votes > 2.0); // Weighted threshold
```

### Validate Sample Data Expectations
```typescript
const expectations = testData.expectedBehavior;

// Check architect recommendations
const architectTools = recommendations
  .find(r => r.agentName === 'architectAgent')
  .recommendations.tools.map(t => t.name);

for (const expected of expectations.architectAgent.shouldRecommend) {
  console.assert(architectTools.includes(expected));
}
```

## Integration Points

These prompts integrate with:

- **`ToolDiscoveryService`** - Executes ensemble voting in LangGraph
- **`planGeneration` node** - Consumes weighted tool recommendations
- **`McpGenerationService`** - Uses consensus schemas for code generation
- **`CodeValidationService`** - Validates MCP protocol compliance

## Metrics Dashboard

Track these metrics in production:

1. **JSON Parse Rate**: >95% (responses that parse successfully)
2. **Schema Validity**: >98% (tools with valid JSON Schema)
3. **Protocol Compliance**: >90% (tools passing MCP validator)
4. **Recommendation Diversity**: 60-80% (unique tools per agent)
5. **Confidence Calibration**: 0.7+ R² (confidence vs quality correlation)
6. **Voting Consensus**: 70-90% (top-10 tools from 2+ agents)
7. **Generation Success Rate**: >85% (tools that compile and work)

## Evolution Strategy

### Phase 1: Baseline (Current)
- Template-based prompts with examples
- Explicit JSON schema requirements
- Role-specific guidelines

### Phase 2: Few-Shot Learning (Q1 2025)
- Add 2-3 real examples per agent
- Include failure examples with explanations
- Fine-tune based on production data

### Phase 3: Self-Critique Loop (Q2 2025)
- Add validation step to prompts
- Implement iterative improvement
- Track and fix common error patterns

### Phase 4: Dynamic Prompts (Q3 2025)
- Adjust by repository type (API vs library vs CLI)
- Add domain-specific guidelines
- Personalize based on user feedback

## Debugging

### Issue: Invalid JSON Output
**Fix**: Add more examples, emphasize "Respond ONLY with valid JSON"

### Issue: Agents Return Identical Recommendations
**Fix**: Strengthen role-specific constraints, add exclusive criteria

### Issue: Missing Required Fields
**Fix**: Show complete JSON example, validate programmatically

### Issue: Low Confidence Across All Agents
**Fix**: Improve research data quality, refine confidence calibration

### Issue: Schema Conflicts Between Agents
**Fix**: Expected - MCP specialist has highest weight and wins conflicts

## References

- **MCP Protocol Spec**: https://modelcontextprotocol.io/docs
- **JSON Schema Draft 7**: https://json-schema.org/specification-links.html#draft-7
- **Claude Haiku Docs**: https://docs.anthropic.com/claude/docs/models-overview
- **LangGraph**: https://langchain-ai.github.io/langgraph/

## Contributing

When updating prompts:

1. Test with `test-sample-data.json`
2. Validate JSON parse rate >95%
3. Check schema validity >98%
4. Update `ENSEMBLE_AGENTS_GUIDE.md` with changes
5. Document new metrics or success criteria
6. Run full integration tests

## License

Part of MCP Everything - AI-native MCP server generation platform

---

**Next Steps**:
1. Integrate prompts into `ToolDiscoveryService`
2. Test with 5 diverse repositories
3. Measure and optimize based on success metrics
4. Implement Phase 2 few-shot learning
