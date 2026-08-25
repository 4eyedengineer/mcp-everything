# MCP Everything - Roadmap & Vision Alignment

**Last Updated**: August 2026 (post rework/2026-07-review; cloud/k8s hosting verified 2026-08-25)
**Vision Alignment**: Core generator validated end-to-end, in production, including the cloud/Kubernetes hosting and aggregator path. Most business infrastructure is built. Remaining: real payments (no Stripe products/prices configured yet), plus a handful of ops/credential gaps.

---

## Executive Summary

The 8-node LangGraph state machine and 4-agent ensemble described below have been **deleted** and replaced by `GenerationPipeline`, an explicit orchestration service (analyzeIntent → research → planTools → clarify → refine → persist). On 2026-07-29 the pipeline generated two working MCP servers end-to-end in local dev (JSONPlaceholder: 7/7 and 10/10 tools passing), independently verified via stdio JSON-RPC — the "never run end-to-end" gap called out throughout this document is closed.

Since then, authentication (global JWT guard + ownership checks), a real marketplace backend (seeded with 6 servers), and a hosting/deployment pathway (Dockerfile generation, CI image publishing) have also been built. **On 2026-08-25 the full loop was verified live in production** on the self-hosted homelab k3s cluster: a chat request generated a JSONPlaceholder MCP server (research → tool planning → codegen → validation inside a hardened, throwaway Kubernetes test pod, all tools passing on iteration 1 → persisted), the generated server was hosted on the cluster and came up serving MCP over HTTP, and the platform's own aggregator MCP server (`search_tools` / `call_tool`) discovered and called that hosted server's tools through a single API-key connection. What remains: real payments (Stripe code is implemented and correctness-fixed, but no products/prices are configured, so nothing is purchasable), and a few credential/ops gaps (expired `GITHUB_TOKEN`, no email provider, no database backups in this repo). See the per-section 2026-08 notes below for detail.

The sections below are preserved largely as originally written, with status notes added where the rework changed the picture — treat percentages/estimates as historical unless a note says otherwise.

**Analogy**: We built a sophisticated Ferrari engine, and have since bolted on a chassis, wheels, and a dealership, and taken it for a real test drive around the block. The payment system at the register is still not switched on.

---

## Vision Alignment Analysis

### ✅ FULLY IMPLEMENTED (60% of Vision)

#### 1. Core Technology Stack ✅ 100%
**Original Vision**: "Angular for frontend, NestJS for backend, shared typing"

**Current State**:
- ✅ Angular 20 with LibreChat-inspired design
- ✅ NestJS backend with TypeScript strict mode
- ✅ Shared types package
- ✅ Clean, monochrome aesthetic (exactly as specified)

**Status**: Perfect alignment, no work needed.

---

#### 2. AI-Powered MCP Generation ✅ 90% (historical estimate — see 2026-07 update)
**Original Vision**: "AI Research engine + MCP Server builder powered by AI (many LLMs/sub-task agents)"

**Current State (as originally written)**:
- ✅ LangGraph state machine with 8 specialized nodes
- ✅ Claude Haiku 3.5 integration (cost-optimized at $0.001/turn)
- ✅ Multi-agent architecture (intent, context, planning, code generation, validation agents)
- ✅ GitHub repository analysis ([GitHubAnalysisService](packages/backend/src/github-analysis.service.ts))
- ✅ Intelligent tool discovery ([ToolDiscoveryService](packages/backend/src/tool-discovery.service.ts))
- ✅ Code generation ([McpGenerationService](packages/backend/src/mcp-generation.service.ts))
- ✅ Secure validation with isolated-vm ([CodeExecutionService](packages/backend/src/orchestration/code-execution.service.ts))

**Gap (as originally written)**: Never run end-to-end with real repositories ⚠️

