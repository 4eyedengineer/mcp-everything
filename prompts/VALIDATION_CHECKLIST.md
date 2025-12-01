# Ensemble Agent Validation Checklist

This checklist ensures the ensemble agent prompts are working correctly before production deployment.

## Pre-Deployment Validation

### Phase 1: Structural Validation (10 minutes)

#### File Integrity
- [ ] All 7 files present in `/prompts/` directory
- [ ] `ensemble-agents.json` is valid JSON (parse test)
- [ ] `ensemble-agents.types.ts` compiles without errors
- [ ] `implementation-example.ts` compiles without errors
- [ ] `test-sample-data.json` is valid JSON

#### JSON Schema Validation
- [ ] All agent prompts in `ensemble-agents.json` have `systemPrompt` field
- [ ] All agent prompts have `weight` field (numbers only)
- [ ] Weights are correct: architect=1.0, security=0.8, perf=0.8, mcp=1.2
- [ ] System prompts are strings <2000 characters each
- [ ] No escaped quotes breaking JSON structure

#### Type Definitions
- [ ] All TypeScript interfaces compile
- [ ] No circular dependencies
- [ ] All exported types are used
- [ ] JSON Schema types match Draft 7 spec

```bash
# Run these commands
cd /home/garrett/dev/mcp-everything/prompts
node -e "JSON.parse(require('fs').readFileSync('ensemble-agents.json', 'utf8'))"
node -e "JSON.parse(require('fs').readFileSync('test-sample-data.json', 'utf8'))"
npx tsc --noEmit ensemble-agents.types.ts
npx tsc --noEmit implementation-example.ts
```

### Phase 2: Individual Agent Testing (30 minutes)

For each agent, test with sample data:

#### Architect Agent
- [ ] Returns valid JSON
- [ ] `agentName` field is "architectAgent"
- [ ] `recommendations.tools` is array with 5-10 items
- [ ] All tools have required fields: name, description, inputSchema, outputFormat, priority, estimatedComplexity
- [ ] Tool names use lowercase_underscore convention
- [ ] `confidence` is number between 0.0-1.0
- [ ] `reasoning` field is non-empty string
- [ ] `concerns` array has 2-5 items

**Expected Output**:
```json
{
  "agentName": "architectAgent",
  "recommendations": {
    "tools": [
      {
        "name": "get_repository",
        "description": "...",
        "inputSchema": { "type": "object", "properties": {...}, "required": [...] },
        "outputFormat": "JSON object with...",
        "priority": "high",
        "estimatedComplexity": "simple"
      }
    ],
    "reasoning": "These tools represent...",
    "concerns": ["Complex API patterns...", "Inconsistent naming..."]
  },
  "confidence": 0.85
}
```

#### Security Agent
- [ ] Returns valid JSON
- [ ] `agentName` field is "securityAgent"
- [ ] All tools have validation constraints (pattern, enum, min/max)
- [ ] At least 50% of string parameters have `pattern` or `enum`
- [ ] `concerns` array identifies specific security risks
- [ ] High-risk operations flagged with priority="high"
- [ ] Authentication requirements mentioned in reasoning

**Expected Security Enhancements**:
```json
{
  "inputSchema": {
    "properties": {
      "owner": {
        "type": "string",
        "pattern": "^[a-zA-Z0-9_-]+$",
        "maxLength": 100,
        "description": "Repository owner (alphanumeric, dash, underscore only)"
      }
    }
  }
}
```

#### Performance Agent
- [ ] Returns valid JSON
- [ ] `agentName` field is "performanceAgent"
- [ ] List operations have pagination parameters (limit, offset, page)
- [ ] Frequently-called operations have caching parameters
- [ ] Slow operations (>1s) marked with priority="low" or have caching
- [ ] `concerns` mention rate limits or performance bottlenecks
- [ ] `reasoning` explains performance trade-offs

**Expected Performance Parameters**:
```json
{
  "inputSchema": {
    "properties": {
      "limit": {
        "type": "integer",
        "default": 30,
        "minimum": 1,
        "maximum": 100,
        "description": "Number of results per page"
      },
      "useCache": {
        "type": "boolean",
        "default": true,
        "description": "Enable caching for faster responses"
      }
    }
  }
}
```

