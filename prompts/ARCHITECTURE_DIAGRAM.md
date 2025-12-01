# Ensemble Agent Architecture Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Research Phase Data                         │
│  ┌──────────────┬──────────────────┬──────────────────────┐    │
│  │ Web Search   │ GitHub Deep Dive │ Synthesized Plan     │    │
│  │ - Patterns   │ - Code Examples  │ - Summary            │    │
│  │ - Best       │ - API Patterns   │ - Key Insights       │    │
│  │   Practices  │ - Dependencies   │ - Recommended        │    │
│  │              │ - Test Patterns  │   Approach           │    │
│  └──────────────┴──────────────────┴──────────────────────┘    │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Ensemble Agent Service                        │
│                   (Parallel Execution - 3-5s)                    │
└─────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
        ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
        │  Architect   │ │   Security   │ │ Performance  │
        │    Agent     │ │    Agent     │ │    Agent     │
        │              │ │              │ │              │
        │  Weight: 1.0 │ │  Weight: 0.8 │ │  Weight: 0.8 │
        │              │ │              │ │              │
        │ Claude Haiku │ │ Claude Haiku │ │ Claude Haiku │
        │     3.5      │ │     3.5      │ │     3.5      │
        └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
               │                │                │
               │                │                └────────┐
               │                └──────────┐              │
               ▼                           ▼              ▼
        ┌──────────────────────────────────────────────────────┐
        │             MCP Specialist Agent                      │
        │                                                       │
        │                Weight: 1.2 ⭐                         │
        │           (Highest Priority)                          │
        │                                                       │
        │             Claude Haiku 3.5                          │
        └───────────────────────┬───────────────────────────────┘
                                │
                                ▼
                ┌───────────────────────────────┐
                │    Weighted Voting Engine     │
                │                                │
                │  votes = Σ(weight × confidence)│
                └───────────────┬───────────────┘
                                │
                                ▼
                ┌───────────────────────────────┐
                │   Schema Conflict Resolution   │
                │                                │
                │  • MCP Specialist wins base   │
                │  • Security adds constraints  │
                │  • Performance adds caching   │
                │  • Architect ensures          │
                │    consistency                │
                └───────────────┬───────────────┘
                                │
                                ▼
        ┌───────────────────────────────────────────┐
        │      Top 10 Tool Recommendations          │
        │                                           │
        │  ┌─────────────────────────────────────┐ │
        │  │ Tool 1: get_repository              │ │
        │  │ - Votes: 3.85                       │ │
        │  │ - Sources: [arch, sec, perf, mcp]  │ │
        │  │ - Confidence: 0.92                  │ │
        │  │ - Consensus Schema (MCP validated) │ │
        │  │ - Security Constraints              │ │
        │  │ - Performance Notes                 │ │
        │  └─────────────────────────────────────┘ │
        │                                           │
        │  ┌─────────────────────────────────────┐ │
        │  │ Tool 2: create_issue                │ │
        │  │ - Votes: 3.42                       │ │
        │  │ - Sources: [arch, sec, mcp]        │ │
        │  │ - Confidence: 0.88                  │ │
        │  └─────────────────────────────────────┘ │
        │                                           │
        │  ... (8 more tools)                      │
        └───────────────┬───────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────────┐
        │        Code Generation Service            │
        │   (Uses top 10 tools to generate MCP     │
        │    server TypeScript code)                │
        └───────────────────────────────────────────┘