> **2026-07 update**: The LangGraph state machine, its multi-agent architecture, `ToolDiscoveryService`, and `McpGenerationService` have all been **deleted** and replaced by `GenerationPipeline` (analyzeIntent → research → planTools → clarify → refine → persist), a single explicit orchestration service. The "never run end-to-end" gap is **closed**: on 2026-07-29 the pipeline generated two working MCP servers (JSONPlaceholder, 7/7 and 10/10 tools passing), independently verified via stdio JSON-RPC. AI now runs through a single `AnthropicService` (claude-sonnet-5 default / claude-haiku-4-5 small tier) with token/cost telemetry — ~$0.22 tracked cost observed per full generation, not $0.001/turn.
>
> **2026-08-25 update**: The 2026-07-29 run was local dev only. On 2026-08-25 the pipeline was verified running live in production on the homelab k3s cluster, with untrusted, LLM-generated code validated inside an isolated, hardened Kubernetes test pod (`K8sTestSandboxService`) rather than local Docker: `automountServiceAccountToken: false`, non-root, read-only rootfs, all capabilities dropped, seccomp, CPU/memory limits, torn down after each run. The backend fails closed with no sandbox available and hard-disables the old unsandboxed host-execution escape hatch under `NODE_ENV=production`.

---

#### 3. Natural Language Interface ✅ 95%
**Original Vision**: "Multimodal chat powered by leading AI LLM"

**Current State**:
- ✅ Conversational chat interface
- ✅ Natural language intent detection
- ✅ Multi-turn conversations with context preservation
- ✅ SSE streaming for real-time updates
- ✅ Session persistence with PostgreSQL
- ✅ Intelligent clarification when needed

**Gap**: Not multimodal (text only, no image/file upload) ⚠️

**Next Steps**: Add file upload capability for API specs, diagrams, etc.

---

#### 4. GitHub Repository Integration ✅ 85% (historical estimate — gap closed, see below)
**Original Vision**: "Dropping in GitHub repo link, crawl, understand, provide MCP Server"

**Current State**:
- ✅ GitHub URL extraction from natural language
- ✅ Repository metadata retrieval (Octokit)
- ✅ README parsing and understanding
- ✅ Code structure analysis
- ✅ API pattern detection
- ✅ Language/framework identification

**Gap (as originally written)**: Never actually generated a working MCP server ⚠️

> **2026-07 update**: The pipeline as a whole is now proven end-to-end (2026-07-29, JSONPlaceholder REST API input, 7/7 and 10/10 tools passing across two runs). Note the validated run was a service-name/API input, not a `github.com/...` URL specifically — GitHub-URL-triggered generation shares the same `research`/`planTools`/`refine` steps but has not been separately confirmed with a real repository since the rework.

---

### ⚠️ PARTIALLY IMPLEMENTED (20-40% Complete)

#### 5. Marketplace/Discovery ⚠️ 20% (historical estimate — now largely built, see below)
**Original Vision**: "Discovery marketplace of available MCP Servers to consume/search"

**Current State (as originally written)**:
- ✅ Explore component UI ([explore.component.ts](packages/frontend/src/app/features/explore/explore.component.ts))
- ✅ Placeholder data with mock servers
- ✅ Basic card-based display
- ❌ No backend API for marketplace
- ❌ No database schema for hosted servers
- ❌ No actual search functionality
- ❌ No server upload/storage system

> **2026-07 update**: A real marketplace backend now exists (`packages/backend/src/marketplace/`), seeded with 6 servers, with an interim `AdminGuard` gated by an `ADMIN_USER_EMAILS` env var. The frontend Explore page consumes the real API — the "placeholder data" gap is closed.

**Gap Analysis**:
```
Missing Backend Components:
- MarketplaceService (search, list, retrieve)
- McpServer entity (database model)
- Storage system (S3, filesystem)
- Tagging/categorization system
- Download/deployment API

Missing Frontend Components:
- Real search with filters
- Server detail pages
- Installation instructions
- Usage examples
```

**Priority**: High - Core value proposition

**Estimated Effort**: 2-3 weeks

**Next Steps**:
1. Design database schema for MCP servers
2. Create MarketplaceService with CRUD operations
3. Implement search API (text-based initially)
4. Connect frontend to real backend
5. Add server upload capability

---

#### 6. Containerization ⚠️ 30% (historical estimate — manifests now exist and were verified end-to-end 2026-08-25)
**Original Vision**: "Built for Docker/Kubernetes, scalable and highly available"

**Current State (as originally written)**:
- ✅ Docker dependencies installed (dockerode)
- ✅ Docker base configurations ([docker/](docker/))
- ✅ Dockerfile templates for MCP servers
- ❌ No Kubernetes manifests (deployment, service, ingress)
- ❌ No container orchestration
- ❌ No auto-scaling configuration
- ❌ No health checks/readiness probes

