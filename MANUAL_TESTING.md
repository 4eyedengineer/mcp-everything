# MCP Everything - Manual Testing Guide

This document provides a comprehensive guide for manually testing the MCP Everything platform. It covers infrastructure, backend, frontend, integration, core features, advanced features, and end-to-end user journeys.

## Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Testing Sessions Overview](#testing-sessions-overview)
- [Bug Tracking](#bug-tracking)
- [Session 1: Infrastructure & Backend](#session-1-infrastructure--backend)
- [Session 2: Frontend & Integration](#session-2-frontend--integration)
- [Session 3: Core Features (Chat, AI, Generation)](#session-3-core-features)
- [Session 4: Advanced Features (Deployments & History)](#session-4-advanced-features)
- [Session 5: Full E2E User Journeys](#session-5-full-e2e-user-journeys)
- [Success Criteria](#success-criteria)
- [Quick Command Reference](#quick-command-reference)

---

## Quick Start

### What You'll Need

- Terminal access
- Modern browser (Chrome/Firefox recommended)
- ~4-6 hours total time (can be split across sessions)
- GitHub access for deployment tests
- Valid API keys (Anthropic, optionally GitHub)

### Before You Begin

1. Clone the repo: `git clone https://github.com/4eyedengineer/mcp-everything.git`
2. Have Docker installed and running
3. Have your `.env` file configured in `packages/backend/`

---

## Prerequisites

### Required Software

```bash
# Check Node.js version (need 18+ or 20+)
node --version

# Check npm version (need 9+)
npm --version

# Check Docker is running
docker --version
docker ps
```

### Environment Variables

Required variables in `packages/backend/.env`:

- `DATABASE_URL` or individual DB vars (host, port, user, pass, db)
- `ANTHROPIC_API_KEY` (get from Anthropic console if missing)
- `GITHUB_TOKEN` (optional but needed for GitHub features)

---

## Testing Sessions Overview

Work through these in order. Each session builds on the previous one.

| Session | Focus | Estimated Time | Layer |
|---------|-------|----------------|-------|
| 1 | Infrastructure & Backend | 30-60 min | Layers 1-2 |
| 2 | Frontend & Integration | 30-60 min | Layers 3-4 |
| 3 | Chat, AI, MCP Generation | 60-120 min | Layer 5 |
| 4 | Deployments + History | 60-120 min | Layer 6 |
| 5 | Full E2E User Journeys | 60-120 min | Layer 7 |

### Layer Reference

| Layer | What It Tests |
|-------|---------------|
| 1 | Infrastructure (Node, Docker, DB) |
| 2 | Backend Standalone |
| 3 | Frontend Standalone |
| 4 | Frontend-Backend Integration |
| 5 | Core Features (Chat, AI, Generation) |
| 6 | Advanced Features (Deploy, History) |
| 7 | End-to-End User Journeys |

---

## Bug Tracking

### Bug Template

```markdown
## [Layer X] Brief Description
**Session**: [1-5]
**Severity**: critical/major/minor
**Steps to Reproduce**:
1. ...
2. ...
**Expected**:
**Actual**:
**Error Message**:
```

### Severity Guide

- **Critical**: Application won't start, core feature completely broken
- **Major**: Feature doesn't work but app runs
- **Minor**: Works but has issues (UX, performance, edge cases)

---

## Session 1: Infrastructure & Backend

**Goal**: Get the backend running and verify all services start correctly.

### Step 1.1: Check Prerequisites (5 min)

```bash
# Check Node.js version (need 18+ or 20+)
node --version

# Check npm version (need 9+)
npm --version

# Check Docker is running
docker --version
docker ps
```

**Checkpoint:**

- [ ] Node.js 18+
- [ ] npm 9+
- [ ] Docker running

### Step 1.2: Install Dependencies (5-10 min)

```bash
cd /path/to/mcp-everything
npm install
```

**Checkpoint:**

- [ ] No errors during install
- [ ] node_modules created

**If failed:** Try `rm -rf node_modules && npm install`

### Step 1.3: Start PostgreSQL (5 min)

```bash
# Option A: Docker Compose (if docker-compose.yml exists)
docker compose up -d postgres

# Option B: Direct Docker
docker run -d --name mcp-postgres \
  -e POSTGRES_USER=mcp \
  -e POSTGRES_PASSWORD=mcp \
  -e POSTGRES_DB=mcp_everything \
  -p 5432:5432 \
  postgres:15

# Verify it's running
docker ps | grep postgres
```

**Checkpoint:**

- [ ] Container shows "Up" status

**If failed:** Check if port 5432 is in use: `lsof -i :5432`

### Step 1.4: Verify Database Connection (2 min)

```bash
# Test connection (password: mcp)
docker exec mcp-postgres psql -U mcp -d mcp_everything -c "SELECT 1"
```

**Checkpoint:**

- [ ] Returns "1" without errors

### Step 1.5: Check Environment Variables (5 min)

```bash
# Check if .env exists
cat packages/backend/.env

# If not, create from example
cp packages/backend/.env.example packages/backend/.env
```

**Required variables:**

- [ ] `DATABASE_URL` or individual DB vars
- [ ] `ANTHROPIC_API_KEY`
- [ ] `GITHUB_TOKEN` (optional)

### Step 1.6: Build Backend (5-10 min)

```bash
cd packages/backend
npm run build
```

**Checkpoint:**

- [ ] No TypeScript errors
- [ ] `dist/` folder created

### Step 1.7: Run Database Migrations (5 min)

```bash
# Still in packages/backend
npm run migration:run
```

**Checkpoint:**

- [ ] Tables created successfully
- [ ] No migration errors

### Step 1.8: Start Backend Server (5 min)

```bash
# Still in packages/backend
npm run start:dev
```

**Watch the console for:**

- [ ] "Nest application successfully started"
- [ ] Listening on port 3000
- [ ] No red error messages
- [ ] No unhandled promise rejections

**Keep this terminal running!**

### Step 1.9: Test Health Endpoints (5 min)

**Open a NEW terminal** and run:

```bash
# General health
curl http://localhost:3000/api/health
echo ""

# Chat health
curl http://localhost:3000/api/chat/health
echo ""

# Test SSE endpoint exists
curl -m 5 http://localhost:3000/api/chat/stream/test-session
echo ""

# Test conversations API
curl http://localhost:3000/api/conversations
echo ""
```

**Checkpoint:**

- [ ] `/api/health` returns JSON with status
- [ ] `/api/chat/health` returns JSON
- [ ] `/api/chat/stream/test-session` connects (or times out gracefully)
- [ ] `/api/conversations` returns `[]` or JSON

### Session 1 Complete Checklist

- [ ] Node/npm versions correct
- [ ] Docker running
- [ ] Dependencies installed
- [ ] PostgreSQL running
- [ ] Database connection works
- [ ] Environment variables set
- [ ] Backend builds
- [ ] Migrations run
- [ ] Backend starts without errors
- [ ] Health endpoints respond

---

## Session 2: Frontend & Integration

**Goal**: Get the frontend running and verify it communicates with the backend.

**Prerequisites**: Session 1 complete (backend running on port 3000)

### Part A: Frontend Standalone (Layer 3)

#### Step 2.1: Build Frontend

```bash
cd packages/frontend
npm run build
```

**Record results:**

- [ ] Build succeeded
- [ ] Build time: _____ seconds
- [ ] Any warnings? List them:

#### Step 2.2: Start Dev Server

```bash
npm run start
# Wait for "Compiled successfully"
```

**Record results:**

- [ ] Server started on port 4200
- [ ] Compilation successful
- [ ] Any warnings?

#### Step 2.3: Open Browser

1. Open http://localhost:4200
2. Open DevTools (F12)
3. Check Console tab

**Record results:**

- [ ] Page loads (not blank)
- [ ] Redirects to /chat
- [ ] Console errors? List them:

#### Step 2.4: Visual Inspection

On /chat page, verify:

- [ ] Welcome screen or chat interface visible
- [ ] Message input field visible
- [ ] Send button visible and styled
- [ ] Sidebar toggle button visible
- [ ] No broken layout/overlapping elements

#### Step 2.5: Navigation Test

- [ ] Click sidebar toggle → sidebar opens/closes
- [ ] Navigate to /explore → page loads
- [ ] Navigate to /account → page loads
- [ ] Navigate back to /chat → page loads
- [ ] Browser back/forward buttons work

#### Step 2.6: Network Tab Check

DevTools → Network tab:

- [ ] main.js loads (200 status)
- [ ] styles.css loads
- [ ] No 404 errors for assets

### Part B: Frontend-Backend Integration (Layer 4)

#### Step 2.7: Verify Both Running

```bash
# Terminal 1 should have backend running
# Terminal 2 should have frontend running
# Verify:
curl http://localhost:3000/api/health  # Backend
curl http://localhost:4200             # Frontend
```

#### Step 2.8: Test API Proxy

```bash
curl http://localhost:4200/api/health
```

**Expected:** Same response as direct backend call

- [ ] Proxy works
- [ ] No CORS errors

#### Step 2.9: Check SSE Connection

1. Open http://localhost:4200/chat in browser
2. DevTools → Network tab
3. Filter by "EventStream" or look for `/api/chat/stream/`

- [ ] SSE connection visible
- [ ] Connection status (pending = connected)
- [ ] No immediate errors

#### Step 2.10: Check Session ID

1. DevTools → Application tab
2. Local Storage → localhost:4200

- [ ] `mcp-session-id` key exists
- [ ] Value is UUID format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)

#### Step 2.11: Backend Log Check

In backend terminal, verify:

- [ ] Requests appearing when frontend loads
- [ ] No errors related to frontend requests
- [ ] SSE connection logged

#### Step 2.12: Error Handling Test

```bash
# Stop backend (Ctrl+C in backend terminal)
```

1. Refresh frontend page
2. Try to send a message

- [ ] Frontend shows error state (not crash)
- [ ] Error message is user-friendly
- [ ] No infinite loops in console

**Restart backend after this test**

### Session 2 Completion Summary

#### Layer 3 Summary

- [ ] Frontend builds
- [ ] Dev server runs
- [ ] Page loads in browser
- [ ] No console errors on load
- [ ] Navigation works
- [ ] UI renders correctly

#### Layer 4 Summary

- [ ] API proxy works
- [ ] SSE connection establishes
- [ ] Session ID generated
- [ ] No CORS errors
- [ ] Error states handled

---

## Session 3: Core Features

**Goal**: Test the CORE functionality: sending messages, receiving AI responses, and generating MCP servers.

**Prerequisites**: Session 2 complete, backend running with valid ANTHROPIC_API_KEY

**IMPORTANT NOTES:**

- These tests use REAL Claude API calls (costs money)
- Each generation can take 2-5 minutes
- Monitor backend logs carefully for errors

### Test 3.1: Send Simple Message

**Steps:**

1. Type "Hello" in chat input
2. Click Send button

**Record Results:**

- [ ] User message appears in chat
- [ ] Loading state shows (hourglass or spinner)
- [ ] Backend log shows message received
- [ ] No immediate errors
- Time to first response: _____ seconds

### Test 3.2: Receive AI Response

**Steps:**

1. Send "What can you help me with?"
2. Wait for response (up to 60 seconds)

**Record Results:**

- [ ] Progress message appears (streaming indicator)
- [ ] Progress message has spinning icon
- [ ] Assistant response appears
- [ ] Loading state clears
- [ ] Response is relevant/coherent
- Response time: _____ seconds

### Test 3.3: Help Intent

**Steps:**

1. Send "help"

**Record Results:**

- [ ] Response appears quickly (< 10s)
- [ ] Response explains capabilities
- [ ] No error messages
- Response time: _____ seconds

### Test 3.4: GitHub URL Generation (CRITICAL)

**Steps:**

1. Send: `Create MCP server for https://github.com/sindresorhus/is`
2. Watch progress phases carefully
3. Wait for completion (up to 5 minutes)

**Progress Phases to Track:**

| Phase | Appeared? | Time Started | Time Completed |
|-------|-----------|--------------|----------------|
| Intent analysis | [ ] | ___:___ | ___:___ |
| Research | [ ] | ___:___ | ___:___ |
| Ensemble | [ ] | ___:___ | ___:___ |
| Refinement | [ ] | ___:___ | ___:___ |

**Final Result:**

- [ ] Download button appears
- [ ] Assistant message with summary appears
- [ ] No error messages
- Total generation time: _____ minutes

### Test 3.5: Download Generated Code

**Steps:**

1. After Test 3.4, click Download button
2. Save file
3. Inspect contents

**Verify File:**

```bash
# After downloading, check the file:
cat ~/Downloads/mcp-server-*.json | jq .
```

- [ ] File downloads
- [ ] File has content (not empty)
- [ ] File is valid JSON
- [ ] Contains `files` array
- [ ] Has `package.json` in files
- [ ] Has `src/index.ts` or main file
- File size: _____ KB
- Number of files in archive: _____

### Test 3.6: Service Name Input

**Steps:**

1. Start new conversation (if possible) or continue
2. Send: `Create MCP server for Stripe API`

**Record Results:**

- [ ] Intent detected as generation request
- [ ] Research phase occurs
- [ ] Either generation proceeds OR clarification asked
- Outcome: Generation / Clarification / Error
- Time taken: _____ minutes

### Test 3.7: Natural Language Input

**Steps:**

1. Send: `I want an MCP server that converts temperatures between Celsius and Fahrenheit`

**Record Results:**

- [ ] Intent detected correctly
- [ ] AI understands the tools needed
- [ ] Either generates or asks clarifying questions
- [ ] Response is relevant
- Outcome: Generation / Clarification / Error

### Test 3.8: Clarification Flow

**Steps:**

1. Send: `Create an MCP server`
2. Wait for AI to ask for clarification
3. Reply: `For managing a TODO list with add, complete, and delete tasks`

**Record Results:**

- [ ] First message triggers clarification request
- [ ] AI asks relevant questions
- [ ] Second message provides enough info
- [ ] Generation proceeds OR more specific questions asked

### Test 3.9: Conversation Context

**Steps:**

1. After any completed generation
2. Send: `What tools does this server have?`

**Record Results:**

- [ ] AI remembers previous context
- [ ] Response relates to the generated server
- [ ] No "I don't know what you mean" errors

### Test 3.10: Backend Log Analysis

Throughout all tests, watch backend terminal for:

- [ ] No unhandled exceptions
- [ ] No `undefined` or `null` errors
- [ ] No timeout errors
- [ ] Graph nodes executing in expected order
- [ ] Claude API calls succeeding

### Session 3 Critical Results

- [ ] Messages send and display correctly
- [ ] AI responses stream via SSE
- [ ] At least ONE full generation completes
- [ ] Download produces valid code
- [ ] Clarification flow works

### Performance Metrics

| Metric | Value |
|--------|-------|
| Simple message response | ___s |
| Help response | ___s |
| Full generation | ___min |

---

## Session 4: Advanced Features

**Goal**: Test advanced features: conversation persistence, multiple conversations, and deployment options.

**Prerequisites**: Session 3 complete, at least one successful generation

### Test 4.1: Conversation History Persistence

**Steps:**

1. Note current conversation ID from URL
2. Note the messages visible
3. Refresh the page (F5)

**Record Results:**

- [ ] Conversation ID preserved in URL
- [ ] Previous messages visible after refresh
- [ ] Can continue the conversation
- [ ] Generated code still accessible (download button)
- Conversation ID: _______________________

### Test 4.2: Create New Conversation

**Steps:**

1. Click "New Chat" in sidebar (or equivalent)

**Record Results:**

- [ ] URL changes (new conversation ID or /chat)
- [ ] Chat area clears
- [ ] Welcome screen shows (or empty chat)
- [ ] Previous conversation still visible in sidebar

### Test 4.3: Switch Between Conversations

**Steps:**

1. Have at least 2 conversations
2. Click on older conversation in sidebar
3. Click on newer conversation

**Record Results:**

- [ ] Correct messages load for each
- [ ] URL updates correctly
- [ ] No message mixing between conversations
- [ ] Smooth transitions

### Test 4.4: Conversation List in Sidebar

**Verify:**

- [ ] Conversations appear in sidebar
- [ ] Most recent first
- [ ] Titles are meaningful (or truncated message)
- [ ] Timestamps or date shown
- [ ] Empty state shown if no conversations

### Test 4.5: Deploy to GitHub Repository

**Prerequisites:**

```bash
# Verify GitHub token
echo $GITHUB_TOKEN | head -c 10
# Should show: ghp_XXXXXX or similar
```

**Steps:**

1. Have a completed generation with download button visible
2. Click "Deploy as Repo" button
3. Watch progress

**Record Results:**

- [ ] Button is clickable
- [ ] Loading/progress indicator shows
- [ ] Repository created on GitHub
- [ ] Files pushed to repository
- [ ] Success message with repo link appears
- Repository URL: _______________________

**Verify Repository:**

```bash
# Clone and verify
git clone [REPO_URL] /tmp/test-mcp-repo
ls /tmp/test-mcp-repo
```

- [ ] Link opens correct GitHub repo
- [ ] Repo contains expected files:
  - [ ] package.json
  - [ ] src/index.ts
  - [ ] README.md

### Test 4.6: Deploy to Gist

**Steps:**

1. Have a completed generation
2. Click "Deploy as Gist" button (if available)

**Record Results:**

- [ ] Button is clickable
- [ ] Loading indicator shows
- [ ] Gist created on GitHub
- [ ] Success message with gist link
- [ ] Link opens correct gist
- [ ] Gist contains code files
- Gist URL: _______________________

### Test 4.7: Host on Cloud (KinD)

**Prerequisites:**

```bash
# Check cluster
kubectl cluster-info --context kind-mcp-local

# Check registry
docker ps | grep kind-registry

# If not running, set up:
./scripts/kind/setup.sh
```

**Steps:**

1. Have a completed generation
2. Click "Host on Cloud" button
3. Watch deployment progress

**Record Results:**

- [ ] Deploy modal or progress appears
- [ ] Building status shows
- [ ] Pushing status shows
- [ ] Deploying status shows
- [ ] Success message appears
- [ ] Server endpoint URL provided
- Server ID: _______________________
- Endpoint URL: _______________________

### Test 4.8: Verify Hosted Server

**Steps:**

```bash
# Get the server ID from UI, then:
SERVER_ID="[paste-server-id-here]"
curl -H "Host: ${SERVER_ID}.mcp.localhost" http://127.0.0.1/health
```

**Record Results:**

- [ ] Health endpoint responds
- [ ] Returns 200 status
- Response body: _______________________

**Check Pod Status:**

```bash
kubectl get pods -n mcp-servers
kubectl logs -n mcp-servers -l app=${SERVER_ID}
```

- [ ] Pod is running
- [ ] No crash loops
- [ ] Logs show healthy startup

### Test 4.9: Server Management Page

**Steps:**

Navigate to /servers (if this page exists)

**Record Results:**

- [ ] Page loads
- [ ] Deployed servers listed
- [ ] Server status shown (running/stopped)
- [ ] Can view server details
- [ ] Can stop server
- [ ] Can start server
- [ ] Can delete server

### Test 4.10: Conversation Deletion

**Steps (if delete option exists):**

1. Find delete button/option for a conversation
2. Delete a test conversation
3. Try to navigate to deleted conversation

**Record Results:**

- [ ] Can delete a conversation
- [ ] Conversation removed from sidebar
- [ ] Cannot navigate to deleted conversation (404 or redirect)

### Session 4 Completion Summary

#### History & Conversations

- [ ] Conversation history persists across refresh
- [ ] Multiple conversations work independently
- [ ] Switching between conversations works

#### Deployment Methods

| Method | Tested | Status |
|--------|--------|--------|
| GitHub Repo | [ ] | Working / Broken / N/A |
| GitHub Gist | [ ] | Working / Broken / N/A |
| KinD Hosting | [ ] | Working / Broken / N/A |

#### Hosted Server

- [ ] Server accessible after KinD deployment
- [ ] Health endpoint responds

---

## Session 5: Full E2E User Journeys

**Goal**: Complete end-to-end user journeys that test the entire system from fresh state to deployed MCP server.

**Prerequisites**: All previous sessions complete (Layers 1-6 passing)

### Journey 1: GitHub URL → Hosted Server

**Goal**: Complete user journey from nothing to a running MCP server in the cloud.

#### 5.1.1 Fresh Start

```bash
# Clear browser localStorage (or use incognito)
```

- [ ] localStorage cleared

#### 5.1.2 Navigate

1. Open http://localhost:4200
2. Should redirect to /chat

- [ ] Navigation works
- [ ] Welcome screen visible

#### 5.1.3 Send Generation Request

Type and send:

```
Create an MCP server for https://github.com/sindresorhus/is
```

- [ ] Message sent successfully

#### 5.1.4 Track Progress Phases

| Phase | Visible? | Duration |
|-------|----------|----------|
| Intent analysis | [ ] | ___s |
| Research | [ ] | ___s |
| Ensemble | [ ] | ___s |
| Refinement | [ ] | ___s |

#### 5.1.5 Generation Complete

- [ ] Generation completes
- [ ] Download button visible
- Total time: _____ min

#### 5.1.6 Deploy to Cloud

1. Click "Host on Cloud"
2. Watch deployment progress

- [ ] Deploy button clicked
- [ ] Building status shows
- [ ] Deployment completes
- Total deploy time: _____ min

#### 5.1.7 Get Endpoint

- [ ] Endpoint URL received
- Server ID: _______________________

#### 5.1.8 Test Server Health

```bash
SERVER_ID="[paste-id]"
curl -H "Host: ${SERVER_ID}.mcp.localhost" http://127.0.0.1/health
```

- [ ] Server responds
- Response: _______________________

**Journey 1 Result:** [ ] PASS / [ ] FAIL

---

### Journey 2: Natural Language → GitHub Repo

**Goal**: Create MCP server from natural language description and deploy to GitHub.

#### 5.2.1 Start New Conversation

1. Click "New Chat" or equivalent

- [ ] New conversation started

#### 5.2.2 Send Vague Request

Type and send:

```
I want to create an MCP server
```

- [ ] Message sent
- [ ] AI asks clarification

#### 5.2.3 Provide Details

Reply:

```
A calculator with add, subtract, multiply, divide tools
```

- [ ] Clarification provided
- [ ] Generation proceeds

#### 5.2.4 Wait for Generation

- [ ] Generation completes
- Total time: _____ min

#### 5.2.5 Deploy as Repo

1. Click "Deploy as Repo"
2. Wait for completion

- [ ] Deploy clicked
- [ ] Repo created
- Time: _____ sec

#### 5.2.6 Verify Repository

**Repo URL:** _______________________

```bash
# Clone and verify
git clone [REPO_URL] /tmp/journey2-repo
ls /tmp/journey2-repo
```

- [ ] package.json exists
- [ ] src/index.ts exists
- [ ] README.md exists

**Journey 2 Result:** [ ] PASS / [ ] FAIL

---

### Journey 3: Error Recovery

**Goal**: Verify the system handles errors gracefully and recovers.

#### 5.3.1 Send Invalid Request

Type and send:

```
Create MCP for https://github.com/nonexistent-12345/fake-repo-67890
```

- [ ] Invalid URL sent

#### 5.3.2 Verify Error Handling

- [ ] Error message appears (not crash)
- [ ] UI remains functional
- [ ] Can still type in input

**Error message displayed:**

#### 5.3.3 Recover with Valid Request

Type and send:

```
Create MCP server for https://github.com/sindresorhus/is
```

- [ ] Valid request sent
- [ ] Generation proceeds normally
- [ ] Generation succeeds

**Journey 3 Result:** [ ] PASS / [ ] FAIL

---

### Journey 4: Multi-Conversation Flow

**Goal**: Verify multiple concurrent conversations work correctly.

#### 5.4.1 Start Conversation A

1. Send: `Create an MCP server for Stripe API`
2. Wait for clarification or initial progress

- [ ] Conversation A started

#### 5.4.2 Start Conversation B (while A pending)

1. Click "New Chat"
2. Send: `Create an MCP server for https://github.com/sindresorhus/is`

- [ ] Conversation B started while A pending

#### 5.4.3 Wait for B to Complete

- [ ] B completes successfully

#### 5.4.4 Switch Back to A

1. Click on Conversation A in sidebar

- [ ] Can switch back to A
- [ ] A context preserved (previous messages visible)

#### 5.4.5 Complete A

1. Continue conversation A to completion (answer clarifications)

- [ ] A completes successfully

#### 5.4.6 Verify Both Accessible

- [ ] Both conversations visible in sidebar
- [ ] Can switch between them
- [ ] No data corruption

**Journey 4 Result:** [ ] PASS / [ ] FAIL

---

### Performance Baseline

Record actual timings from all journeys:

| Metric | Journey 1 | Journey 2 | Journey 3 |
|--------|-----------|-----------|-----------|
| First response | ___s | ___s | ___s |
| Intent phase | ___s | ___s | ___s |
| Research phase | ___s | ___s | ___s |
| Ensemble phase | ___s | ___s | ___s |
| Refinement phase | ___s | ___s | ___s |
| Total generation | ___min | ___min | ___min |
| Deployment | ___min | ___min | N/A |

**Acceptable Ranges:**

- First response: < 10s
- Total generation: < 5 min
- Deployment: < 2 min

### Session 5 Completion Summary

#### Journey Results

| Journey | Status |
|---------|--------|
| 1: GitHub URL → Hosted | [ ] PASS / [ ] FAIL |
| 2: Natural Language → Repo | [ ] PASS / [ ] FAIL |
| 3: Error Recovery | [ ] PASS / [ ] FAIL |
| 4: Multi-Conversation | [ ] PASS / [ ] FAIL |

#### MVP Pass Criteria

**Minimum for MVP (must all pass):**

- [ ] At least ONE complete journey succeeds end-to-end
- [ ] Error recovery works (Journey 3)
- [ ] No data loss or corruption

**Full Success:**

- [ ] All 4 journeys complete
- [ ] Performance within acceptable ranges
- [ ] No critical bugs discovered

---

## Success Criteria

### Minimum Viable (Must Pass)

- [ ] Backend starts and responds to health checks
- [ ] Frontend builds and loads in browser
- [ ] Can send a message and receive AI response
- [ ] At least ONE MCP server generates successfully
- [ ] Download of generated code works

### Full Success

- [ ] All 7 layers pass
- [ ] All 4 user journeys complete (Session 5)
- [ ] At least one deployment method works
- [ ] No critical bugs remaining

---

## Quick Command Reference

### Start Services

```bash
# Start PostgreSQL
docker compose up -d postgres
# OR
docker run -d --name mcp-postgres \
  -e POSTGRES_USER=mcp \
  -e POSTGRES_PASSWORD=mcp \
  -e POSTGRES_DB=mcp_everything \
  -p 5432:5432 \
  postgres:15

# Start Backend
cd packages/backend && npm run start:dev

# Start Frontend
cd packages/frontend && npm run start
```

### Stop Services

```bash
# Stop PostgreSQL
docker stop mcp-postgres

# Stop Backend/Frontend
# Ctrl+C in the terminal running the service
```

### Database Commands

```bash
# Connect to database
docker exec -it mcp-postgres psql -U mcp -d mcp_everything

# Run migrations
cd packages/backend && npm run migration:run

# Reset database (careful!)
cd packages/backend && npm run migration:revert
```

### Debugging

```bash
# View backend logs (in dev mode, logs appear in terminal)

# Check Docker containers
docker ps
docker logs mcp-postgres

# Check KinD cluster (if using)
kubectl get pods -A
kubectl logs -n mcp-servers <pod-name>
```

### Health Checks

```bash
# Backend health
curl http://localhost:3000/api/health

# Chat health
curl http://localhost:3000/api/chat/health

# Frontend (dev server)
curl http://localhost:4200
```

---

## Troubleshooting

### Backend Won't Start

1. Check PostgreSQL is running: `docker ps | grep postgres`
2. Verify `.env` has all required variables
3. Check port 3000 isn't in use: `lsof -i :3000`
4. Review build output for TypeScript errors

### Frontend Won't Build

1. Delete `node_modules` and reinstall: `rm -rf node_modules && npm install`
2. Clear Angular cache: `rm -rf .angular`
3. Check for TypeScript errors in the build output

### SSE Connection Fails

1. Verify backend is running on port 3000
2. Check proxy configuration in `packages/frontend/proxy.conf.json`
3. Look for CORS errors in browser console
4. Verify session ID is in localStorage

### GitHub Deployment Fails

1. Verify `GITHUB_TOKEN` is set and has `repo` scope
2. Check token hasn't expired
3. Review rate limits: `gh api rate_limit`

### KinD Deployment Fails

1. Check cluster is running: `kubectl cluster-info --context kind-mcp-local`
2. Verify registry: `docker ps | grep kind-registry`
3. Check pod status: `kubectl get pods -n mcp-servers`
4. Review pod logs: `kubectl logs -n mcp-servers <pod-name>`

---

## Related Documentation

- [DEVELOPMENT.md](./DEVELOPMENT.md) - Development setup guide
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Production deployment
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical architecture
- [TESTING_SYSTEM.md](./TESTING_SYSTEM.md) - Automated testing system
- [packages/frontend/e2e/README.md](./packages/frontend/e2e/README.md) - E2E test documentation

---

**Last Updated:** December 2025
