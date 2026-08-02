# MCP Everything - Maximum Parallelization Execution Plan

## Overview

This plan organizes all work items into **execution waves** that maximize parallel work. Each wave contains issues that can be worked on simultaneously because they have no inter-dependencies within the wave.

**Key Insight**: Many tracks can run in parallel because they have different dependency chains:
- **Infrastructure Track**: Database, Docker, Logging
- **Core Validation Track**: Prompts, Research, E2E Testing
- **Auth Track**: Backend auth, OAuth, Frontend auth, Email
- **Marketplace Track**: Schema, API, Frontend
- **Business Track**: Stripe, Subscriptions, Usage

---

## Issue Counts Breakdown

| Category | Issues | Description |
|----------|--------|-------------|
| **EPICs** | 7 | #146, #153, #158, #165, #170, #174, #177 - Tracking only, not in waves |
| **Work Items** | 28 | Actionable tasks in waves below |
| **New (Added)** | 1 | #181 - Email service (gap fix) |
| **Backlog** | 3 | #124, #144, #145 - Pre-existing, address opportunistically |
| **Closed** | 2 | #41, #71 - Superseded by new roadmap |

> **Note**: EPICs are tracking/container issues and are intentionally excluded from execution waves. They exist for organizational purposes only.

---

## Execution Waves

### 🔵 WAVE 1: Foundation (Days 1-3)
**Parallel Streams**: 4 | **Total Issues**: 4

These have NO dependencies - start all immediately:

| Stream | Issue | Title | Effort |
|--------|-------|-------|--------|
| **Infra-A** | #148 | Fix PostgreSQL Docker image (pgvector) | 2-4 hrs |
| **Infra-B** | #147 | Error tracking database schema design | 1 day |
| **Core** | #154 | Create ensemble agent prompts JSON | 2-4 hrs |
| **Business** | #171 | Configure Stripe accounts/products | 4-6 hrs |

```
┌─────────────────────────────────────────────────────────────┐
│  WAVE 1 - All can start Day 1                               │
│                                                             │
│  #148 (pgvector)    #147 (error DB)    #154 (prompts)    #171 (stripe) │
│       ↓                   ↓                  ↓               ↓          │
└─────────────────────────────────────────────────────────────┘
```

---

### 🟢 WAVE 2: Infrastructure + Core Prep (Days 2-5)
**Parallel Streams**: 5 | **Total Issues**: 5

Start as soon as Wave 1 dependencies complete:

| Stream | Issue | Title | Blocked By | Effort |
|--------|-------|-------|------------|--------|
| **Infra-A** | #149 | Execute database migrations | #148 | 4-6 hrs |
| **Infra-B** | #151 | Structured logging service | #147 | 1-2 days |
| **Core** | #155 | Complete research service stubs | #154 (soft) | 2-3 days |
| **Marketplace** | #166 | MCP server database schema | #148 | 4-6 hrs |
| **Auth** | #181 | Configure email service | None | 4-6 hrs |

```
Wave 1 Complete
      ↓
┌─────────────────────────────────────────────────────────────┐
│  WAVE 2                                                     │
│                                                             │
│  #149 (migrations)  #151 (logging)  #155 (research)  #166 (schema)  #181 (email) │
│       ↓                  ↓               ↓               ↓              ↓         │
└─────────────────────────────────────────────────────────────┘
```

---

### 🟡 WAVE 3: Environment + Services (Days 4-7)
**Parallel Streams**: 4 | **Total Issues**: 4

Major parallel expansion:

| Stream | Issue | Title | Blocked By | Effort |
|--------|-------|-------|------------|--------|
| **Infra** | #150 | Unified local dev environment | #148, #149 | 1-2 days |
| **Core** | #156 | First E2E generation test | #149, #150, #154, #155 | 1-2 days |
| **Auth-A** | #159 | Backend auth module (JWT) | #149 | 3-4 days |
| **Marketplace** | #167 | Marketplace CRUD API | #149, #166 | 2-3 days |