> **2026-07 update**: Kubernetes manifests now exist under `k8s/` (base + production/development overlays, HPA, ingress, cert-manager, monitoring namespace with Prometheus/Grafana), and `.github/workflows/deploy.yml` builds and pushes `:latest` images on every push to `main`.
>
> **2026-08-25 update**: The cluster deploy path **has now been exercised and verified end-to-end**, running on the self-hosted homelab k3s cluster (not a commercial cloud). A generated server was deployed via "Host on Cloud"; the `mcp-runner` pod fetched its source, ran `npm install` + `tsc`, came up 1/1 Running, and served MCP over HTTP, reachable through the gateway. Note the CI workflow that builds `:latest` on `main` runs lint/typecheck/tests only on `main`; the homelab ArgoCD deploy tracks `rework/2026-07-review` directly, without that CI gate.

**Gap Analysis**:
```
Missing Infrastructure:
- k8s/deployment.yaml
- k8s/service.yaml
- k8s/ingress.yaml
- Horizontal Pod Autoscaler
- Resource limits/requests
- ConfigMaps/Secrets management
- Helm charts (optional)
```

**Priority**: Medium - Important for scale, not MVP

**Estimated Effort**: 1-2 weeks

**Next Steps**:
1. Create basic Kubernetes manifests
2. Set up local k8s testing (minikube/kind)
3. Configure health checks
4. Test scaling behavior

---

#### 7. Testing & Documentation ⚠️ 40% (historical estimate — CI/CD now exists)
**Original Vision**: "Complete with passing tests/documentation"

**Current State (as originally written)**:
- ✅ 80+ E2E Playwright tests written ([e2e/](packages/frontend/e2e/))
- ✅ Test infrastructure complete
- ✅ Comprehensive documentation (README, ARCHITECTURE, DEVELOPMENT)
- ⚠️ Backend unit tests minimal
- ❌ No integration tests run
- ❌ Generated servers have no tests
- ❌ No CI/CD pipeline configured

> **2026-07 update**: `.github/workflows/ci.yml`, `e2e.yml`, and `deploy.yml` now exist. Backend unit test coverage has grown substantially with the rework (orchestration, pipeline, deployment provider specs). Generated-server validation tests run as part of the Docker-sandboxed refine loop rather than a separate suite.

**Gap Analysis**:
```
Missing Test Coverage:
- Backend service unit tests
- Integration tests (database + API)
- MCP protocol compliance tests
- Performance/load testing
- Generated server validation tests

Missing CI/CD:
- GitHub Actions workflows
- Automated test runs on PR
- Docker image builds
- Deployment automation
```

**Priority**: High - Quality assurance critical

**Estimated Effort**: 2 weeks

**Next Steps**:
1. Write backend unit tests (Jest)
2. Set up integration test database
3. Create GitHub Actions workflow
4. Add generated server test suite

---

### ❌ NOT IMPLEMENTED (Critical Gaps)

#### 8. Hosting & Revenue Model ❌ 0% (historical — auth and hosting are no longer missing; payments still are)
**Original Vision**: "1-click hosting, Stripe payment collection, hosting as main revenue"

**Current State (as originally written)**: **COMPLETELY MISSING**

> **2026-07 update**: User authentication (email/password, password reset, Google/GitHub OAuth strategies, global JWT guard + ownership checks) and a hosting/deployment pathway (Dockerfile generation, `Deployment`/`HostedServer` entities, deployment providers for gist/devcontainer/CI-workflow/local-Docker, `deploy.yml` publishing images) are now built. Tier-based quota enforcement (monthly usage limits, `UsageRecord`) is in progress. **Still missing**: Stripe/payment integration and a real end-to-end cloud/k8s deploy exercise.

**Required Components**:
```
Authentication & Users:
- User registration/login system
- OAuth providers (Google, GitHub)
- Email/password authentication
- Password reset flow
- User profile management
- Session management

Payment & Billing:
- Stripe integration
- Subscription plans (Free, Pro, Team)
- Credit-based system
- Payment method storage
- Billing history
- Invoice generation
- Webhook handlers for Stripe events

Hosting Infrastructure:
- MCP server deployment system
- DNS configuration
- SSL certificate management
- Custom domain support
- Server lifecycle management (start, stop, restart)
- Resource monitoring
- Log aggregation
- Backup/restore

Database Schema:
- users table
- subscriptions table
- payments table
- hosted_servers table
- usage_metrics table
```