#### MCP Specialist Agent
- [ ] Returns valid JSON
- [ ] `agentName` field is "mcpSpecialistAgent"
- [ ] ALL tool names are lowercase_underscore (no exceptions)
- [ ] ALL JSON schemas are valid Draft 7
- [ ] ALL properties have descriptions
- [ ] Required fields are minimal (≤3 per tool)
- [ ] Output formats are specific (not "string" or "data")
- [ ] `concerns` flag any protocol violations
- [ ] `confidence` is high (0.8-0.95) for well-documented repos

**Expected Protocol Compliance**:
```json
{
  "name": "get_repository",
  "inputSchema": {
    "type": "object",
    "properties": {
      "owner": {
        "type": "string",
        "description": "Repository owner username or organization name"
      },
      "repo": {
        "type": "string",
        "description": "Repository name"
      }
    },
    "required": ["owner", "repo"]
  },
  "outputFormat": "JSON object with {id: number, name: string, description: string, stars: number, language: string}. On error: {error: string, code: string}"
}
```

### Phase 3: Ensemble Voting Testing (20 minutes)

#### Parallel Execution
- [ ] All 4 agents execute in parallel (not sequential)
- [ ] Total time is ~3-5 seconds (not 12-20 seconds)
- [ ] Quorum passes with 3/4 agents (test by mocking 1 failure)
- [ ] Quorum fails with <3/4 agents (test by mocking 2 failures)

#### Weighted Voting
- [ ] Tools are sorted by weighted votes (highest first)
- [ ] Vote calculation: `agent_weight × agent_confidence`
- [ ] Tools recommended by multiple agents rank higher
- [ ] MCP specialist recommendations have highest individual weight

**Test Case**: Tool recommended by all 4 agents with high confidence
```
Expected votes:
  Architect:      1.0 × 0.90 = 0.90
  Security:       0.8 × 0.85 = 0.68
  Performance:    0.8 × 0.88 = 0.70
  MCP Specialist: 1.2 × 0.92 = 1.10
  ───────────────────────────
  Total:                   3.38
```

#### Schema Conflict Resolution
- [ ] MCP specialist schema is used as base
- [ ] Security constraints are added (pattern, enum, min/max)
- [ ] Performance parameters are added (cache, ttl, pagination)
- [ ] Architect ensures naming consistency
- [ ] No required fields are lost in merging

#### Consensus Calculation
- [ ] `consensusLevel` = (tools with 2+ sources) / (total tools)
- [ ] High consensus: 70-100%
- [ ] Low consensus: <50% triggers warning
- [ ] `overallConfidence` is weighted average of agent confidences

### Phase 4: Integration Testing (30 minutes)

#### TypeScript Compilation
- [ ] `implementation-example.ts` compiles with no errors
- [ ] All imports resolve correctly
- [ ] Type definitions match usage
- [ ] No `any` types in production code

#### Service Integration
- [ ] `EnsembleAgentService` instantiates correctly
- [ ] `executeEnsembleVoting()` returns valid `EnsembleVotingResult`
- [ ] `ToolDiscoveryService` integrates with LangGraph
- [ ] Cost calculation is accurate

#### Error Handling
- [ ] Invalid JSON response caught and logged
- [ ] Missing required fields throw clear errors
- [ ] Agent timeout handled gracefully
- [ ] Quorum failure returns helpful error message
- [ ] Schema validation errors are specific

```typescript
// Test error handling
try {
  await service.executeEnsembleVoting(invalidData);
} catch (error) {
  expect(error.message).toMatch(/Insufficient agent responses/);
}
```

### Phase 5: Quality Metrics (20 minutes)

#### JSON Parse Rate
- [ ] Measure: % of agent responses that parse successfully
- [ ] Target: >95%
- [ ] Test: Run 20 generations, count parse failures
- [ ] If <95%: Review prompt instructions, add more examples

#### Schema Validity Rate
- [ ] Measure: % of tools with valid JSON Schema Draft 7
- [ ] Target: >98%
- [ ] Test: Validate all schemas with JSON Schema validator
- [ ] If <98%: Review MCP specialist prompt, add schema examples

