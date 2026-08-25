# MCP Everything

AI-native conversational platform for automatically generating and hosting Model Context Protocol (MCP) servers through natural language chat.

## Status (August 2026)

**E2E-Validated in Production: Generator, Sandboxed Validation, Hosting, and Aggregator All Proven on the Cluster**

### ✅ What's Built and Validated
- `GenerationPipeline`: an explicit orchestration service (analyzeIntent → research → planTools → clarify → refine → persist) that replaced the old 8-node LangGraph state machine and 4-agent ensemble; `@langchain/*` dependencies fully removed
- Fully standalone Angular 20 frontend (no NgModules), functional interceptors/guards, signals-based chat state, SSE streaming
- Single `AnthropicService` AI layer: claude-sonnet-5 (default) / claude-haiku-4-5 (small tier), structured outputs, retries, token/cost telemetry in Prometheus
- PostgreSQL schema for conversations, deployments, and per-step `pipeline_runs` observability
- Global JWT guard with ownership checks on conversations/deployments/hosting; single-use 60s SSE stream tickets; untrusted, LLM-generated code validated in a throwaway, hardened Kubernetes pod in production (`K8sTestSandboxService`: no service account token, non-root, read-only rootfs, all capabilities dropped, seccomp, resource limits) with a Docker-sandboxed path for local dev; the backend fails closed with no sandbox available; the 5 unauthenticated debug endpoints have been deleted
- Tier-based monthly generation quota enforced in the pipeline (writing `UsageRecord`)
- Real marketplace backend, seeded with 6 servers; Explore page connects to the real API
- **Validated on 2026-07-29 in local dev**: the pipeline generated two working MCP servers (JSONPlaceholder, 7/7 and 10/10 tools passing), independently verified via stdio JSON-RPC
- **Dual-transport generated servers**: `MCP_TRANSPORT` env var selects `stdio` (default - Claude Desktop, GitHub/Gist downloads) or `http` (real MCP Streamable HTTP on `POST /mcp` + `GET /health`, protocol `2025-11-25`, high-level `McpServer`/`registerTool` API, `@modelcontextprotocol/sdk` pinned to `1.30.0`); K8s manifests set `MCP_TRANSPORT=http` so liveness/readiness probes target a real listener
- **Verified 2026-08-25, live in production on the self-hosted homelab k3s cluster**: a chat request for a JSONPlaceholder MCP server ran the full pipeline including validation inside an isolated Kubernetes test pod (all tools passing on iteration 1); the generated server was then deployed via "Host on Cloud" and came up serving MCP over HTTP through the gateway; the platform's own aggregator MCP server (`search_tools` / `call_tool` on `POST /mcp`) discovered and invoked that hosted server's tools through a single API-key connection

### ⚠️ What Still Needs Validation
- **Payments** - Stripe checkout/portal/webhooks are implemented and correctness-fixed, but no products/prices are configured, so nothing is purchasable yet; the end-to-end billing flow is unexercised with real payments
- **Homelab, not commercial cloud** - the verified deploy above runs on a self-hosted k3s cluster; no database backups are configured in this repo (any volume snapshots live in separate homelab infra); the deploy workflow that tracks this branch runs without the CI lint/typecheck/test gate that `main` has
- **Credential/ops gaps** - the server-wide `GITHUB_TOKEN` is unset/expired (GitHub research runs unauthenticated and rate-limited until refreshed); no email provider is configured for password reset
- **Auto-scaling under load** - HPA manifests exist but scaling behavior under real traffic is unverified
- **Cold start** - each hosted or test-sandbox pod pays a from-scratch `npm install` + `tsc` cold start (~50-60s observed for the test sandbox); there is no pre-warming or dependency caching for that path

### 🎯 Next Steps
1. Configure Stripe products/prices and exercise billing with real payments
2. Provide a fresh `GITHUB_TOKEN` and an email provider
3. Marketplace polish and advanced features (semantic search, auth passthrough) - largely unstarted

See [ROADMAP.md](ROADMAP.md) for the fuller status breakdown.

## Quick Start

### Prerequisites
- Node.js 20.19+
- PostgreSQL 13+
- Docker (for building MCP servers)

### Installation

```bash
# Clone repository
git clone https://github.com/4eyedengineer/mcp-everything.git
cd mcp-everything

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys:
# - ANTHROPIC_API_KEY (from console.anthropic.com)
# - GITHUB_TOKEN (Personal Access Token with gist permissions)
```