**Gap Impact**: **BUSINESS CANNOT GENERATE REVENUE**

**Priority**: **CRITICAL - This is the entire business model**

**Estimated Effort**: 4-6 weeks

**Next Steps**:
1. **Week 1-2**: User authentication
   - Implement OAuth with Passport.js
   - Add email/password authentication
   - Create user registration flow
   - Build profile management

2. **Week 3-4**: Stripe integration
   - Set up Stripe account
   - Implement subscription plans
   - Add payment method management
   - Create credit system
   - Build webhook handlers

3. **Week 5-6**: Hosting infrastructure
   - Design deployment architecture
   - Implement server provisioning
   - Set up DNS/SSL automation
   - Build monitoring system
   - Create server management API

---

#### 9. Authentication Passthrough ❌ 0%
**Original Vision**: "Auth passthrough for APIs (API keys, SSO, OAuth 2.0)"

**Current State**: **COMPLETELY MISSING**

**Required Components**:
```
OAuth 2.0 Flow:
- Authorization server integration
- Token acquisition
- Token refresh logic
- Scope management
- State parameter security

API Key Management:
- Secure credential storage (encrypted)
- Key rotation support
- Multiple key types (header, query, body)
- Environment variable injection

SSO Integration:
- SAML support
- OpenID Connect
- Enterprise directory integration

Generated Server Integration:
- Credential injection into MCP servers
- Secure runtime environment
- Token refresh in long-running servers
```

**Gap Impact**: Can't generate MCP servers for authenticated APIs (GitHub, Stripe, Google, etc.)

**Priority**: High - Blocks many use cases

**Estimated Effort**: 3-4 weeks

**Next Steps**:
1. Design credential storage architecture
2. Implement OAuth 2.0 flow
3. Add API key management UI
4. Integrate with MCP server generation
5. Test with real authenticated APIs

---

#### 10. GitHub Gist/Repo Publishing ❌ 10% (historical — now implemented)
**Original Vision**: "Provide GitHub link for free, users can host elsewhere"

**Current State (as originally written)**:
- ✅ GitHub token configured
- ❌ No gist creation logic
- ❌ No repository creation
- ❌ No automated publishing

> **2026-07 update**: `packages/backend/src/deployment/providers/` now includes `gist.provider.ts`, `github-repo.provider.ts`, `devcontainer.provider.ts`, and `ci-workflow.provider.ts` — gist and repository publishing exist as deployment providers alongside local Docker deployment.

**Required Components**:
```
Gist Publishing:
- Create gist via GitHub API
- Upload generated files
- Set gist description
- Return shareable URL

Repository Publishing:
- Create GitHub repository
- Initialize with generated code
- Set up README
- Configure repository settings
- Handle collaboration (for teams)

Download Options:
- ZIP file generation
- Direct GitHub link
- Docker image (if containerized)
```

**Gap Impact**: Users can't easily share/deploy generated servers

**Priority**: Medium - Free tier offering

**Estimated Effort**: 1 week

**Next Steps**:
1. Implement gist creation API
2. Add repository creation option
3. Build download ZIP functionality
4. Create sharing UI

---

#### 11. Semantic Search ❌ 0%
**Original Vision**: "Embed and vectorize MCP servers for semantic search"

**Current State**: **COMPLETELY MISSING**

**Required Components**:
```
Vector Database:
- Qdrant, Pinecone, or Weaviate integration
- Schema design for MCP server embeddings
- Index management

Embedding Generation:
- OpenAI embeddings or similar
- Server description vectorization
- Tool/capability vectorization
- Batch processing pipeline

Search API:
- Semantic similarity search
- Hybrid search (text + vector)
- Filtering by tags, language, etc.
- Result ranking/scoring

UI Integration:
- Search bar with autocomplete
- "Similar servers" recommendations
- "Users also downloaded" features
```

**Gap Impact**: Marketplace limited to basic text search

**Priority**: Medium - Competitive advantage

**Estimated Effort**: 2-3 weeks

**Next Steps**:
1. Choose vector database (recommend Qdrant)
2. Implement embedding generation
3. Create search API
4. Integrate with marketplace UI

---

