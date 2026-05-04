# Server SDK Support for Scope Challenges (Step-Up Auth)

**Author:** Sam Morrow  
**Date:** 2026-03-04  
**Status:** Spike Proposal — for discussion with SDK devs and Tool Scopes Working Group  
**Relates to:** [TS SDK #1151](https://github.com/modelcontextprotocol/typescript-sdk/issues/1151), [TS SDK #1294](https://github.com/modelcontextprotocol/typescript-sdk/issues/1294), [MCP Spec §10.1 Scope Challenge Handling](https://modelcontextprotocol.io/specification/draft/basic/authorization#scope-challenge-handling)

---

## 1. Problem Statement

Server SDK authors have **no ergonomic way to trigger OAuth scope challenges** during tool execution. The MCP spec ([SEP-835](https://modelcontextprotocol.io/specification/draft/basic/authorization#scope-challenge-handling)) fully defines how servers should return HTTP 403 with `WWW-Authenticate` headers when a client's token lacks required scopes, and how clients should perform step-up authorization. But today:

- **Client-side handling is implemented** — the TypeScript SDK already handles 403 `insufficient_scope` responses, extracts scopes from `WWW-Authenticate`, performs re-authorization, and retries the request (with infinite-loop prevention).
- **Server-side SDK support is missing** — there is no way to declare required scopes per tool, no way for tool handlers to trigger scope challenges, and no mechanism to convert a tool handler error into an HTTP 403 response.
- **github/github-mcp-server works around this** by implementing scope challenges entirely in custom HTTP middleware and a bespoke inventory/scopes system *outside* any SDK, parsing raw JSON-RPC to extract tool names and match them against a scope map.

## 2. Current State of the Art

### 2.1 What the Spec Says (§10.1)

When a client makes a request with an access token with insufficient scope:
- Server responds with **HTTP 403 Forbidden**
- `WWW-Authenticate: Bearer error="insufficient_scope", scope="required_scope1 required_scope2", resource_metadata="https://.../.well-known/oauth-protected-resource"`
- Client parses the challenge, re-authorizes with the new scope set, and retries

### 2.2 Client-Side (TypeScript SDK) — ✅ Already Implemented

`packages/client/src/client/streamableHttp.ts` (lines 525-572):
```typescript
if (response.status === 403 && this._authProvider) {
    const { resourceMetadataUrl, scope, error } = extractWWWAuthenticateParams(response);
    if (error === 'insufficient_scope') {
        // Prevent infinite loops
        if (this._lastUpscopingHeader === wwwAuthHeader) {
            throw new SdkError(SdkErrorCode.ClientHttpForbidden,
              'Server returned 403 after trying upscoping', ...);
        }
        this._scope = scope;
        this._resourceMetadataUrl = resourceMetadataUrl;
        this._lastUpscopingHeader = wwwAuthHeader;
        const result = await auth(this._authProvider,
          { serverUrl, resourceMetadataUrl, scope, ... });
        if (result !== 'AUTHORIZED') throw new UnauthorizedError();
        return this.send(message); // Retry
    }
}
```

Open issues: [#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582) (scope overwrite during progressive auth), [#1618](https://github.com/modelcontextprotocol/typescript-sdk/pull/1618) (fix: accumulate scopes across challenges).

### 2.3 Server-Side (github/github-mcp-server) — Custom Workaround via HTTP Middleware

The GitHub MCP Server implements scope challenges entirely in custom application-level HTTP middleware and a bespoke inventory/scopes package — none of this is part of the Go SDK (`github.com/modelcontextprotocol/go-sdk`). The Go SDK itself has no scope challenge support. File: `pkg/http/middleware/scope_challenge.go`:

```go
func WithScopeChallenge(oauthCfg *oauth.Config,
    scopeFetcher scopes.FetcherInterface) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        fn := func(w http.ResponseWriter, r *http.Request) {
            // 1. Parse JSON-RPC body to extract tool name
            // 2. Look up tool's RequiredScopes/AcceptedScopes from global scope map
            // 3. Fetch user's active scopes from GitHub API
            // 4. If user lacks required scopes → return HTTP 403 + WWW-Authenticate
            // 5. Otherwise → next.ServeHTTP(w, r)
        }
        return http.HandlerFunc(fn)
    }
}
```

Tools declare scopes at registration time via `RequiredScopes` / `AcceptedScopes` on the github-mcp-server's custom `ServerTool` struct (not part of the Go SDK):

```go
func NewTool[In, Out any](toolset ToolsetMetadata, tool mcp.Tool,
    requiredScopes []scopes.Scope, handler ...) ServerTool {
    st := inventory.NewServerToolWithContextHandler(tool, toolset, handler)
    st.RequiredScopes = scopes.ToStringSlice(requiredScopes...)
    st.AcceptedScopes = scopes.ExpandScopes(requiredScopes...)
    return st
}
```

Key design pattern: **scope checking happens at the HTTP layer, BEFORE the JSON-RPC/SSE stream begins**. This is critical because once an HTTP 200 response with an SSE stream is opened, the HTTP status code cannot be changed. Note: all of this machinery is custom to the github-mcp-server application — the Go SDK provides none of it.

### 2.4 Related Spec Proposals

| SEP | Title | Status | Relevance |
|-----|-------|--------|-----------|
| [SEP-1488](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1488) | `securitySchemes` in Tool Metadata | Draft | Per-tool `oauth2` scheme with scopes array |
| [SEP-1489](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1489) | Tool Error Responses for Triggering OAuth Flows | Draft | `_meta.mcp/www_authenticate` in tool results — transport-agnostic alternative (rejected by consensus in favor of HTTP-bound approach) |
| [SEP-1880](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1880) | Tool-level scope requirements (`authorization.scopes`) | Closed (not planned) | `Tool.authorization.scopes` advisory metadata |
| [SEP-1881](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1881) | Scope-Filtered Tool Discovery | Draft | Filter `tools/list` by token scopes |

## 3. The Architectural Constraint

The fundamental constraint that shapes this entire design:

> **HTTP status codes are committed BEFORE tool handlers execute.**

In the Streamable HTTP transport, `handlePostRequest()` returns `new Response(readable, { status: 200, headers })` immediately, then fires `onmessage()` callbacks that route through the Protocol layer to tool handlers. By the time a tool handler runs, HTTP 200 is already sent. Any error from the handler becomes a JSON-RPC error response delivered as an SSE event — **not an HTTP 403**.

This means **scope challenges must be evaluated before the SSE stream opens**, at the HTTP middleware/transport layer. This is exactly how github/github-mcp-server does it.

## 4. Proposed Design

### 4.1 Declare scopes at tool registration (co-located)

Add optional scope metadata to `McpServer.registerTool()`:

```typescript
mcpServer.registerTool(
  'get_private_repo',
  {
    description: 'Get private repository details',
    inputSchema: { repo: z.string() },
    scopes: ['repo:read'],  // Simple: just an array of required scopes
  },
  async ({ repo }, ctx) => { /* ... */ }
);

// Or with scope hierarchy support:
mcpServer.registerTool(
  'get_repo',
  {
    scopes: {
      required: ['public_repo'],
      accepted: ['public_repo', 'repo'], // 'repo' implies 'public_repo'
    },
  },
  handler
);
```

### 4.2 Declare scopes separately (decoupled)

Scopes don't have to live with tool definitions. `setToolScopes()` lets implementers
define scopes in one central place — from a config file, a mapping, or dynamically:

```typescript
// Define all scopes in one place
const TOOL_SCOPES: Record<string, string[]> = {
    'get_repo': ['repo:read'],
    'create_issue': ['repo:write'],
    'list_orgs': ['read:org'],
};

for (const [tool, scopes] of Object.entries(TOOL_SCOPES)) {
    mcpServer.setToolScopes(tool, scopes);
}
```

Scopes set via `setToolScopes()` take precedence over any `scopes` provided during
tool registration. Both approaches can be mixed freely.

### 4.3 Transport configuration

Add a `scopeChallenge` option to `StreamableHTTPServerTransport`. Only one field
is required — the `resourceMetadataUrl` for the `WWW-Authenticate` header:

```typescript
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  scopeChallenge: {
    resourceMetadataUrl:
      'https://mcp.example.com/.well-known/oauth-protected-resource',
  }
});
```

The transport reads the token's active scopes from `AuthInfo.scopes`, which is
populated by the implementer's own auth middleware. The SDK does not determine what
scopes are active — that is entirely the implementer's responsibility, just as it is
the implementer's choice what scopes to require per tool.

### 4.4 Automatic wiring via `connect()`

`McpServer.connect()` automatically wires the scope resolver to the transport:

```typescript
await mcpServer.connect(transport);
// That's it — scope challenges are now active.
```

Under the hood, `connect()` detects if the transport supports `setScopeResolver()`
and wires `McpServer.getToolScopes()` into it. No manual plumbing needed.

When `scopeChallenge` is configured, the transport:
1. Before opening the SSE stream, parses the JSON-RPC message to identify `tools/call` requests
2. Looks up the tool's registered scopes via the auto-wired resolver
3. Compares against the token's active scopes from `authInfo.scopes`
4. If insufficient: returns HTTP 403 + `WWW-Authenticate` header **without opening the SSE stream**
5. If sufficient: proceeds normally

### 4.5 Transport-scoping: stdio and other transports ignore this entirely

The `scopeChallenge` configuration is only available on `StreamableHTTPServerTransport`. The `StdioServerTransport` and any non-HTTP transports have no concept of HTTP status codes and no OAuth flow — scope challenges are meaningless there. This aligns with the MCP spec: "Implementations using an STDIO transport SHOULD NOT follow this specification."

### 4.6 Error response format

The 403 response body matches the protected resource metadata error format:

```
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope",
                         scope="repo:read user:profile",
                         resource_metadata="https://mcp.example.com/...",
                         error_description="Additional repository read permission required"
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "error": {
    "code": -32403,
    "message": "Insufficient scope: required repo:read"
  },
  "id": 1
}
```

This reuses the existing `createJsonErrorResponse` helper in the transport, which already handles headers and status codes.

## 5. Worked Example: End-to-End Flow

```
┌─────────┐                        ┌─────────────────┐            ┌──────────┐
│  Client  │                        │  MCP Server      │            │ Auth Srv │
└────┬─────┘                        └────────┬─────────┘            └────┬─────┘
     │                                       │                           │
     │ POST /mcp  (tools/call: get_repo)     │                           │
     │ Authorization: Bearer <token_v1>      │                           │
     ├──────────────────────────────────────►│                           │
     │                                       │                           │
     │                     [Transport layer: │                           │
     │                      parse JSON-RPC,  │                           │
     │                      find tool scope  │                           │
     │                      metadata,        │                           │
     │                      check token      │                           │
     │                      scopes vs        │                           │
     │                      required scopes] │                           │
     │                                       │                           │
     │ 403 Forbidden                         │                           │
     │ WWW-Authenticate: Bearer              │                           │
     │   error="insufficient_scope"          │                           │
     │   scope="repo:read"                   │                           │
     │   resource_metadata="https://..."     │                           │
     │◄──────────────────────────────────────┤                           │
     │                                       │                           │
     │ [Client SDK: extract scope,           │                           │
     │  re-authorize with new scope]         │                           │
     │                                       │                           │
     │ Authorization request (scope=repo:read)                           │
     ├──────────────────────────────────────────────────────────────────►│
     │                                                                   │
     │ Access token (scope=repo:read)                                    │
     │◄──────────────────────────────────────────────────────────────────┤
     │                                       │                           │
     │ POST /mcp  (tools/call: get_repo)     │                           │
     │ Authorization: Bearer <token_v2>      │                           │
     ├──────────────────────────────────────►│                           │
     │                                       │                           │
     │                     [Scope check OK]  │                           │
     │                                       │                           │
     │ 200 OK (SSE stream)                   │                           │
     │ data: {"result": {...}}               │                           │
     │◄──────────────────────────────────────┤                           │
```

## 6. Mid-Tool-Call Scope Challenges: The Unsolved Problem

This proposal **explicitly does not attempt** mid-tool-call scope challenges. Here's why, and what the future might look like.

### 6.1 The Problem

Some scope requirements are **dynamic** — they depend on runtime data. Example: calling `get_repo` for a public repo needs no extra scopes, but for a private repo needs `repo:read`. The server only discovers this after making an upstream API call, by which point the HTTP 200 SSE stream is already open.

### 6.2 Why It's Hard

Mid-handler scope challenges would require fundamentally changing how JSON-RPC over HTTP works:

1. **HTTP status is already committed**: The 200+SSE model means we can't retroactively return 403
2. **JSON-RPC has no concept of "retry with different auth"**: The protocol has no standardized error code for "re-authenticate and retry"
3. **Multiplexed requests**: A single HTTP POST can contain multiple JSON-RPC requests — one needing a scope challenge doesn't mean all do

### 6.3 Potential Future Approaches

**Option A: Sentinel error in JSON-RPC result (`_meta` approach — SEP-1489)**

```typescript
// Server returns this as a tool result:
{
  "content": [{ "type": "text", "text": "Additional permissions required" }],
  "isError": true,
  "_meta": {
    "mcp/www_authenticate": [
      "Bearer error=\"insufficient_scope\", scope=\"repo:read\", ..."
    ]
  }
}
```

Client detects `_meta.mcp/www_authenticate`, triggers OAuth flow, retries. This is **transport-agnostic** but was rejected by consensus in favor of the HTTP-bound approach. It also requires client SDK changes to recognize and act on this `_meta` field.

**Option B: Sentinel error thrown by handler (`ScopeChallengeError`)**

```typescript
throw new ScopeChallengeError(['repo:read']);
```

The Protocol layer catches this, and... what? Within an SSE stream, it can only send a JSON-RPC error response. The client SDK would need to recognize this specific error shape and trigger re-auth. This is essentially Option A with extra SDK machinery to translate the thrown error into the right JSON-RPC shape.

**Option C: Breaking change — defer HTTP response**

The transport could buffer requests and not open the SSE stream until the tool handler completes (or explicitly signals success). This would allow the transport to still return 403 for scope challenges. However, this **fundamentally breaks streaming** — the entire point of SSE is to start sending data immediately. This is a major architectural change.

**Option D: Protocol-level step-up negotiation**

A new MCP method like `auth/stepUp` that the server sends as a request to the client (using the bidirectional protocol), carrying the scope challenge information. The client handles it, re-authorizes, and the server retries the upstream call. This is the cleanest approach but requires spec changes and is a significant addition to the protocol.

### 6.4 Recommendation for Mid-Handler Challenges

For now, servers with dynamic scope requirements should:
1. Use the pre-execution static scope check where possible (covering the common case)
2. For truly dynamic cases, return a tool error result with a descriptive message that explains what permissions are needed — the LLM/user can then retry after re-authorizing
3. Future spec work (potentially via the working group) should evaluate Option D (protocol-level step-up) as the cleanest long-term solution

## 7. Implementation (Shipped with This Proposal)

This is not a sketch — working code is included in this PR. Here's what was added:

### 7.1 `ToolScopeConfig` type (`packages/server/src/server/mcp.ts`)

```typescript
export interface ToolScopeConfig {
  required: string[];
  accepted?: string[]; // Defaults to required if not provided
}
```

### 7.2 `ScopeChallengeConfig` type (`packages/server/src/server/streamableHttp.ts`)

```typescript
export interface ScopeChallengeConfig {
  resourceMetadataUrl: string;
  buildErrorDescription?: (toolName: string, requiredScopes: string[]) => string;
}
```

No `getTokenScopes` callback — the transport reads `authInfo.scopes` directly.
The implementer populates `authInfo` in their auth middleware; the SDK does not
determine what scopes are active.

### 7.3 Tool scope registration — two paths

**Co-located** (via `registerTool` config):
```typescript
server.registerTool('get_repo', { scopes: ['repo:read'] }, handler);
```

**Decoupled** (via `setToolScopes`):
```typescript
server.setToolScopes('get_repo', ['repo:read']);
```

`setToolScopes` takes precedence when both are used. Both accept `string[]` (sugar)
or `{ required, accepted }` (for scope hierarchy).

### 7.4 Auto-wiring in `McpServer.connect()`

```typescript
async connect(transport: Transport): Promise<void> {
    if ('setScopeResolver' in transport && typeof transport.setScopeResolver === 'function') {
        transport.setScopeResolver((toolName: string) => this.getToolScopes(toolName));
    }
    return await this.server.connect(transport);
}
```

### 7.5 Pre-execution check in transport

The `_checkScopeChallenge()` method runs after message parsing but before the SSE
stream opens. It only fires for `tools/call` requests where scope metadata exists.

**Additive scoping:** The `scope` value in the `WWW-Authenticate` challenge header
is always the **union** of the token's existing scopes plus the tool's `required`
scopes. This ensures the client never loses scopes it already has when
re-authorizing — a pattern established by github/github-mcp-server and consistent
with how OAuth scope accumulation should work. For example, if a token has
`['user:read', 'user:write']` and the tool requires `['repo:read']`, the challenge
recommends `scope="user:read user:write repo:read"`.

### 7.6 What this does NOT change

- **No changes to the Protocol layer** — scope challenges are purely at the transport level
- **No changes to JSON-RPC message handling** — errors stay as JSON-RPC errors
- **No changes to stdio transport** — scope challenges are HTTP-only
- **No changes to client SDK** — the existing 403 handling already works
- **No changes to the MCP specification** — this implements existing spec behavior

## 8. Comparison with github/github-mcp-server Approach

| Aspect | github-mcp-server (custom, not Go SDK) | This Proposal (TS SDK) |
|--------|----------------------|-------------------------------|
| **Scope declaration** | `ServerTool.RequiredScopes` + `AcceptedScopes` set at tool creation via `NewTool()` | `scopes: { required, accepted }` in `McpServer.tool()` config |
| **Scope checking** | HTTP middleware (`WithScopeChallenge`) parses JSON-RPC body to find tool name | Transport-level pre-execution hook, tool registry lookup |
| **Scope hierarchy** | `ExpandScopes()` with explicit `ScopeHierarchy` map | Server author provides `accepted` explicitly (utilities can be offered separately) |
| **Scope fetching** | `scopeFetcher.FetchTokenScopes()` — can call GitHub API | Reads `authInfo.scopes` directly — populated by the implementer's auth middleware |
| **Where it runs** | Completely outside any SDK, in custom application middleware | Inside the SDK transport layer, configured via options |
| **Dynamic challenges** | Not supported (only static pre-check) | Not supported (same constraint) |

The key difference: this proposal brings scope challenge support **into the SDK** rather than requiring every server author to implement it in custom application middleware (as github-mcp-server had to). All MCP SDKs (Go, Python, etc.) could adopt a similar SDK-level approach.

## 9. Open Questions for Working Group

1. **Should `ToolScopeConfig` be part of the `Tool` schema?** SEP-1880 proposed `Tool.authorization.scopes` at the spec level. This was closed, but there's clear demand. Should the working group champion this?

2. **Scope hierarchy utilities:** Should the SDK provide `expandScopes()` with a configurable hierarchy, or is this the server author's responsibility?

3. **Scope-filtered discovery (SEP-1881):** If tools declare scopes, should `tools/list` automatically filter tools the client can't use? This is a related but separable concern.

4. **Protocol-level step-up (Option D):** Is there appetite for a new MCP method like `auth/stepUp` that enables mid-handler scope challenges without breaking the HTTP model?

5. **Multi-request batches:** When a single HTTP POST contains multiple JSON-RPC requests, and one needs a scope challenge, should the entire batch be rejected with 403, or should only the failing tool call get an error?

6. **Accumulative scoping:** The current client overwrite behavior ([#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582)) means progressive authorization drops previous scopes. [PR #1618](https://github.com/modelcontextprotocol/typescript-sdk/pull/1618) proposes union-based accumulation. This proposal takes the position that **additive scoping is correct**: the server always includes the token's existing scopes in the challenge `scope` parameter, so the client re-authorizes with the full union. The spec should mandate this behavior — dropping scopes on step-up creates a broken loop where gaining one scope loses another.

## 10. What's NOT in Scope (Pun Intended)

- **Transport-agnostic scope challenges** (SEP-1489's `_meta` approach) — consensus rejected this
- **Mid-handler scope challenges** — acknowledged as desirable but architecturally constrained; deferred to future work
- **Changes to the MCP specification** — this implements existing spec behavior
- **Token expiry signaling** ([#1294](https://github.com/modelcontextprotocol/typescript-sdk/issues/1294)) — related pattern (401 from tool handler) but separate concern

## Appendix A: Reference Links

- [MCP Spec — Scope Challenge Handling](https://modelcontextprotocol.io/specification/draft/basic/authorization#scope-challenge-handling)
- [TS SDK Issue #1151 — Server SDK support for scope challenges](https://github.com/modelcontextprotocol/typescript-sdk/issues/1151)
- [TS SDK Issue #1294 — Server SDK support for signaling token expiry](https://github.com/modelcontextprotocol/typescript-sdk/issues/1294)
- [TS SDK Issue #1582 — Scope overwrite during progressive auth](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582)
- [TS SDK PR #1618 — Fix: accumulate scopes across challenges](https://github.com/modelcontextprotocol/typescript-sdk/pull/1618)
- [github/github-mcp-server — scope_challenge.go](https://github.com/github/github-mcp-server/blob/main/pkg/http/middleware/scope_challenge.go)
- [github/github-mcp-server — scopes package](https://github.com/github/github-mcp-server/tree/main/pkg/scopes)
- [SEP-1488 — securitySchemes in Tool Metadata](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1488)
- [SEP-1489 — Tool Error Responses for OAuth Flows](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1489)
- [SEP-1880 — Tool-level scope requirements](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1880)
- [SEP-1881 — Scope-Filtered Tool Discovery](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1881)
- [Conformance test — scope step-up](https://github.com/modelcontextprotocol/conformance/blob/main/src/scenarios/client/auth/scope-handling.ts#L237)