### Running Locally

```bash
# Terminal 1: Backend
npm run dev:backend

# Terminal 2: Frontend
npm run dev:frontend

# Open browser to http://localhost:4200
```

### Using the Platform

Simply chat naturally to generate MCP servers from any source:

```
You: "Generate an MCP server for https://github.com/expressjs/express"
AI:  [Analyzes GitHub repository, creates MCP server]

You: "Create tools for the Stripe API"
AI:  [Searches for Stripe documentation, creates MCP server]

You: "I need to process payments in my app"
AI:  [Identifies payment services, researches APIs, creates MCP server]

You: "Build tools from https://docs.stripe.com/api"
AI:  [Analyzes API documentation, creates MCP server]
```

The AI automatically:
- Detects your intent from natural language
- Supports multiple input types: GitHub URLs, websites, API docs, service names, natural language
- Researches and synthesizes information from multiple sources
- Asks clarifying questions when needed
- Generates complete, working MCP servers

## Project Structure

```
mcp-everything/
├── packages/
│   ├── backend/          # NestJS API server with GenerationPipeline orchestration
│   ├── frontend/         # Angular web interface (LibreChat-inspired)
│   └── shared/           # Shared TypeScript types
├── generated-servers/    # Output directory for generated MCP servers
├── docker/              # Docker configurations and base images
└── scripts/             # Build and deployment automation
```

## Core Features

### AI-First Conversational Interface
- Natural language MCP server generation
- Multi-turn conversations with context preservation
- Intent detection with confidence scoring
- Intelligent clarification when needed

### GenerationPipeline
An explicit orchestration service (`packages/backend/src/orchestration/pipeline.service.ts`) that replaced the old 8-node LangGraph state machine and 4-agent ensemble:
1. **analyzeIntent**: AI-powered intent detection
2. **research**: Multi-source research & planning (GitHub, web, APIs, docs)
3. **planTools**: One structured Claude call that plans the tool set (replaces the deleted 4-agent ensemble)
4. **clarify**: Gap detection; pauses and persists state on the conversation row, resumes without re-running research
5. **refine**: Generate-Test-Refine loop, max 5 iterations, Docker-sandboxed validation
6. **persist**: Save the final generated server and a `pipeline_runs` observability record
7. **provideHelp** / **handleError**: Side paths for help requests and failures

### Frontend Design
- **LibreChat-Inspired**: Clean, minimal aesthetic
- **Collapsible Sidebar**: Conversation history management
- **Centered Chat**: Focused, distraction-free interface
- **Top Navigation**: Model selector and navigation
- **Responsive**: Mobile-optimized design
- **Custom Components**: Lightweight, no heavy Material components

### Backend Services
- **GenerationPipeline**: Orchestrates the full analyzeIntent → research → planTools → clarify → refine → persist flow
- **ResearchService**: Input-agnostic research (GitHub/web/APIs/docs)
- **RefinementService**: Generate-Test-Refine loop (max 5 iterations)
- **McpTestingService**: Docker-sandboxed MCP server validation
- **GitHubAnalysisService**: Repository analysis with Octokit
- **AnthropicService**: Single seam to Claude — structured outputs, retries, token/cost telemetry

## Technology Stack

**Backend**
- NestJS + TypeScript
- Explicit `GenerationPipeline` orchestration (no LangGraph — `@langchain/*` removed)
- PostgreSQL with TypeORM
- Claude Sonnet 5 (default) / Claude Haiku 4.5 (small tier)
- Server-Sent Events (SSE) for streaming, gated by single-use stream tickets

**Frontend**
- Angular 20
- Custom form controls and styling
- Responsive design patterns
- LibreChat aesthetic

**Infrastructure**
- Local Docker builds (30s vs 2-5min cloud)
- GitHub API integration via Octokit
- Environment-based configuration

## Architecture Highlights

### Conversational Flow
```
User Input → analyzeIntent → [Routing Decision]
                    ↓
          research (Multi-source research)
                    ↓
          planTools (single structured call plans the tool set)
                    ↓
          clarify (Gap detection; pause/resume on conversation row)
                    ↓
          refine (Generate-Test-Refine, max 5 iterations)
                    ↓
          persist → Complete MCP Server

Alternative paths:
- clarify pauses and waits for user input (resumes without re-running research)
- provideHelp (for help requests)
- handleError (for errors)
```