#### 12. Agent-First Architecture ❌ 10%
**Original Vision**: "Built for agents and humans equally, provide MCP server for MCP Everything itself"

**Current State**:
- ✅ MCP protocol understanding evident in codebase
- ❌ No MCP server for the platform itself
- ❌ No agent-specific APIs
- ❌ No A2A/AP2 integration

**Required Components**:
```
Platform MCP Server:
Tools:
- generate_mcp_server(github_url, options)
- search_marketplace(query)
- download_server(server_id)
- get_user_servers()

Resources:
- marketplace://featured
- marketplace://recent
- user://servers
- user://usage

Agent-Optimized APIs:
- Structured JSON responses
- Tool use examples
- Clear parameter schemas
- Error handling for agents

A2A/AP2 Integration:
- Agent discovery protocol
- Inter-agent communication
- Capability advertising
```

**Gap Impact**: Platform not accessible to AI agents

**Priority**: Medium - Emerging ecosystem

**Estimated Effort**: 2 weeks

**Next Steps**:
1. Generate MCP server for platform
2. Design agent-friendly API schemas
3. Add to marketplace for discovery
4. Test with Claude Desktop, other agents

---

## Implementation Roadmap

### Phase 1: Validate Core (Weeks 1-2) 🎯 ✅ **DONE (2026-07-29)**

**Goal**: Prove the generation engine works

**Tasks (as originally written)**:
- [ ] Initialize PostgreSQL database
- [ ] Start backend and frontend services
- [ ] Generate first real MCP server (test with Express.js)
- [ ] Document bugs and issues
- [ ] Fix critical bugs
- [ ] Validate LangGraph workflow
- [ ] Test with 5+ real repositories

**Success Criteria (as originally written)**:
- Generate working MCP server for at least 3 different repositories
- All 8 LangGraph nodes execute successfully
- Generated code compiles without errors
- MCP protocol compliance verified

> **2026-07 update**: The LangGraph workflow itself was deleted and replaced by `GenerationPipeline` as part of this validation effort. The pipeline generated two working MCP servers (JSONPlaceholder, 7/7 and 10/10 tools passing), independently verified via stdio JSON-RPC — proving the core generation engine works, though not against 3+ *different* repositories as originally scoped, and not specifically against a GitHub-URL input.

**Risk**: Resolved — the core generator works.

---

### Phase 2: Business Foundation (Weeks 3-6) 💰 **CRITICAL** — Largely done, payments still missing

**Goal**: Enable revenue generation

**Week 3: Authentication** ✅ Done
- [x] User registration (email + password)
- [x] OAuth integration (Google, GitHub)
- [x] Session management
- [x] Password reset flow
- [ ] User profile pages

**Week 4: Stripe Integration** ❌ Not started
- [ ] Stripe account setup
- [ ] Subscription plans (Free, Pro, Team)
- [ ] Payment method management
- [ ] Webhook handlers
- [ ] Billing dashboard

**Week 5-6: Hosting Infrastructure** ⚠️ Mostly done, cloud path unverified
- [x] Server deployment system (local Docker, gist, GitHub repo, devcontainer, CI-workflow providers)
- [ ] DNS/SSL automation
- [x] Resource monitoring (Prometheus/Grafana)
- [x] Server management API
- [ ] Admin dashboard (interim `AdminGuard` via `ADMIN_USER_EMAILS` only)
- [ ] Tier-based quota enforcement — in progress

**Success Criteria (as originally written)**:
- Users can sign up and pay
- MCP servers can be hosted with custom domains
- Revenue can be collected

> **2026-07 update**: Users can sign up (including OAuth). MCP servers can be deployed locally/via gist/repo, but hosting with custom domains and revenue collection are still not in place.

**Risk**: Medium - Complex but well-documented patterns

---

### Phase 3: Marketplace (Weeks 7-9) 🛒 ✅ **Backend and frontend done**

**Goal**: Enable discovery and sharing

**Week 7: Backend** ✅ Done
- [x] Marketplace database schema
- [x] CRUD API for MCP servers
- [x] Text-based search
- [x] Tagging/categorization
- [ ] Upload endpoint (seeded, not yet user-uploadable)

**Week 8: Frontend** ✅ Done
- [x] Connect Explore page to real backend
- [x] Search with filters
- [x] Server detail pages
- [ ] Installation instructions
- [ ] Usage examples

