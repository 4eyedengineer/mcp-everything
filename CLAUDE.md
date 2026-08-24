# Claude Code Assistant Instructions

## Project Context

This is **MCP Everything** - an AI-native platform for automatically generating and hosting Model Context Protocol (MCP) servers from any input (GitHub repositories, API specifications, natural language descriptions). The core innovation is `GenerationPipeline`, an explicit orchestration service that runs analyzeIntent → research → planTools → clarify → refine → persist to produce high-quality MCP servers with minimal human intervention. The business goal is to create a marketplace of AI-generated MCP servers that users can easily discover, subscribe to, and deploy. The money-making potential lies in subscriptions, usage-based billing, and premium features for MCP Everything hosted MCP servers.

## Key Reference Files

- **`README.md`**: Project overview and current status
- **`ROADMAP.md`**: Vision alignment analysis and implementation roadmap
- **`ARCHITECTURE.md`**: Complete technical architecture documentation
- **`DEVELOPMENT.md`**: Development setup and contributing guide
- **`DEPLOYMENT.md`**: Production deployment instructions

## Current Status

- **Repository**: https://github.com/4eyedengineer/mcp-everything
- **Implementation**: GenerationPipeline (analyzeIntent → research → planTools → clarify → refine → persist) fully coded and validated ✅
- **Frontend**: Fully standalone Angular 20 (no NgModules), LibreChat-inspired design ✅
- **Architecture**: AI-first conversational interface with an explicit, single-file pipeline (no LangGraph)
- **Backend**: All core services implemented (research, planning, refinement, Docker-sandboxed validation) ✅
- **Database**: PostgreSQL schema defined, including `pipeline_runs` for per-step observability ✅
- **Reality Check**: E2E-validated on 2026-07-29 — the pipeline generated two working MCP servers (JSONPlaceholder: 7/7 and 10/10 tools passing), independently verified via stdio JSON-RPC. "Never run end-to-end" is no longer accurate. Cloud hosting deploy path and the Kubernetes manifests remain unexercised end-to-end.
- **Transport**: Generated servers are dual-transport via `MCP_TRANSPORT` (`stdio` default — unchanged for Claude Desktop/GitHub/Gist; `http` — real MCP Streamable HTTP on `POST /mcp` + `GET /health`, high-level `McpServer`/`registerTool` API, SDK pinned `1.30.0`, protocol `2025-11-25`). K8s manifests set `MCP_TRANSPORT=http` so probes target a real listener — this closes the transport mismatch that previously guaranteed K8s deploys would fail probes, but the cluster path itself is still unexercised end-to-end (no Docker daemon on the dev machine either, so the container path is unverified too)
- **Security**: Global JWT guard + ownership checks on all conversations/deployments; single-use SSE stream tickets; Docker-sandboxed code execution; the 5 unauthenticated debug endpoints have been deleted
- **Marketplace**: Real backend, seeded with 6 servers, frontend Explore uses the real API (not placeholder data)
- **Platform MCP Server**: `POST /mcp` exposes the platform to agents; tools are registered in `packages/backend/src/mcp-server/mcp-tools.service.ts` and now include the aggregator pair `search_tools` / `call_tool`, which let one connection discover and invoke the tools of the caller's own hosted servers via `HostedMcpClientService` (`packages/backend/src/hosting/services/hosted-mcp-client.service.ts`) ✅
- **Vision Alignment**: Business infrastructure (auth, hosting, marketplace) now largely in place; quota/usage-limit enforcement is in progress
- **Next Milestone**: Finish quota enforcement, exercise the cloud hosting/k8s deploy path end-to-end

## Architecture Decisions Made

### Build Strategy: Local-First, Cloud-Optional

- **KEEP IT SIMPLE** so we build and compile successfully with each change
- **Local Docker builds** for fast iteration and debugging
- **Centralized build system** instead of per-repo GitHub Actions

### Technology Stack

- **Backend**: NestJS + TypeScript + PostgreSQL (no LangGraph — `@langchain/*` was fully removed)
- **Frontend**: Angular 20 with LibreChat-inspired design
- **AI**: Single `AnthropicService` — claude-sonnet-5 (default: reasoning/synthesis/codegen), claude-haiku-4.5 (small tier: cheap classification/extraction)
- **State Management**: PostgreSQL, with pipeline state persisted on the conversation row for pause/resume across clarification turns
- **Streaming**: Server-Sent Events (SSE) for real-time updates, gated by single-use 60s stream tickets
- **Build**: Local Docker with hybrid cloud deployment

## Service Dependencies & API Keys

### Currently Available ✅

- **GitHub**: PAT working, MCP tools available, repository created
- **Anthropic API**: claude-sonnet-5 / claude-haiku-4-5 integrated and operational, with token/cost telemetry (Prometheus: `ai_calls_total`, `ai_tokens_total`, `ai_cost_usd_total`; ~$0.22 tracked cost per generation observed)
- **PostgreSQL**: Database running with conversations, deployments, and `pipeline_runs`

### Optional Services 🔲

- **Docker Hub**: Container registry (for deployment)

## Development Workflow

### Project Structure

```
mcp-everything/
├── packages/
│   ├── backend/           # NestJS backend
│   ├── frontend/          # Angular frontend
│   └── shared/            # Shared types
├── generated-servers/     # Local MCP server builds
├── docker/               # Docker configurations
├── scripts/              # Build and deployment scripts
└── working-knowledge.md  # This file - always reference!
```

### Local Development Cycle

```bash
# Terminal 1: Backend
npm run dev:backend

# Terminal 2: Frontend
npm run dev:frontend

# Open browser to http://localhost:4200/chat
# Chat naturally with AI to generate MCP servers
```

## Core Implementation Services