### Database Schema
- **Conversations**: Session management, message history, and pipeline pause/resume state (`state.currentNode`, `state.generatedCode`, etc.)
- **PipelineRuns**: Per-step observability record (step, status, timing, input/output summary, error) — replaced the old write-only LangGraph checkpoints

### Cost Optimization
- claude-haiku-4-5 for cheap classification/extraction, claude-sonnet-5 for reasoning/synthesis/codegen
- Token/cost telemetry tracked in Prometheus (`ai_calls_total`, `ai_tokens_total`, `ai_cost_usd_total`); ~$0.22 tracked cost observed per full generation
- Intelligent caching for repository analysis
- Local Docker builds minimize cloud costs

## Generated MCP Server Structure

Each generated server includes:
```
mcp-server-example/
├── src/
│   └── index.ts          # Complete MCP server implementation
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── README.md             # Usage documentation
├── Dockerfile            # Container configuration
└── .dockerignore
```

Servers are **dual-transport**, controlled by `MCP_TRANSPORT`:
- unset / `stdio` (default) - `StdioServerTransport`, for Claude Desktop and
  the GitHub/Gist download path
- `http` - `StreamableHTTPServerTransport` on `POST /mcp` (`PORT`, default
  3000) plus `GET /health`, for hosting (K8s manifests set this
  automatically)

Built on the high-level `McpServer` + `registerTool` API from
`@modelcontextprotocol/sdk` (pinned `1.30.0`), protocol version `2025-11-25`.

## API Endpoints

### Chat API
- `POST /api/chat/message` - Send message to AI (authenticated)
- `POST /api/chat/stream-ticket` - Issue a single-use, 60s SSE stream ticket (authenticated)
- `GET /api/chat/stream/:sessionId` - SSE stream for real-time updates (requires a valid stream ticket)
- `POST /api/chat/close/:sessionId` - Close conversation session
- `GET /api/chat/health` - Health check

The previous unauthenticated debug endpoints (`POST /chat`, `/analyze`, `/discover-tools`, `/generate-mcp`, `/generate`) have been deleted; all generation now goes through the authenticated chat message flow.

## Development

### Running Tests
```bash
# Backend tests
npm run test:backend

# Frontend tests
npm run test:frontend

# E2E tests
npm run test:e2e
```

### Code Quality
```bash
# Lint
npm run lint

# Format
npm run format
```

### Building for Production
```bash
# Build all packages
npm run build

# Build Docker images
npm run docker:build
```

## Configuration

### Required Environment Variables
```bash
# AI & API Keys
ANTHROPIC_API_KEY=sk-ant-xxx...      # Required for generation
GITHUB_TOKEN=ghp_xxx...              # Required for repository analysis

# Database
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE_NAME=mcp_everything

# Application
NODE_ENV=development
PORT=3000
```

### Optional Settings
```bash
# Docker
DOCKER_HOST=unix:///var/run/docker.sock

# Performance
CACHE_ENABLED=true
MAX_PARALLEL_OPERATIONS=4
```

## Deployment

### Docker Compose (Recommended)
```bash
npm run docker:up
```

### Manual Deployment
See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed deployment instructions.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - Technical architecture details
- [DEVELOPMENT.md](DEVELOPMENT.md) - Complete development guide
- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment and production setup
- [ROADMAP.md](ROADMAP.md) - Vision alignment and implementation roadmap
- [DOCUMENTATION.md](DOCUMENTATION.md) - Documentation navigation guide
- [MANUAL_TESTING.md](MANUAL_TESTING.md) - Manual testing guide (5 sessions, 7 layers)
- [CLAUDE.md](CLAUDE.md) - AI assistant instructions

## Performance Metrics

- **Database Write**: <100ms (PostgreSQL)
- **SSE Latency**: <50ms
- **Cost per Generation**: ~$0.22 tracked cost observed for a full pipeline run (analyzeIntent → research → planTools → refine), per Prometheus `ai_cost_usd_total`

## Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open Pull Request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Links

- **Repository**: https://github.com/4eyedengineer/mcp-everything
- **Issues**: https://github.com/4eyedengineer/mcp-everything/issues
- **MCP Specification**: https://modelcontextprotocol.io

## Support

For questions, issues, or feature requests, please open an issue on GitHub.