**Week 9: Polish** — Not yet done
- [ ] Featured servers
- [ ] Trending servers
- [ ] User ratings/reviews
- [ ] Download analytics

**Success Criteria**:
- Users can browse generated servers ✅
- Search works for basic queries ✅
- Servers can be downloaded/deployed ✅ (via deployment providers)

**Risk**: Low - Standard CRUD application

---

### Phase 4: Advanced Features (Weeks 10-13) 🚀

**Week 10: Semantic Search**
- [ ] Vector database setup (Qdrant)
- [ ] Embedding generation pipeline
- [ ] Semantic search API
- [ ] UI integration

**Week 11-12: Auth Passthrough**
- [ ] Credential storage (encrypted)
- [ ] OAuth 2.0 flow
- [ ] API key management
- [ ] Integration with generation

**Week 13: Agent-First**
- [ ] Platform MCP server
- [ ] Agent-optimized APIs
- [ ] A2A/AP2 integration
- [ ] Testing with Claude Desktop

**Success Criteria**:
- Semantic search finds relevant servers
- Can generate servers for authenticated APIs
- Platform accessible to AI agents

**Risk**: Medium - New technologies (vector DB)

---

### Phase 5: Scale & Polish (Weeks 14+) 📈

**Kubernetes & Orchestration**:
- [ ] Kubernetes manifests
- [ ] Horizontal auto-scaling
- [ ] Load testing
- [ ] Performance optimization

**Testing & Quality**:
- [ ] Backend unit tests (>80% coverage)
- [ ] Integration tests
- [ ] CI/CD pipeline
- [ ] Generated server test suites

**Enterprise Features**:
- [ ] Team collaboration
- [ ] SSO integration
- [ ] Advanced analytics
- [ ] Custom branding

**Documentation**:
- [ ] API documentation (Swagger)
- [ ] User guides
- [ ] Video tutorials
- [ ] Developer onboarding

---

## Feature Alignment Score by Phase

Original percentages, preserved for history:

| Phase | Features Addressed | Alignment After |
|-------|-------------------|-----------------|
| **Current (Jan 2025)** | Core generator | 60% |
| **Phase 1** | Validation | 65% |
| **Phase 2** | Auth + Payments + Hosting | 80% |
| **Phase 3** | Marketplace | 85% |
| **Phase 4** | Advanced features | 95% |
| **Phase 5** | Scale + Polish | 100% |

**2026-07 status**: Phase 1 (validation) is done. Phase 2 is done except payments. Phase 3 is done except upload/polish. Phases 4-5 remain largely unstarted (no vector search, auth passthrough, agent-first APIs, or verified k8s scaling). We are not assigning a new single percentage here — the phases don't map cleanly onto what actually got built (e.g., k8s manifests exist per Phase 5 but are untested, while marketplace per Phase 3 is functionally done) — but the practical state is closer to "Phase 3 done, Phase 2 payments outstanding" than a 60% snapshot suggests.

**2026-08-25 status**: The k8s deploy path called out above as "untested" has since been exercised and verified end-to-end (generation, hosting, and aggregator access all confirmed working on the cluster). Auto-scaling/HPA under real load is still unverified, and Phases 4-5 (vector search, auth passthrough, agent-first APIs beyond the aggregator, enterprise features) remain largely unstarted. Payments (Phase 2) remain the largest outstanding gap.

---

## Risk Assessment

### High Risk ⚠️
1. **Phase 1 validation fails** - If generator doesn't work, foundational problem
2. **Hosting complexity underestimated** - Infrastructure can be tricky

### Medium Risk ⚠️
1. **Stripe integration issues** - Webhooks, edge cases
2. **Vector search performance** - Scaling semantic search
3. **Auth passthrough security** - Credential handling

### Low Risk ✅
1. **Marketplace CRUD** - Standard patterns
2. **Kubernetes setup** - Well-documented
3. **Frontend development** - Already proven capable

---

## Dependencies & Prerequisites