> ⚠️ **Change from original**: #172 (Checkout) moved to Wave 4 due to hard dependency on #159 (Auth)

```
Wave 2 Complete
      ↓
┌─────────────────────────────────────────────────────────────┐
│  WAVE 3                                                     │
│                                                             │
│  #150 (dev env)  #156 (E2E)  #159 (auth)  #167 (API)       │
│       ↓              ↓            ↓            ↓            │
└─────────────────────────────────────────────────────────────┘
```

---

### 🟠 WAVE 4: Integration Layer (Days 6-10)
**Parallel Streams**: 6 | **Total Issues**: 7

OAuth, frontend work, and checkout begins:

| Stream | Issue | Title | Blocked By | Effort |
|--------|-------|-------|------------|--------|
| **Infra** | #152 | Health check endpoints | #150 | 4-6 hrs |
| **Core** | #157 | MCP protocol validation | #156 | 2-3 days |
| **Auth-B** | #160 | GitHub OAuth strategy | #159 | 1-2 days |
| **Auth-C** | #161 | Google OAuth strategy | #159 | 1 day |
| **Marketplace** | #168 | Frontend Explore integration | #167 | 2 days |
| **Business** | #172 | Subscription checkout flow | #149, #159, #171 | 2-3 days |
| **Testing** | #175 | LangGraph unit tests | #156 | 5-7 days |

> ⚠️ **Note**: #175 spans 5-7 days and will overflow into Wave 5. Plan accordingly.

```
Wave 3 Complete
      ↓
┌─────────────────────────────────────────────────────────────┐
│  WAVE 4                                                     │
│                                                             │
│  #152    #157    #160    #161    #168    #172    #175      │
│  (health) (MCP)  (GitHub) (Google) (FE)  (checkout) (tests) │
│    ↓       ↓       ↓        ↓       ↓       ↓        ↓      │
└─────────────────────────────────────────────────────────────┘
```

---

### 🔴 WAVE 5: Frontend Auth + Features (Days 9-14)
**Parallel Streams**: 4 | **Total Issues**: 5

Frontend-heavy wave:

| Stream | Issue | Title | Blocked By | Effort |
|--------|-------|-------|------------|--------|
| **Auth** | #162 | Frontend auth components | #159, #160, #161 | 3-4 days |
| **Auth** | #163 | Password reset flow | #159, #162, #181 | 1-2 days |
| **Marketplace** | #169 | Server detail page + publish | #167, #168 | 2 days |
| **Business** | #173 | Usage tracking + limits | #159, #172 | 1-2 days |
| **CI/CD** | #176 | GitHub Actions pipeline | #175 (soft) | 2-3 days |

```
Wave 4 Complete
      ↓
┌─────────────────────────────────────────────────────────────┐
│  WAVE 5                                                     │
│                                                             │
│  #162 (FE auth)  #163 (reset)  #169 (detail)  #173 (usage)  #176 (CI) │
│       ↓              ↓              ↓              ↓            ↓      │
└─────────────────────────────────────────────────────────────┘
```

---

### 🟣 WAVE 6: Guards + Production Prep (Days 12-18)
**Parallel Streams**: 3 | **Total Issues**: 3

Final integration:

| Stream | Issue | Title | Blocked By | Effort |
|--------|-------|-------|------------|--------|
| **Auth** | #164 | Enable auth guards | #162, #163 | 1 day |
| **Infra** | #178 | Kubernetes manifests | #150, #152 | 3-4 days |
| **Infra** | #179 | Monitoring (Prometheus) | #151, #152, #178 | 3-4 days |

```
Wave 5 Complete
      ↓
┌─────────────────────────────────────────────────────────────┐
│  WAVE 6                                                     │
│                                                             │
│  #164 (guards)      #178 (k8s)      #179 (monitoring)       │
│       ↓                  ↓               ↓                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Visual Dependency Graph

```
DAY 1-2         DAY 3-4         DAY 5-7         DAY 8-10        DAY 11-14       DAY 15-18
───────         ───────         ───────         ────────        ─────────       ─────────