### GenerationPipeline (`packages/backend/src/orchestration/pipeline.service.ts`)

The 8-node LangGraph state machine and the 4-agent ensemble it used to route through were deleted. They're replaced by a single explicit pipeline:

```typescript
@Module({
  providers: [
    GenerationPipeline,     // Orchestrates the full pipeline below
    ResearchService,        // Input-agnostic research (GitHub/web/APIs/docs)
    RefinementService,      // Generate-Test-Refine loop (max 5 iterations)
    McpTestingService,      // Docker-sandboxed MCP server validation
    GitHubAnalysisService,  // Repository analysis with Octokit
    AnthropicService,       // Single seam to Claude (structured outputs, retries, cost telemetry)
  ],
})
export class ChatModule {}
```

### Pipeline Steps

1. **analyzeIntent**: AI-powered intent detection
2. **research**: Multi-source research (GitHub, web, APIs, docs)
3. **planTools**: One structured Claude call that turns research findings into the concrete tool set — replaces the deleted 4-agent ensemble
4. **clarify**: Gap detection; pauses and persists state on the conversation row, resumes without re-running research when the user replies
5. **refine**: Generate-Test-Refine loop, max 5 iterations, Docker-sandboxed validation
6. **persist**: Save final generated server + `pipeline_runs` record
7. **provideHelp** / **handleError**: Side paths for help requests and failures

Every step writes a `pipeline_runs` row (status, timings, tokens) for observability.

## Development Philosophy

- **Working code > Perfect code**: Ship MVP
- **Real integration > Mocking**: Use actual APIs from day 1
- **Semantic understanding > Pattern matching**: Core AI differentiator
- **Local-first development**: Fast iteration cycles crucial

## Quality Standards

- Generated MCP servers **must compile** without errors
- Basic MCP operations **must work** (tools/resources)
- Generation time **< 2 minutes**
- **Include documentation** and basic tests

## Current Priorities

### Phase 1: Validate Core ✅ DONE (2026-07-29)

The pipeline generated working MCP servers twice (JSONPlaceholder, 7/7 and 10/10 tools passing), independently verified via stdio JSON-RPC. The 8-node LangGraph state machine, EnsembleService, McpGenerationService, ToolDiscoveryService, and the old in-memory conversation engine have been deleted and replaced by `GenerationPipeline`.

### Phase 2: Business Foundation — Largely Done ✅

- **User Authentication**: Global JWT guard, ownership checks on conversations/deployments/hosting, password reset flow ✅
- **Marketplace**: Real backend, seeded with 6 servers, interim `AdminGuard` via `ADMIN_USER_EMAILS` ✅
- **Hosting Infrastructure**: Generated servers emit Dockerfile/.dockerignore, deployments persist `serverName`/`localPath`, `GENERATED_SERVERS_DIR` config, `deploy.yml` builds `:latest` on main ✅ — the cloud/k8s deploy path itself has not been exercised end-to-end
- **Quota/Billing**: Tier-based monthly generation limits enforced in the pipeline (writing `UsageRecord`) ✅
- **Stripe**: Checkout/portal/webhooks implemented; now connected to limits via quota enforcement — end-to-end billing flow still unexercised with real payments

### Phase 3: Marketplace Frontend — Done ✅

Explore page connects to the real marketplace API (previously placeholder data).

### Remaining Work

1. Finish quota enforcement
2. Add Stripe/payment integration
3. Exercise the cloud hosting and Kubernetes deploy path end-to-end (manifests exist under `k8s/` but are untested)

**See [ROADMAP.md](ROADMAP.md) for the fuller status breakdown.**

## Working Instructions for Claude

### Always Reference

- Check `README.md` for project overview and current status
- Review `ARCHITECTURE.md` for technical implementation details
- Follow `DEVELOPMENT.md` for setup and development workflow
- Consult `DEPLOYMENT.md` for production deployment
- Update documentation when making significant changes

### Sub-Agent Usage

**Use specialized sub-agents proactively** for complex tasks:

**Core Development**:

- **nestjs-backend-architect**: NestJS services, modules, API design
- **angular-architect**: Angular components, architecture, best practices
- **postgres-architect**: Database schema, migrations, optimization
- **docker-expert**: Dockerfiles, CI/CD, container builds

**MCP-Specific**:

- **mcp-protocol-validator**: MCP server validation, protocol compliance
- **mcp-test-generator**: Test suites for generated MCP servers
- **codebase-analyzer**: Deep repository analysis, API patterns

**Infrastructure & Quality**:

- **github-integration-expert**: GitHub Apps, webhooks, automation
- **security-auditor**: Security reviews, secret management
- **observability-expert**: Monitoring, logging, analytics
- **prompt-engineering-optimizer**: LLM prompt optimization
- **docs-maintainer**: Update docs after code changes
- **karen**: Validate actual completion vs claimed progress

**Delegation Tips**:

- Invoke early to preserve main context
- Use for deep dives (searches, architecture)
- Run parallel agents for independent tasks

### Development Approach

- Start with simple template-based generation, add AI intelligence incrementally
- Build locally first, add cloud deployment later
- Focus on the critical path: input → analysis → generation → validation → deployment

### Code Standards

- TypeScript with strict mode
- NestJS patterns (dependency injection, modules, services)
- Docker-first architecture
- Clear separation between generation logic and deployment logic

### When Stuck

1. Simplify the problem
2. Use templates temporarily if AI generation is complex
3. Focus on the critical path to MVP
4. Ask: "What would make a user happy today?"

---

**Remember**: This is an AI-native platform where semantic understanding is the core differentiator. Every decision should be made through AI reasoning about intent, not pattern matching.

_Update this file when major decisions or status changes occur_