### External Services Needed
- [x] Anthropic API (have key)
- [x] GitHub API (have token)
- [ ] Stripe account (for payments)
- [ ] Vector database (Qdrant/Pinecone)
- [ ] Email service (SendGrid/Mailgun)
- [ ] DNS provider (Cloudflare/Route53)
- [ ] SSL certificates (Let's Encrypt)
- [ ] Storage service (S3/GCS)

### Infrastructure Requirements
- [x] PostgreSQL database
- [ ] Redis (for sessions, caching)
- [x] Kubernetes cluster (self-hosted homelab k3s; manifests under `k8s/` deployed and verified 2026-08-25, not a commercial cloud)
- [x] Docker registry (GitHub Container Registry, via `deploy.yml`)
- [ ] Load balancer
- [x] Monitoring stack (Prometheus, Grafana — configured under `k8s/monitoring/`)

---

## Success Metrics

### Phase 1 (Validation)
- ⚠️ 2 working MCP servers generated (2026-07-29, local dev), not the original 3+ target, both against the same JSONPlaceholder input
- ✅ Zero critical bugs blocking generation flow at time of validation
- ✅ All pipeline steps (analyzeIntent, research, planTools, refine, persist) functional — this replaces the old "all LangGraph nodes" criterion
- ✅ Verified again 2026-08-25, live in production on the cluster: generation, sandboxed validation, hosting, and aggregator discovery/invocation all working end-to-end for a JSONPlaceholder server

### Phase 2 (Business)
- 🎯 10 paying users
- 🎯 $500 MRR
- 🎯 95% uptime for hosted servers

### Phase 3 (Marketplace)
- 🎯 50+ servers in marketplace
- 🎯 1000+ total downloads
- 🎯 Average 4+ star rating

### Phase 4 (Advanced)
- 🎯 Semantic search 30% better than text search
- 🎯 10+ authenticated API integrations
- 🎯 Platform accessible to 3+ AI agents

### Phase 5 (Scale)
- 🎯 100 concurrent users supported
- 🎯 99.9% uptime
- 🎯 <500ms API response time

---

## Conclusion

**Original (Jan 2025) State**: Excellent technical foundation (60% aligned with vision), core generator unvalidated.

**2026-07 State**: The generator is validated end-to-end (`GenerationPipeline` replaced LangGraph/ensemble). Authentication, marketplace, and a first-pass hosting/deployment pathway are built. The remaining critical gap is narrower than before: **payments** (no Stripe integration) and **proving the cloud/Kubernetes deploy path actually works** (manifests exist, untested).

**2026-08-25 State**: The cloud/Kubernetes deploy path gap above is closed, verified live in production on the homelab k3s cluster: generation (with untrusted code validated in a hardened, throwaway Kubernetes test pod, not local Docker), hosting (a generated server deployed and served MCP over HTTP through the gateway), and the platform's own aggregator MCP server (`search_tools` / `call_tool` discovering and invoking a hosted server's tools through one API-key connection) all ran end-to-end and were independently observed. Several supporting fixes shipped alongside this (Gist publishing now uses the signed-in user's own GitHub account, an SSRF guard on research URLs, Stripe webhook idempotency and an API-version/period bug fix, real `/terms` and `/privacy` pages, a sealed `TAVILY_API_KEY` in the cluster, a dropped unused-Redis health probe). The remaining critical gap is now narrower still: **real payments**. Stripe's code is implemented and correctness-fixed, but no products/prices are configured, so nothing is purchasable yet. A handful of smaller ops/credential gaps also remain (expired `GITHUB_TOKEN`, no email provider for password reset, no database backups configured in this repo, CI runs lint/typecheck/tests on `main` only while the homelab deploy tracks a branch without that gate, a ~50-60s cold start with no pre-warming/caching for hosted/test pods since each does a from-scratch `npm install` + `tsc`, and the platform runs on a self-hosted homelab cluster rather than a commercial cloud).

**Path Forward (remaining)**:
1. Configure Stripe products/prices and exercise billing with real payments
2. Provide a fresh `GITHUB_TOKEN` and configure an email provider for password reset
3. Add database backups for this repo's data (distinct from any homelab-level volume snapshots)
4. Marketplace polish (ratings, featured/trending, download analytics)
5. Advanced features (semantic search, auth passthrough, agent-first APIs) — unstarted

**Recommendation**: Prioritize real payments before advanced features. The generator, hosting, and aggregator now work end-to-end in production, but revenue collection is still unproven and a few ops/credential gaps remain.

---

**Last Updated**: July 2026 (rework/2026-07-review)
**Next Review**: After quota enforcement + first real cloud deploy
**Maintained By**: Engineering Team