#148 ──────────> #149 ──────────> #150 ──────────> #152 ──────────────────────> #178 ────> #179
(pgvector)      (migrations)    (dev env)       (health)                       (k8s)     (monitoring)
                    │                                                              ↑
                    │                                                              │
#147 ──────────> #151 ─────────────────────────────────────────────────────────────┘
(error DB)      (logging)

#154 ──────────> #155 ──────────> #156 ──────────> #157
(prompts)       (research)      (E2E test)      (MCP valid)
                                    │
                                    └──────────> #175 ──────────> #176
                                                (unit tests)    (CI/CD)

                #149 ──────────> #159 ──────────> #160 ──┐
                                (JWT auth)      (GitHub)  │
                                    │                     ├──> #162 ──> #163 ──> #164
                                    └──────────> #161 ──┘    (FE auth)  (reset)  (guards)
                                                (Google)         ↑
                                                                 │
#181 ────────────────────────────────────────────────────────────┘
(email)

#148 ──────────> #166 ──────────> #167 ──────────> #168 ──────────> #169
                (schema)        (API)           (FE)            (detail)

#171 ──────────────────────────> #172 ──────────────────────────> #173
(stripe config)                 (checkout)                       (usage)
                                    ↑
                                    │
                    #159 (auth) ────┘
```

---

## Quick Reference: Issue Dependencies

```
ZERO DEPENDENCIES (Start Immediately):
  #148, #147, #154, #171, #181

ONE DEPENDENCY:
  #149 ← #148
  #151 ← #147
  #155 ← #154 (soft)
  #166 ← #148
  #159 ← #149
  #160 ← #159
  #161 ← #159

TWO DEPENDENCIES:
  #150 ← #148, #149
  #156 ← #149, #150, #154, #155
  #167 ← #149, #166
  #152 ← #150

THREE+ DEPENDENCIES:
  #162 ← #159, #160, #161
  #163 ← #159, #162, #181
  #164 ← #162, #163
  #172 ← #149, #159, #171
  #173 ← #159, #172
  #179 ← #151, #152, #178
```

---

## Team Allocation Recommendation

### Option A: 2 Developers

| Developer | Focus Areas | Waves |
|-----------|-------------|-------|
| **Dev 1** | Infrastructure + Core | #148→#149→#150→#152→#156→#157→#175→#178→#179 |
| **Dev 2** | Auth + Business | #147→#151→#181→#159→#160→#161→#162→#164 + #171→#172→#173 |

### Option B: 3 Developers

| Developer | Focus Areas | Waves |
|-----------|-------------|-------|
| **Dev 1** | Infrastructure | #148→#149→#150→#152→#178→#179 |
| **Dev 2** | Core + Testing | #154→#155→#156→#157→#175→#176 |
| **Dev 3** | Auth + Business | #181→#159→#160→#161→#162→#163→#164 + #171→#172→#173 |

### Option C: 4+ Developers (Maximum Speed)

| Developer | Track | Issues |
|-----------|-------|--------|
| **Dev 1** | Infrastructure | #148→#149→#150→#152 |
| **Dev 2** | Core/Validation | #154→#155→#156→#157 |
| **Dev 3** | Auth Backend | #181→#159→#160→#161 |
| **Dev 4** | Auth Frontend | #162→#163→#164 (after Dev 3) |
| **Dev 5** | Marketplace | #166→#167→#168→#169 |
| **Dev 6** | Business | #171→#172→#173 |
| **Dev 7** | Testing/CI | #147→#151→#175→#176 |
| **Dev 8** | Production | #178→#179 |

---

## Sprint Breakdown (2-week sprints)

### Sprint 1 (Days 1-10): Foundation + Core
**Goals**: System running, first MCP server generated

| Wave | Issues | Team Focus |
|------|--------|------------|
| Wave 1 | #148, #147, #154, #171 | All hands on blockers |
| Wave 2 | #149, #151, #155, #166, #181 | Split by track |
| Wave 3 | #150, #156, #159, #167 | Parallel execution |

**Sprint 1 Exit Criteria**:
- [ ] Local dev environment works (`npm run dev:all`)
- [ ] First MCP server generated from GitHub URL
- [ ] JWT auth backend complete
- [ ] Marketplace API exists
- [ ] Email service configured

### Sprint 2 (Days 11-20): Auth + Integration
**Goals**: Users can login, marketplace connected

| Wave | Issues | Team Focus |
|------|--------|------------|
| Wave 4 | #152, #157, #160, #161, #168, #172, #175 | OAuth + Frontend |
| Wave 5 | #162, #163, #169, #173, #176 | Integration |

**Sprint 2 Exit Criteria**:
- [ ] OAuth login works (GitHub + Google)
- [ ] Frontend auth flow complete
- [ ] Password reset works
- [ ] Explore page shows real data
- [ ] CI/CD pipeline running

### Sprint 3 (Days 21-30): Production Ready
**Goals**: Ready for production deployment

| Wave | Issues | Team Focus |
|------|--------|------------|
| Wave 6 | #164, #178, #179 | Guards + K8s |
| Polish | Bug fixes, documentation | All hands |

**Sprint 3 Exit Criteria**:
- [ ] All routes protected
- [ ] K8s manifests deployable
- [ ] Monitoring dashboards live
- [ ] 80%+ test coverage on critical paths

---

## Bottleneck Analysis

### Critical Path (Longest Sequential Chain)
```
#148 → #149 → #159 → #160 → #162 → #163 → #164
(pgvector) (migrations) (JWT) (OAuth) (FE auth) (reset) (guards)