#### Protocol Compliance Rate
- [ ] Measure: % of tools passing MCP protocol validation
- [ ] Target: >90%
- [ ] Test: Check naming, required fields, descriptions, output format
- [ ] If <90%: Review MCP specialist weight, increase if needed

#### Recommendation Diversity
- [ ] Measure: % unique tools per agent
- [ ] Target: 60-80%
- [ ] Test: Compare tool names across agents
- [ ] If <60%: Strengthen role-specific constraints
- [ ] If >80%: May indicate agents are too divergent, reduce specialization

#### Confidence Calibration
- [ ] Measure: Correlation between confidence and actual quality
- [ ] Target: 0.7+ R² correlation
- [ ] Test: Plot confidence vs success rate for 50 generations
- [ ] If <0.7: Review confidence scoring instructions

#### Voting Consensus
- [ ] Measure: % of top-10 tools recommended by 2+ agents
- [ ] Target: 70-90%
- [ ] Test: Count sources for top 10 tools
- [ ] If <70%: Agents may disagree too much, check research data quality
- [ ] If >90%: Agents may be too similar, strengthen specialization

#### Generation Success Rate
- [ ] Measure: % of recommended tools that compile and work
- [ ] Target: >85%
- [ ] Test: Generate 20 MCP servers, test all tools
- [ ] If <85%: Review schema quality, add validation tests

### Phase 6: Cost & Performance (10 minutes)

#### Token Usage
- [ ] Average input tokens: 2000 (500 per agent)
- [ ] Average output tokens: 6000 (1500 per agent)
- [ ] Total tokens per generation: ~8000
- [ ] If higher: Review prompt length, compress if possible

#### Cost Per Generation
- [ ] Calculate: (input × $0.80/1M) + (output × $4.00/1M)
- [ ] Expected: ~$0.026 per generation
- [ ] If higher: Check token counts, optimize prompts

#### Latency
- [ ] Parallel execution: 3-5 seconds (P95: 5-8 seconds)
- [ ] Sequential execution: 12-20 seconds (baseline)
- [ ] Speedup: 4x with parallel
- [ ] If slower: Check network latency, API rate limits

#### Throughput
- [ ] Concurrent generations: Up to 10 parallel (Anthropic rate limit)
- [ ] Daily capacity: ~50,000 generations (with rate limits)
- [ ] If lower: Check rate limit configuration

### Phase 7: Production Readiness (15 minutes)

#### Monitoring Setup
- [ ] JSON parse rate dashboard
- [ ] Schema validity rate dashboard
- [ ] Protocol compliance rate dashboard
- [ ] Cost per generation tracker
- [ ] Latency percentiles (P50, P95, P99)
- [ ] Error rate by agent
- [ ] Confidence score distribution

#### Alerting
- [ ] Alert if JSON parse rate <90%
- [ ] Alert if schema validity <95%
- [ ] Alert if protocol compliance <85%
- [ ] Alert if cost per generation >$0.05
- [ ] Alert if P95 latency >10s
- [ ] Alert if error rate >20%

#### Documentation
- [ ] All 7 files in `/prompts/` directory are complete
- [ ] README.md has quick start guide
- [ ] ENSEMBLE_AGENTS_GUIDE.md has full documentation
- [ ] implementation-example.ts has working code
- [ ] DELIVERY_SUMMARY.md has overview
- [ ] ARCHITECTURE_DIAGRAM.md has visual diagrams

#### Deployment Plan
- [ ] Deploy to staging environment first
- [ ] Run 100 test generations
- [ ] Validate all metrics meet targets
- [ ] A/B test with 10% traffic
- [ ] Monitor for 24 hours
- [ ] Roll out to 100% if successful

## Validation Results Template

Use this template to record validation results:

