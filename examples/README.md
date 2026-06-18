# MCP TypeScript SDK examples

One **story** per directory. Every story is a runnable, self-verifying client/server pair: `server.ts` is what you would deploy, `client.ts` is what a host would write — it connects, exercises the feature with the public client API, asserts results, and exits 0. CI runs every
pair over every transport it supports (`scripts/run-examples.ts`); a non-zero exit fails the build.

Each story is its own private workspace package (`@mcp-examples/<story>`). Run any pair from the repo root:

```bash
# stdio (the client spawns the server itself):
pnpm --filter @mcp-examples/<story> client

# Streamable HTTP (two terminals):
pnpm --filter @mcp-examples/<story> server -- --http --port 3000
pnpm --filter @mcp-examples/<story> client -- --http http://127.0.0.1:3000/mcp
```

Some stories mount at a different path (e.g. `/`); check the story's `package.json#example.path` or its README for the exact URL.

## Start here

| Story                                 | What it teaches                                                          |
| ------------------------------------- | ------------------------------------------------------------------------ |
| [`tools/`](./tools/README.md)         | Register tools, infer input/output schemas, call them, structured output |
| [`prompts/`](./prompts/README.md)     | Prompts + argument completion                                            |
| [`resources/`](./resources/README.md) | Static + templated resources, list/read                                  |
| [`dual-era/`](./dual-era/README.md)   | One factory, both protocol eras, both transports                         |

## Feature stories

| Story                                                               | What it teaches                                                                                         | Transports   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| [`mrtr/`](./mrtr/README.md)                                         | Multi-round-trip write-once tool, secure `requestState`                                                 | stdio + http |
| [`subscriptions/`](./subscriptions/README.md)                       | `subscriptions/listen`: `client.listen()` + auto-open, `handler.notify` / `ServerEventBus`              | stdio + http |
| [`streaming/`](./streaming/README.md)                               | In-flight progress, logging, cancellation                                                               | stdio + http |
| [`elicitation/`](./elicitation/README.md)                           | Elicitation (form + URL mode), both eras: push-style on 2025, `inputRequired` on 2026                   | stdio        |
| [`sampling/`](./sampling/README.md)                                 | Tool that requests LLM sampling from the client                                                         | stdio        |
| [`stickynotes/`](./stickynotes/README.md)                           | "Real app" capstone: tools mutate state, a resource per note, listChanged, elicitation-confirmed clear  | stdio + http |
| [`caching/`](./caching/README.md)                                   | `cacheHints` stamping on cacheable results (2026-07-28)                                                 | stdio + http |
| [`custom-methods/`](./custom-methods/README.md)                     | Vendor-prefixed methods + custom notifications                                                          | stdio + http |
| [`schema-validators/`](./schema-validators/README.md)               | ArkType, Valibot, Zod, and `outputSchema`                                                               | stdio + http |
| [`custom-version/`](./custom-version/README.md)                     | `supportedProtocolVersions` / version negotiation                                                       | stdio + http |
| [`parallel-calls/`](./parallel-calls/README.md)                     | Multiple clients / parallel tool calls, per-client notifications                                        | stdio + http |
| [`legacy-routing/`](./legacy-routing/README.md)                     | `isLegacyRequest` in front of an existing sessionful 1.x deployment + a strict modern entry on one port | http         |
| [`bearer-auth/`](./bearer-auth/README.md)                           | Resource server with bearer token; `401` + `WWW-Authenticate`                                           | http         |
| [`oauth-client-credentials/`](./oauth-client-credentials/README.md) | OAuth `client_credentials` (machine-to-machine): in-repo AS + `ClientCredentialsProvider`               | http         |

## HTTP hosting variants

| Story                                               | What it teaches                                               | Transports |
| --------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| [`stateless-legacy/`](./stateless-legacy/README.md) | `createMcpHandler` default posture (the minimal deployment)   | http       |
| [`json-response/`](./json-response/README.md)       | `createMcpHandler({ responseMode: 'json' })`                  | http       |
| [`hono/`](./hono/README.md)                         | `createMcpHandler(...).fetch` on Hono / web-standard runtimes | http       |
| [`sse-polling/`](./sse-polling/README.md)           | SEP-1699 SSE polling/resumption (sessionful 2025)             | http       |
| [`standalone-get/`](./standalone-get/README.md)     | Standalone GET stream + `listChanged` push (sessionful 2025)  | http       |

## Excluded