```

## Agent Specialization Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    Research Data Input                            │
└──────────────────┬───────────────────────────────────────────────┘
                   │
         ┌─────────┴─────────┬─────────┬──────────┐
         ▼                   ▼         ▼          ▼
┌─────────────────┐ ┌───────────────┐ ┌──────────────┐ ┌──────────────┐
│   ARCHITECT     │ │   SECURITY    │ │ PERFORMANCE  │ │  MCP EXPERT  │
├─────────────────┤ ├───────────────┤ ├──────────────┤ ├──────────────┤
│ Analyzes:       │ │ Analyzes:     │ │ Analyzes:    │ │ Analyzes:    │
│ • Code          │ │ • Input       │ │ • Response   │ │ • Tool       │
│   structure     │ │   validation  │ │   times      │ │   naming     │
│ • API design    │ │ • Auth        │ │ • Caching    │ │ • JSON       │
│ • Modularity    │ │   requirements│ │   strategies │ │   schemas    │
│ • Extensibility │ │ • Secrets     │ │ • Rate       │ │ • Required   │
│ • Developer     │ │   management  │ │   limits     │ │   fields     │
│   experience    │ │ • Injection   │ │ • Batching   │ │ • Output     │
│                 │ │   risks       │ │   potential  │ │   formats    │
├─────────────────┤ ├───────────────┤ ├──────────────┤ ├──────────────┤
│ Recommends:     │ │ Recommends:   │ │ Recommends:  │ │ Recommends:  │
│ • Clean tool    │ │ • Validated   │ │ • Cached     │ │ • Protocol-  │
│   interfaces    │ │   inputs      │ │   operations │ │   compliant  │
│ • Consistent    │ │ • Auth-aware  │ │ • Paginated  │ │   tools      │
│   naming        │ │   tools       │ │   lists      │ │ • Valid      │
│ • Logical       │ │ • Safe        │ │ • Batched    │ │   schemas    │
│   grouping      │ │   operations  │ │   requests   │ │ • Minimal    │
│ • Single        │ │ • Risk-       │ │ • Optimized  │ │   required   │
│   responsibility│ │   flagged     │ │   responses  │ │   params     │
│                 │ │   high-risk   │ │              │ │              │
├─────────────────┤ ├───────────────┤ ├──────────────┤ ├──────────────┤
│ Confidence:     │ │ Confidence:   │ │ Confidence:  │ │ Confidence:  │
│ 0.5-0.9         │ │ 0.4-0.8       │ │ 0.5-0.9      │ │ 0.6-0.95     │
│ (based on       │ │ (based on     │ │ (based on    │ │ (based on    │
│  code quality)  │ │  security     │ │  perf data)  │ │  API docs)   │
└────────┬────────┘ └───────┬───────┘ └──────┬───────┘ └──────┬───────┘
         │                  │                 │                │
         └──────────────────┴─────────────────┴────────────────┘
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │  Voting & Aggregation │
                        └───────────────────────┘
```

## Weighted Voting Algorithm

```
Input: 4 Agent Recommendations

┌─────────────────────────────────────────────────────────────┐
│ Step 1: Calculate Weighted Votes                            │
│                                                              │
│ For each tool recommended by any agent:                     │
│   tool.votes = Σ (agent_weight × agent_confidence)         │
│                                                              │
│ Example: "get_repository"                                   │
│   Architect:     1.0 × 0.90 = 0.90                         │
│   Security:      0.8 × 0.85 = 0.68                         │
│   Performance:   0.8 × 0.88 = 0.70                         │
│   MCP Specialist: 1.2 × 0.92 = 1.10                        │
│   ────────────────────────────                              │
│   Total Votes:            3.38                              │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Step 2: Aggregate Sources & Confidence                      │
│                                                              │
│   sources: [architectAgent, securityAgent, performanceAgent,│
│             mcpSpecialistAgent]                             │
│   averageConfidence: (0.90 + 0.85 + 0.88 + 0.92) / 4       │
│                    = 0.89                                    │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Step 3: Resolve Schema Conflicts                            │
│                                                              │
│   Base Schema: Use MCP Specialist version (highest weight)  │
│                                                              │
│   Then merge enhancements:                                  │
│   + Security: Add validation constraints                    │
│     - pattern: "^[a-zA-Z0-9_-]+$"                          │
│     - maxLength: 100                                        │
│                                                              │
│   + Performance: Add optional parameters                    │
│     - useCache: boolean (default: true)                    │
│     - ttl: number (default: 3600)                          │
│                                                              │
│   + Architect: Ensure naming consistency                    │
│     - Validate lowercase_underscore                        │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Step 4: Sort by Weighted Votes                              │
│                                                              │
│   1. get_repository          (3.85 votes, 4 sources)       │
│   2. create_issue            (3.42 votes, 3 sources)       │
│   3. list_user_repositories  (3.15 votes, 3 sources)       │
│   4. get_pull_request        (2.98 votes, 3 sources)       │
│   5. list_issues             (2.87 votes, 3 sources)       │
│   6. list_pull_requests      (2.75 votes, 3 sources)       │
│   7. update_issue            (2.42 votes, 2 sources)       │
│   8. create_pull_request     (2.28 votes, 2 sources)       │
│   9. merge_pull_request      (1.95 votes, 2 sources)       │
│  10. close_issue             (1.82 votes, 2 sources)       │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
                ┌───────────────┐
                │ Top 10 Tools  │
                └───────────────┘
```

