# Claude Code Assistant Instructions

## Project Context

This is **MCP Everything** - an AI-native platform for automatically generating and hosting Model Context Protocol (MCP) servers from any input (GitHub repositories, API specifications, natural language descriptions).

## Key Reference Files

- **`README.md`**: Project overview and current status
- **`ROADMAP.md`**: Vision alignment analysis and implementation roadmap
- **`ARCHITECTURE.md`**: Complete technical architecture documentation
- **`DEVELOPMENT.md`**: Development setup and contributing guide
- **`DEPLOYMENT.md`**: Production deployment instructions

## Current Status

- **Phase**: Integration-Ready MVP (January 2025)
- **Repository**: https://github.com/4eyedengineer/mcp-everything
- **Implementation**: LangGraph state machine fully coded ✅
- **Frontend**: LibreChat-inspired design fully implemented ✅
- **Architecture**: AI-first conversational interface with 8-node workflow
- **Backend**: All core services implemented (analysis, generation, validation) ✅
- **Database**: PostgreSQL schema defined ✅
- **Reality Check**: Code complete but never run end-to-end ⚠️
- **Vision Alignment**: 60% - Strong generator, missing business infrastructure
- **Critical Gaps**: Authentication, payments, hosting, marketplace backend
- **Next Milestone**: First real MCP server generation and validation

## Architecture Decisions Made

### Build Strategy: Local-First, Cloud-Optional

- **KEEP IT SIMPLE** so we build and compile successfully with each change
- **Local Docker builds** for fast iteration (30s vs 2-5min cloud)
- **Centralized build system** instead of per-repo GitHub Actions
- **Tiered hosting**: Gist (free) → Private Repo (pro) → Enterprise (custom)
- **No repository explosion** - avoid creating thousands of GitHub repos

### Technology Stack

- **Backend**: NestJS + TypeScript + LangGraph + PostgreSQL
- **Frontend**: Angular 20 with LibreChat-inspired design
- **AI**: Claude Haiku 3.5 (cost-effective: $0.001/conversation turn)
- **State Management**: PostgreSQL with conversation checkpoints
- **Streaming**: Server-Sent Events (SSE) for real-time updates
- **Build**: Local Docker with hybrid cloud deployment

## Service Dependencies & API Keys

### Currently Available ✅

- **GitHub**: PAT working, MCP tools available, repository created
- **Anthropic API**: Claude Haiku integrated and operational
- **PostgreSQL**: Database running with conversations and checkpoints

### Optional Services 🔲

- **Docker Hub**: Container registry (for deployment)
- **Vercel**: Serverless hosting (for free tier deployment)

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

### LangGraph State Machine (8 Nodes)
```typescript
@Module({
  providers: [
    GraphOrchestrationService,  // LangGraph workflow execution
    ResearchService,            // Input-agnostic research (GitHub/web/APIs/docs)
    EnsembleService,            // Parallel reasoning with 4 specialist agents
    ClarificationService,       // AI-powered gap detection
    RefinementService,          // Generate-Test-Refine loop
    McpTestingService,          // Docker-based MCP server validation
    GitHubAnalysisService,      // Repository analysis with Octokit
    McpGenerationService,       // MCP server code generation
    CodeExecutionService,       // Secure validation with isolated-vm
  ]
})
export class ChatModule {}
```

### LangGraph Nodes
1. **analyzeIntent**: AI-powered intent detection (Claude Haiku)
2. **researchCoordinator**: Multi-source research & planning (GitHub, web, APIs, docs)
3. **ensembleCoordinator**: Parallel reasoning with 4 specialist agents + voting
4. **clarificationOrchestrator**: AI-powered gap detection & iterative clarification
5. **refinementLoop**: Generate-Test-Refine cycle until all tools work
6. **clarifyWithUser**: Multi-turn conversation for ambiguous requests ✅ Tested
7. **provideHelp**: User assistance and guidance
8. **handleError**: Graceful error recovery

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

## Current Priorities (60% Vision Complete)

### Phase 1: Validate Core (IMMEDIATE - Weeks 1-2) 🎯
1. **First Run**: Initialize database, start services, validate system works
2. **Real Generation**: Generate first MCP server from any input (GitHub repo, API docs, service name, natural language)
3. **Integration Testing**: Validate complete workflow (chat → research → ensemble → clarification → refinement)
4. **Bug Fixing**: Address issues discovered during first real run
5. **Documentation Updates**: Document actual vs expected behavior

### Phase 2: Business Foundation (CRITICAL - Weeks 3-6) 💰
**Why Critical**: No revenue model = Not a business

1. **User Authentication**: OAuth (Google, GitHub) + email/password
2. **Stripe Integration**: Subscriptions, payments, credits system
3. **Hosting Infrastructure**: Deploy generated MCP servers with custom domains
4. **Billing System**: Usage tracking, invoicing, webhooks

### Phase 3: Marketplace Backend (HIGH - Weeks 7-9) 🛒
**Why High**: Core value proposition currently has placeholder data

1. **Database Schema**: MCP servers, tags, categories
2. **CRUD API**: Create, read, update, delete servers
3. **Search**: Text-based search (semantic search in Phase 4)
4. **Frontend Integration**: Connect Explore page to real backend

**See [ROADMAP.md](ROADMAP.md) for complete vision alignment analysis and 13-week implementation plan.**

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
- Use real GitHub repositories for testing from day 1
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
