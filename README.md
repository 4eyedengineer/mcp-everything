# MCP Everything

AI-native conversational platform for automatically generating and hosting Model Context Protocol (MCP) servers through natural language chat.

## Status (July 2026)

**E2E-Validated — Core Generator Proven, Business Infrastructure Largely Built**

### ✅ What's Built and Validated
- `GenerationPipeline`: an explicit orchestration service (analyzeIntent → research → planTools → clarify → refine → persist) that replaced the old 8-node LangGraph state machine and 4-agent ensemble; `@langchain/*` dependencies fully removed
- Fully standalone Angular 20 frontend (no NgModules), functional interceptors/guards, signals-based chat state, SSE streaming
- Single `AnthropicService` AI layer: claude-sonnet-5 (default) / claude-haiku-4-5 (small tier), structured outputs, retries, token/cost telemetry in Prometheus
- PostgreSQL schema for conversations, deployments, and per-step `pipeline_runs` observability
- Global JWT guard with ownership checks on conversations/deployments/hosting; single-use 60s SSE stream tickets; Docker-sandboxed code execution (`npm --ignore-scripts`, no host env, resource limits); the 5 unauthenticated debug endpoints have been deleted
- Real marketplace backend, seeded with 6 servers; Explore page connects to the real API
- **Validated on 2026-07-29**: the pipeline generated two working MCP servers (JSONPlaceholder, 7/7 and 10/10 tools passing), independently verified via stdio JSON-RPC

### ⚠️ What Still Needs Validation
- **Cloud/Kubernetes deploy path** - manifests exist under `k8s/` but the deploy has never been exercised end-to-end
- **Quota enforcement** - tier-based monthly usage limits are in progress
- **Payments** - no Stripe/billing integration yet

### 🎯 Next Steps
1. Finish quota enforcement (tier monthly limits)
2. Add Stripe/payment integration
3. Exercise the cloud hosting and Kubernetes deploy path end-to-end

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