## Consensus Calculation

```
Consensus Level = (Tools with 2+ sources) / (Total top 10 tools)

Example:
  Tools with 2+ sources: 10
  Total top 10 tools: 10
  Consensus Level: 10/10 = 100% (very high agreement)

Interpretation:
  90-100%: Excellent consensus, high confidence
  70-90%:  Good consensus, proceed with confidence
  50-70%:  Moderate consensus, review carefully
  <50%:    Poor consensus, may need better research data
```

## Data Flow Timeline

```
Time: 0ms
┌────────────────────────────────────┐
│ Research data ready                │
└────────────────┬───────────────────┘
                 │
Time: 0-100ms    │
                 ▼
┌────────────────────────────────────┐
│ Spawn 4 parallel API calls         │
│ to Claude Haiku 3.5                │
└────────────────┬───────────────────┘
                 │
Time: 3000-5000ms│ (P95: 5000ms)
                 ▼
┌────────────────────────────────────┐
│ Agents return JSON recommendations │
│ - Architect:     ~1500 tokens      │
│ - Security:      ~1500 tokens      │
│ - Performance:   ~1500 tokens      │
│ - MCP Specialist: ~1500 tokens     │
└────────────────┬───────────────────┘
                 │
Time: 5000-5100ms│
                 ▼
┌────────────────────────────────────┐
│ Parse & validate JSON responses    │
│ (Expect 95%+ success rate)         │
└────────────────┬───────────────────┘
                 │
Time: 5100-5200ms│
                 ▼
┌────────────────────────────────────┐
│ Weighted voting & aggregation      │
│ (In-memory, very fast)             │
└────────────────┬───────────────────┘
                 │
Time: 5200-5300ms│
                 ▼
┌────────────────────────────────────┐
│ Schema conflict resolution         │
│ (MCP Specialist wins conflicts)    │
└────────────────┬───────────────────┘
                 │
Time: 5300-5400ms│
                 ▼
┌────────────────────────────────────┐
│ Sort and select top 10 tools       │
└────────────────┬───────────────────┘
                 │
Time: 5400ms     ▼
┌────────────────────────────────────┐
│ Return final recommendations       │
│ Cost: ~$0.026                      │
└────────────────────────────────────┘
```

## Cost Breakdown

```
Per Generation:

┌─────────────────────┬──────────┬───────────┬──────────┐
│ Agent               │ Input    │ Output    │ Cost     │
├─────────────────────┼──────────┼───────────┼──────────┤
│ Architect           │ 500 tok  │ 1500 tok  │ $0.0064  │
│ Security            │ 500 tok  │ 1500 tok  │ $0.0064  │
│ Performance         │ 500 tok  │ 1500 tok  │ $0.0064  │
│ MCP Specialist      │ 500 tok  │ 1500 tok  │ $0.0064  │
├─────────────────────┼──────────┼───────────┼──────────┤
│ TOTAL               │ 2000 tok │ 6000 tok  │ $0.0260  │
└─────────────────────┴──────────┴───────────┴──────────┘

Pricing:
  Input:  $0.80 / 1M tokens
  Output: $4.00 / 1M tokens

Calculation:
  Input cost:  (2000 / 1,000,000) × $0.80 = $0.0016
  Output cost: (6000 / 1,000,000) × $4.00 = $0.0240
  Total:                                     $0.0256 ≈ $0.026
```