| Directory                                                                                  | What it is                                                                                                      | Why not in CI                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`oauth/`](./oauth/README.md)                                                              | Interactive authorization-code OAuth flow (`simpleOAuthClient.ts`, `dualModeAuth.ts`, `simpleTokenProvider.ts`) | Opens a real browser and runs a callback server on `:8090`. The headless machine-to-machine grant is covered by [`oauth-client-credentials/`](./oauth-client-credentials/README.md).                          |
| [`repl/`](./repl/README.md)                                                                | Fully-featured HTTP playground server + readline client                                                         | Interactive — `client.ts` reads from stdin. Run manually in two terminals.                                                                                                                                    |
| [`sse-polling/`](./sse-polling/README.md), [`standalone-get/`](./standalone-get/README.md) | Legacy sessionful-2025 SSE stories (SEP-1699 reconnect/replay; standalone GET stream)                           | Kept for reference; long-running reconnect/timer flows that need a longer per-leg readiness wait than the harness default. Self-verifying — flip the `excluded` flag once the harness has bounded-wait knobs. |
| [`guides/`](./guides/README.md)                                                            | Snippet collections synced into `docs/server.md` and `docs/client.md`                                           | Typecheck-only; not a runnable pair.                                                                                                                                                                          |
| `server-quickstart/`, `client-quickstart/`                                                 | Website-tutorial sources                                                                                        | External network / API key; typecheck-only.                                                                                                                                                                   |
| `shared/`                                                                                  | Demo OAuth provider helper library                                                                              | Not a story — imported by the OAuth examples.                                                                                                                                                                 |

## Multi-node deployment patterns

When deploying MCP servers in a horizontally scaled environment (multiple server instances), there are a few different options that can be useful for different use cases:

- **Stateless mode** - no need to maintain state between calls.
- **Persistent storage mode** - state stored in a database; any node can handle a session.
- **Local state with message routing** - stateful nodes + pub/sub routing for a session.

### Stateless mode

To enable stateless mode, configure the `NodeStreamableHTTPServerTransport` with:

```typescript
sessionIdGenerator: undefined;
```

```
┌─────────────────────────────────────────────┐
│                  Client                     │
└─────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│                Load Balancer                │
└─────────────────────────────────────────────┘
          │                       │
          ▼                       ▼
┌─────────────────┐     ┌─────────────────────┐
│  MCP Server #1  │     │    MCP Server #2    │
│ (Node.js)       │     │  (Node.js)          │
└─────────────────┘     └─────────────────────┘
```

### Persistent storage mode

Configure the transport with session management, but use an external event store:

```typescript
sessionIdGenerator: () => randomUUID(),
eventStore: databaseEventStore
```

```
┌─────────────────────────────────────────────┐
│                  Client                     │
└─────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│                Load Balancer                │
└─────────────────────────────────────────────┘
          │                       │
          ▼                       ▼
┌─────────────────┐     ┌─────────────────────┐
│  MCP Server #1  │     │    MCP Server #2    │
│ (Node.js)       │     │  (Node.js)          │
└─────────────────┘     └─────────────────────┘
          │                       │
          │                       │
          ▼                       ▼
┌─────────────────────────────────────────────┐
│           Database (PostgreSQL)             │
│                                             │
│  • Session state                            │
│  • Event storage for resumability           │
└─────────────────────────────────────────────┘
```

### Streamable HTTP with distributed message routing

For scenarios where local in-memory state must be maintained on specific nodes, combine Streamable HTTP with pub/sub routing so one node can terminate the client connection while another node owns the session state.

```
┌─────────────────────────────────────────────┐
│                  Client                     │
└─────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│                Load Balancer                │
└─────────────────────────────────────────────┘
          │                       │
          ▼                       ▼
┌─────────────────┐     ┌─────────────────────┐
│  MCP Server #1  │◄───►│    MCP Server #2    │
│ (Has Session A) │     │  (Has Session B)    │
└─────────────────┘     └─────────────────────┘
          ▲│                     ▲│
          │▼                     │▼
┌─────────────────────────────────────────────┐
│         Message Queue / Pub-Sub             │
│                                             │
│  • Session ownership registry               │
│  • Bidirectional message routing            │
│  • Request/response forwarding              │
└─────────────────────────────────────────────┘
```

## Backwards compatibility (Streamable HTTP ↔ legacy SSE)

A client that needs to fall back from Streamable HTTP to the legacy HTTP+SSE transport (for servers that only implement the older transport) follows the [`connect_sseFallback`](../docs/client.md#backwards-compatibility) recipe in the client guide — try
`StreamableHTTPClientTransport` first, fall back to `SSEClientTransport` on a 4xx. There is no runnable pair for this in `examples/` (the legacy SSE server transport is deprecated); the snippet in `guides/clientGuide.examples.ts` is the complete pattern.