Total: ~14 days sequential
```

### Secondary Critical Path (Added)
```
#181 → #163 → #164
(email) (reset) (guards)

Email service must complete before password reset can work.
```

### Mitigation Strategies

1. **Start #159 (JWT) early**: Can begin design while #149 runs
2. **Parallel OAuth**: #160 and #161 can be done simultaneously
3. **Frontend prep**: #162 structure can be set up before OAuth complete
4. **Email early**: #181 has no dependencies, start in Wave 2
5. **Soft dependencies**: #155, #176 can start before blockers finish

---

## Backlog Issues (Address Opportunistically)

These pre-existing issues should be addressed when working on related code:

| Issue | Title | Best Time to Address |
|-------|-------|---------------------|
| #124 | Cloud hosting button bug | During #168 (Frontend Explore) |
| #144 | Improve generated packages | During #156 (E2E test) |
| #145 | Low ensemble consensus | During #157 (MCP validation) |

---

## Success Metrics by Wave

| Wave | Success Criteria |
|------|------------------|
| **Wave 1** | All 4 issues merged, no blockers |
| **Wave 2** | Database working, migrations run, email configured |
| **Wave 3** | `npm run dev:all` works, first MCP generated |
| **Wave 4** | OAuth works, API endpoints tested, checkout functional |
| **Wave 5** | User can login, see servers, subscribe, reset password |
| **Wave 6** | All routes protected, K8s ready, monitoring live |

---

## Changes from Original Plan (v2)

| Change | Reason |
|--------|--------|
| Added #181 (Email service) | Password reset (#163) cannot work without email |
| Moved #172 to Wave 4 | Had dependency on #159 which was in same wave |
| Added #149 dependency to #156, #167 | E2E tests and API need database running |
| Added #151 dependency to #179 | Monitoring needs logging infrastructure |
| Documented EPIC exclusion | EPICs are tracking issues, not work items |
| Addressed older issues | #41, #71 closed as superseded; #124, #144, #145 in backlog |

---

**Last Updated**: 2025-12-07 (v2 - Gap fixes applied)
**Total Duration**: 18-22 days with maximum parallelization
**Minimum Team Size**: 2 developers
**Optimal Team Size**: 4-5 developers
**Total Work Items**: 28 (excluding EPICs and backlog)