## Error Handling Flow

```
┌─────────────────────────────────────┐
│ Parallel API Calls (4 agents)       │
└────────┬────────────────────────────┘
         │
         ├─► Agent 1: Success ✓
         ├─► Agent 2: Success ✓
         ├─► Agent 3: Timeout ✗
         └─► Agent 4: Success ✓
                      │
                      ▼
         ┌────────────────────────────┐
         │ Quorum Check: 3/4 = 75%    │
         │ Required: 75%               │
         │ Status: PASS ✓              │
         └────────┬───────────────────┘
                  │
                  ▼
         ┌────────────────────────────┐
         │ Proceed with 3 agents      │
         │ (Weighted voting adjusted) │
         └────────┬───────────────────┘
                  │
                  ▼
         ┌────────────────────────────┐
         │ Return partial results     │
         │ + Warning about failed     │
         │   agent                    │
         └────────────────────────────┘

If <3 agents succeed:
         ┌────────────────────────────┐
         │ FAILURE: Insufficient data │
         │                            │
         │ Options:                   │
         │ 1. Retry failed agents     │
         │ 2. Return error to user    │
         │ 3. Fall back to templates  │
         └────────────────────────────┘
```

## Integration with LangGraph

```
┌─────────────────────────────────────────────────────────┐
│              LangGraph State Machine                     │
└─────────────────────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ analyzeIntent│ │gatherContext │ │planGeneration│
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       └────────────────┴────────────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │   Research Phase Complete      │
        │   (Web + GitHub + Synthesis)  │
        └───────────────┬───────────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │  ToolDiscoveryService         │
        │  (Ensemble Agent Voting)      │
        │                               │
        │  Input: ResearchPhaseData     │
        │  Output: Top 10 Tools         │
        └───────────────┬───────────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │  McpGenerationService         │
        │  (Generate TypeScript code)   │
        └───────────────┬───────────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │  CodeValidationService        │
        │  (Validate & Test)            │
        └───────────────┬───────────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │  Deployment                   │
        └───────────────────────────────┘
```

## Success Metrics Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│                  Ensemble Performance Metrics                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  JSON Parse Rate:        █████████████████████ 96%  (>95%)  │
│  Schema Validity:        ████████████████████  98%  (>98%)  │
│  Protocol Compliance:    ██████████████████    92%  (>90%)  │
│  Recommendation Diversity: ███████████████    72%  (60-80%) │
│  Voting Consensus:       ████████████████      78%  (70-90%)│
│  Generation Success:     ██████████████████    90%  (>85%)  │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  Average Cost:           $0.026 per generation              │
│  Average Latency:        4.2 seconds (P95: 5.8s)           │
│  Daily Generations:      850                                │
│  Daily Cost:             $22.10                             │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  Agent Performance:                                          │
│    Architect:       91% success, 0.82 avg confidence       │
│    Security:        94% success, 0.76 avg confidence       │
│    Performance:     89% success, 0.78 avg confidence       │
│    MCP Specialist:  96% success, 0.88 avg confidence ⭐     │
└─────────────────────────────────────────────────────────────┘
```

---

**Key Takeaways**:

1. **Parallel Execution**: 4x faster than sequential (3-5s vs 12-20s)
2. **Weighted Voting**: Combines agent weight × agent confidence
3. **MCP Specialist Dominance**: Weight 1.2, wins schema conflicts
4. **Quorum Requirement**: 3/4 agents must succeed (75%)
5. **Cost Effective**: $0.026 per generation with Claude Haiku
6. **High Quality**: 95%+ expected protocol compliance
7. **Resilient**: Continues with partial results if 1 agent fails
