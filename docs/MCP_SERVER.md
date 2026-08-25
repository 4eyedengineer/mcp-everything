# MCP Everything as an MCP Server

MCP Everything exposes itself as an MCP server, so an external agent (Claude,
or any other MCP client) can generate, inspect, and browse MCP servers on
behalf of an authenticated user - the same way the chat UI does.

## Spec revision implemented

**2026-07-28** (the current MCP specification as of this writing), specifically:

- **Stateless core**: no `initialize`/`initialized` handshake carried across
  requests, no `Mcp-Session-Id`. Every request is self-contained and can land
  on any server instance behind a plain load balancer.
- **Streamable HTTP transport**, stateless mode (`StreamableHTTPServerTransport`
  constructed with `sessionIdGenerator: undefined`), via `@modelcontextprotocol/sdk`
  `^1.30`.
- Deprecated capabilities (Roots, Sampling, Logging) and the legacy HTTP+SSE
  transport are **not** used here.
- GET and DELETE on `/mcp` return `405` with a JSON-RPC error body: the
  stateless core removed the session concept these methods used to
  operate on (resuming/terminating a session), so there is nothing for them
  to do. This matches the official SDK's own stateless example.

## Endpoint

```
POST   https://<host>/mcp   - JSON-RPC 2.0 requests (initialize, tools/list, tools/call, ...)
GET    https://<host>/mcp   - 405 (stateless transport has no session to resume)
DELETE https://<host>/mcp   - 405 (stateless transport has no session to terminate)
```

Locally: `http://localhost:3000/mcp`.

## Authentication

The endpoint is protected by the platform's existing global `JwtAuthGuard` -
it is **not** `@Public()`. The guard already accepts, ahead of a JWT bearer
token:

- `X-API-Key: mcpe_<48 hex chars>`, or
- `Authorization: Bearer mcpe_<48 hex chars>`

and resolves it to a user via `ApiKeyService.validateApiKey`. A JWT access
token also works through `Authorization: Bearer <jwt>`, but a **user API
key is the intended credential for agents** - it doesn't expire on the
platform's normal session lifetime and is scoped/revocable independently
(`GET/POST/DELETE /api/v1/api-keys`).

Missing or invalid credentials never reach the MCP handler: the guard
rejects the request with `401` before the controller runs.

Every tool call executes as the authenticated user - ownership checks and
tier quotas apply exactly as they do from the chat UI, because the tools
delegate to the same `GenerationPipeline` / `MarketplaceService` entry
points.

### Getting an API key

```bash
# 1. Register (if you don't have an account)
curl -sX POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"SecureP@ss123"}'
# -> { "accessToken": "...", ... }

# 2. Create an API key (Bearer <accessToken> from step 1)
curl -sX POST http://localhost:3000/api/v1/api-keys \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"claude-agent"}'
# -> { "apiKey": { "key": "mcpe_<48 hex>", ... } }  <- shown once, save it
```

## Client configuration

### Claude Code (`claude mcp add`)

```bash
claude mcp add --transport http mcp-everything https://<host>/mcp \
  --header "X-API-Key: mcpe_your_key_here"
```

### `.mcp.json` / claude.ai remote MCP connector

```json
{
  "mcpServers": {
    "mcp-everything": {
      "url": "https://<host>/mcp",
      "transport": "http",
      "headers": {
        "X-API-Key": "mcpe_your_key_here"
      }
    }
  }
}
```

## Tool catalog

All inputs are validated JSON Schema (derived from zod schemas); all tools
return MCP tool errors (`isError: true` with a text explanation) rather than
throwing, so a failure is always something the calling agent can read and
relay to its user.