```markdown
# Ensemble Agent Validation Results

**Date**: 2025-01-XX
**Tester**: [Your Name]
**Environment**: Staging / Production

## Phase 1: Structural Validation
- File Integrity: ✅ / ❌
- JSON Schema Validation: ✅ / ❌
- Type Definitions: ✅ / ❌

## Phase 2: Individual Agent Testing
- Architect Agent: ✅ / ❌ (Notes: ...)
- Security Agent: ✅ / ❌ (Notes: ...)
- Performance Agent: ✅ / ❌ (Notes: ...)
- MCP Specialist Agent: ✅ / ❌ (Notes: ...)

## Phase 3: Ensemble Voting Testing
- Parallel Execution: ✅ / ❌ (Avg time: Xs)
- Weighted Voting: ✅ / ❌
- Schema Conflict Resolution: ✅ / ❌
- Consensus Calculation: ✅ / ❌

## Phase 4: Integration Testing
- TypeScript Compilation: ✅ / ❌
- Service Integration: ✅ / ❌
- Error Handling: ✅ / ❌

## Phase 5: Quality Metrics
- JSON Parse Rate: XX% (Target: >95%)
- Schema Validity Rate: XX% (Target: >98%)
- Protocol Compliance Rate: XX% (Target: >90%)
- Recommendation Diversity: XX% (Target: 60-80%)
- Confidence Calibration: X.XX R² (Target: 0.7+)
- Voting Consensus: XX% (Target: 70-90%)
- Generation Success Rate: XX% (Target: >85%)

## Phase 6: Cost & Performance
- Average Input Tokens: XXXX
- Average Output Tokens: XXXX
- Cost Per Generation: $X.XX
- Latency (P50): XXXms
- Latency (P95): XXXms

## Phase 7: Production Readiness
- Monitoring Setup: ✅ / ❌
- Alerting: ✅ / ❌
- Documentation: ✅ / ❌
- Deployment Plan: ✅ / ❌

## Overall Status
- [ ] READY FOR PRODUCTION
- [ ] NEEDS FIXES (List issues below)
- [ ] BLOCKED (List blockers below)

## Issues Found
1. ...
2. ...

## Next Steps
1. ...
2. ...
```

## Common Issues & Fixes

### Issue: Low JSON Parse Rate (<90%)

**Symptoms**:
- Agents return invalid JSON
- Parse errors in logs
- Missing closing braces/brackets

**Diagnosis**:
```bash
# Check for common JSON errors
grep -i "parse error" logs/*.log
```

**Fix**:
1. Add more JSON examples to prompts
2. Emphasize "Respond ONLY with valid JSON" instruction
3. Test with JSON linter before returning
4. Increase temperature to 0.1 (more deterministic)

### Issue: Schema Conflicts

**Symptoms**:
- Different agents recommend different schemas for same tool
- Required fields inconsistent
- Type mismatches (string vs number)

**Diagnosis**:
```typescript
// Compare schemas from different agents
const architectSchema = architectRec.tools.find(t => t.name === 'get_repository').inputSchema;
const mcpSchema = mcpRec.tools.find(t => t.name === 'get_repository').inputSchema;
console.log(JSON.stringify(architectSchema, null, 2));
console.log(JSON.stringify(mcpSchema, null, 2));
```

**Fix**:
1. Ensure MCP specialist weight is highest (1.2)
2. Review schema merging logic in `weightedVote()`
3. Add more JSON Schema examples to prompts
4. Validate merged schemas with JSON Schema validator

### Issue: Low Consensus (<50%)

**Symptoms**:
- Few tools recommended by multiple agents
- Top 10 tools mostly from single agent
- Low overlap between recommendations

**Diagnosis**:
```typescript
const multiSourceTools = topTools.filter(t => t.sources.length >= 2);
console.log(`Consensus: ${multiSourceTools.length}/${topTools.length} = ${consensusLevel}%`);
```

**Fix**:
1. Check research data quality (may be incomplete)
2. Review agent specialization (may be too divergent)
3. Add common tools to all agent prompts
4. Adjust weights to balance recommendations

### Issue: High Cost (>$0.05/generation)

**Symptoms**:
- Token counts higher than expected
- Prompts longer than 500 tokens
- Responses longer than 1500 tokens

**Diagnosis**:
```typescript
console.log(`Input tokens: ${response.usage.input_tokens}`);
console.log(`Output tokens: ${response.usage.output_tokens}`);
```

**Fix**:
1. Compress prompts (use abbreviations, bullet points)
2. Reduce context passed to agents
3. Lower max_tokens from 2000 to 1500
4. Use Haiku instead of Sonnet (5x cheaper)

### Issue: Slow Latency (>10s P95)

**Symptoms**:
- Generations take longer than expected
- Timeouts in logs
- Users complain about wait time

**Diagnosis**:
```bash
# Check latency distribution
grep -i "response time" logs/*.log | awk '{print $NF}' | sort -n
```

**Fix**:
1. Verify parallel execution (not sequential)
2. Check network latency to Anthropic API
3. Reduce max_tokens to lower processing time
4. Consider caching research data analysis

## Automated Test Script

Save as `prompts/validate.sh`:

```bash
#!/bin/bash
set -e

echo "=== Ensemble Agent Validation Script ==="
echo ""

# Phase 1: Structural Validation
echo "Phase 1: Structural Validation"
echo "  Checking file integrity..."
test -f ensemble-agents.json && echo "  ✓ ensemble-agents.json"
test -f ensemble-agents.types.ts && echo "  ✓ ensemble-agents.types.ts"
test -f implementation-example.ts && echo "  ✓ implementation-example.ts"
test -f test-sample-data.json && echo "  ✓ test-sample-data.json"

echo "  Validating JSON files..."
node -e "JSON.parse(require('fs').readFileSync('ensemble-agents.json', 'utf8'))" && echo "  ✓ ensemble-agents.json is valid JSON"
node -e "JSON.parse(require('fs').readFileSync('test-sample-data.json', 'utf8'))" && echo "  ✓ test-sample-data.json is valid JSON"

echo "  Compiling TypeScript files..."
npx tsc --noEmit ensemble-agents.types.ts && echo "  ✓ ensemble-agents.types.ts compiles"
npx tsc --noEmit implementation-example.ts && echo "  ✓ implementation-example.ts compiles"

echo ""
echo "Phase 1: ✅ PASSED"
echo ""

# Phase 2-7: Requires actual API calls and integration
echo "Note: Phases 2-7 require running implementation-example.ts with real API key"
echo "Run: ANTHROPIC_API_KEY=sk-... node implementation-example.ts"
```

Make executable:
```bash
chmod +x /home/garrett/dev/mcp-everything/prompts/validate.sh
```

## Success Criteria Summary

All checks must pass before production deployment:

| Phase | Criteria | Target | Status |
|-------|----------|--------|--------|
| 1 | File Integrity | All 7 files | ☐ |
| 1 | JSON Validity | 100% valid | ☐ |
| 1 | Type Compilation | No errors | ☐ |
| 2 | Architect Agent | Valid JSON, 5-10 tools | ☐ |
| 2 | Security Agent | Validation constraints | ☐ |
| 2 | Performance Agent | Caching + pagination | ☐ |
| 2 | MCP Specialist | Protocol compliance | ☐ |
| 3 | Parallel Execution | 3-5s latency | ☐ |
| 3 | Weighted Voting | Correct calculation | ☐ |
| 3 | Schema Merging | MCP specialist wins | ☐ |
| 4 | TypeScript | Compiles, no errors | ☐ |
| 4 | Integration | Works with LangGraph | ☐ |
| 5 | JSON Parse Rate | >95% | ☐ |
| 5 | Schema Validity | >98% | ☐ |
| 5 | Protocol Compliance | >90% | ☐ |
| 5 | Diversity | 60-80% | ☐ |
| 5 | Consensus | 70-90% | ☐ |
| 5 | Success Rate | >85% | ☐ |
| 6 | Cost | ~$0.026/gen | ☐ |
| 6 | Latency | 3-5s (P95: <8s) | ☐ |
| 7 | Monitoring | Dashboards ready | ☐ |
| 7 | Alerting | Thresholds set | ☐ |
| 7 | Documentation | Complete | ☐ |

**Sign-off**: Once all checks pass, the system is ready for production deployment.

---

**Last Updated**: 2025-12-01
**Version**: 1.0.0
**Status**: Initial Release