| Tool | Input | Delegates to | Notes |
|---|---|---|---|
| `generate_mcp_server` | `{ description: string }` | `GenerationPipeline.execute` (new conversation) | **Consumes one unit of the caller's monthly generation quota and incurs real AI cost.** Agents should confirm with their user before calling it. Quota is enforced server-side regardless. Returns `conversationId` + either a clarifying question or the completed tool list. |
| `continue_generation` | `{ conversationId: string, message: string }` | `GenerationPipeline.execute` (resumed conversation) | Use to answer a clarifying question or otherwise continue a paused generation. |
| `get_generation_status` | `{ conversationId: string }` | Direct, ownership-scoped read of the `conversations` row | Reports `awaitingClarification`, `hasGeneratedServer`, and the last 5 messages. |
| `get_generated_server` | `{ conversationId: string }` | Direct read of `conversations.state.generatedCode` (falling back to the last assistant message's `metadata.generatedCode`) | Returns `mainFile`, `supportingFiles`, `packageJson`, `tsConfig`, `tests`, `documentation`, and the tool list. Reports "not ready" if generation hasn't produced code yet. |
| `list_conversations` | `{}` | Direct, user-scoped read of the `conversations` table | Most recent first. |
| `search_marketplace` | `{ query?: string }` | `MarketplaceService.search` | Public, published servers only. Free - no quota or AI cost. |

Ownership is enforced on every conversation-scoped tool: a `conversationId`
belonging to another user is reported as "not found," never leaked as
"forbidden."

## Live JSON-RPC exchange (smoke test)

Captured 2026-07-30 against the running dev server (`localhost:3000`), a
throwaway registered user, and a real `mcpe_...` API key created for it. Only
`tools/list` and the two read-only tools (`list_conversations`,
`search_marketplace`) were called - no generation was triggered, so no AI
cost was incurred. The throwaway user's API key was revoked and the account
deleted immediately after (`DELETE /api/v1/api-keys/:id` then
`DELETE /api/account`). The transport returns `text/event-stream` framing
(`event: message` / `data: <json>`) for each response, which is why every
reply below is prefixed that way.

**1. Unauthenticated request - rejected before reaching the MCP handler:**

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/mcp \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
401
```

**2. `initialize`:**

```
$ curl -s http://localhost:3000/mcp \
    -H "X-API-Key: mcpe_a9ab51b3...(redacted, revoked)" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.1"}}}'

event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"mcp-everything","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
```

**3. `tools/list`** (all six tools, full JSON Schema each - abbreviated here, first entry shown in full):

```
$ curl -s http://localhost:3000/mcp \
    -H "X-API-Key: mcpe_a9ab51b3...(redacted, revoked)" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

event: message
data: {"result":{"tools":[
  {"name":"generate_mcp_server","title":"Generate MCP Server",
   "description":"Starts generating a new MCP server from a natural-language description, using the same GenerationPipeline the chat UI drives (intent analysis, research, tool planning, clarification, and a Docker-sandboxed generate-test-refine loop). COST NOTE: this consumes one unit of the caller's monthly generation quota and incurs real AI inference cost (research + planning + up to 5 refinement iterations). Confirm with your user before calling this tool. Quota limits are enforced server-side regardless. If the pipeline needs more information it returns a clarifying question instead of code - reply to it with continue_generation.",
   "inputSchema":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"description":{"description":"What the generated MCP server should do, e.g. \"a server that wraps the Stripe API for read-only invoice and customer lookups\".","type":"string","minLength":3,"maxLength":4000}},"required":["description"]},
   "execution":{"taskSupport":"forbidden"}},
  {"name":"continue_generation", "title":"Continue Generation", "inputSchema":{"type":"object","properties":{"conversationId":{"type":"string","format":"uuid"},"message":{"type":"string","minLength":1,"maxLength":4000}},"required":["conversationId","message"]}, ...},
  {"name":"get_generation_status", "title":"Get Generation Status", "inputSchema":{"type":"object","properties":{"conversationId":{"type":"string","format":"uuid"}},"required":["conversationId"]}, ...},
  {"name":"get_generated_server", "title":"Get Generated Server", "inputSchema":{"type":"object","properties":{"conversationId":{"type":"string","format":"uuid"}},"required":["conversationId"]}, ...},
  {"name":"list_conversations", "title":"List Conversations", "inputSchema":{"type":"object","properties":{}}, ...},
  {"name":"search_marketplace", "title":"Search Marketplace", "inputSchema":{"type":"object","properties":{"query":{"type":"string","maxLength":200}}}, ...}
]},"jsonrpc":"2.0","id":2}
```

**4. `tools/call list_conversations`** (read-only, no cost):

```
$ curl -s http://localhost:3000/mcp \
    -H "X-API-Key: mcpe_a9ab51b3...(redacted, revoked)" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_conversations","arguments":{}}}'

event: message
data: {"result":{"content":[{"type":"text","text":"{\n  \"conversations\": []\n}"}]},"jsonrpc":"2.0","id":3}
```

**5. `tools/call search_marketplace`** (read-only, no cost):

```
$ curl -s http://localhost:3000/mcp \
    -H "X-API-Key: mcpe_a9ab51b3...(redacted, revoked)" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_marketplace","arguments":{"query":"stripe"}}}'

event: message
data: {"result":{"content":[{"type":"text","text":"{\n  \"items\": [],\n  \"total\": 0,\n  \"page\": 1,\n  \"limit\": 20,\n  \"totalPages\": 0,\n  \"hasNext\": false,\n  \"hasPrevious\": false\n}"}]},"jsonrpc":"2.0","id":4}
```

**6. `GET`/`DELETE` on the stateless endpoint** - both `405` with a JSON-RPC error, matching the SDK's own stateless example:

```
$ curl -s -i http://localhost:3000/mcp -H "X-API-Key: mcpe_a9ab51b3...(redacted, revoked)" -X GET | tail -1
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed: this MCP server is stateless (spec 2026-07-28) - there is no session to resume via GET."},"id":null}

$ curl -s -i http://localhost:3000/mcp -H "X-API-Key: mcpe_a9ab51b3...(redacted, revoked)" -X DELETE | tail -1
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed: this MCP server is stateless (spec 2026-07-28) - there is no session to terminate via DELETE."},"id":null}
```

**7. Ownership scoping - a bogus/unowned `conversationId` is a clean tool error, never a 500:**

```
$ curl -s http://localhost:3000/mcp \
    -H "X-API-Key: mcpe_a9ab51b3...(redacted, revoked)" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_generation_status","arguments":{"conversationId":"00000000-0000-0000-0000-000000000000"}}}'

event: message
data: {"result":{"content":[{"type":"text","text":"Conversation not found: 00000000-0000-0000-0000-000000000000"}],"isError":true},"jsonrpc":"2.0","id":5}
```
