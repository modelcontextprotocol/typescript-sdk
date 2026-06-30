# MCP TypeScript SDK examples

One **story** per directory. Every story is a runnable, self-verifying client/server pair: `server.ts` is what you would deploy, `client.ts` is what a host would write — it connects, exercises the feature with the public client API, asserts results, and exits 0. CI runs every
pair over every transport it supports (`scripts/examples/run-examples.ts`); a non-zero exit fails the build.

Each story is its own private workspace package (`@mcp-examples/<story>`). Run any pair from the repo root:

```bash
# stdio (the client spawns the server itself):
pnpm --filter @mcp-examples/<story> client

# Streamable HTTP (two terminals):
pnpm --filter @mcp-examples/<story> server -- --http --port 3000
pnpm --filter @mcp-examples/<story> client -- --http http://127.0.0.1:3000/mcp
```

Add `-- --legacy` to the client command for the 2025-era handshake.

The one exception to the generic commands is the reference pair: [`cli-client/`](./cli-client/README.md) and [`todos-server/`](./todos-server/README.md) have their own entry points (`pnpm --filter @mcp-examples/cli-client start`, `pnpm --filter @mcp-examples/todos-server start:http`) — see their READMEs.

## Start here

| Story                                 | What it teaches                                                          |
| ------------------------------------- | ------------------------------------------------------------------------ |
| [`tools/`](./tools/README.md)         | Register tools, infer input/output schemas, call them, structured output |
| [`prompts/`](./prompts/README.md)     | Prompts + argument completion                                            |
| [`resources/`](./resources/README.md) | Static + templated resources, list/read                                  |
| [`dual-era/`](./dual-era/README.md)   | One factory, both protocol eras, both transports                         |

## Feature stories

| Story                                                               | What it teaches                                                                                                                                             | Transports   | Era            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------- |
| [`mrtr/`](./mrtr/README.md)                                         | Multi-round-trip write-once tool, secure `requestState`                                                                                                     | stdio + http | modern         |
| [`subscriptions/`](./subscriptions/README.md)                       | `subscriptions/listen`: `client.listen()` + auto-open, `handler.notify` / `ServerEventBus`                                                                  | stdio + http | modern         |
| [`streaming/`](./streaming/README.md)                               | In-flight progress, logging, cancellation                                                                                                                   | stdio + http | dual           |
| [`elicitation/`](./elicitation/README.md)                           | Elicitation (form + URL mode), both eras: push-style on 2025, `inputRequired` on 2026                                                                       | stdio + http | dual           |
| [`sampling/`](./sampling/README.md)                                 | Tool that requests LLM sampling from the client, both eras: push-style on 2025, `inputRequired` on 2026                                                     | stdio + http | dual           |
| [`stickynotes/`](./stickynotes/README.md)                           | "Real app" capstone: tools mutate state, a resource per note, listChanged, elicitation-confirmed clear                                                      | stdio + http | dual           |
| [`cli-client/`](./cli-client/README.md)                             | **Reference host**: LLM chat CLI with provider seam — tool loop, @-mention resources, prompt commands, sampling, elicitation, roots, OAuth, cancellation    | stdio + http | dual           |
| [`todos-server/`](./todos-server/README.md)                         | **Reference server** (pairs with cli-client): every server feature with a real job — CRUD tools, sampling, multi-round elicitation, subscriptions, progress | stdio + http | dual           |
| [`caching/`](./caching/README.md)                                   | `cacheHints` stamping on cacheable results (2026-07-28)                                                                                                     | stdio + http | modern         |
| [`gateway/`](./gateway/README.md)                                   | `connect({ prior })` — probe once, zero-round-trip connect for every worker (gateway pattern)                                                               | http         | modern         |
| [`custom-methods/`](./custom-methods/README.md)                     | Vendor-prefixed methods + custom notifications                                                                                                              | stdio + http | dual           |
| [`extension-capabilities/`](./extension-capabilities/README.md)     | Declaring `capabilities.extensions` and reading the negotiated map                                                                                          | stdio + http | dual           |
| [`schema-validators/`](./schema-validators/README.md)               | ArkType, Valibot, Zod, and `outputSchema`                                                                                                                   | stdio + http | dual           |
| [`custom-version/`](./custom-version/README.md)                     | `supportedProtocolVersions` / version negotiation                                                                                                           | stdio + http | legacy         |
| [`parallel-calls/`](./parallel-calls/README.md)                     | Multiple clients / parallel tool calls, per-client notifications                                                                                            | stdio + http | dual           |
| [`legacy-routing/`](./legacy-routing/README.md)                     | `isLegacyRequest` in front of an existing sessionful 1.x deployment + a strict modern entry on one port                                                     | http         | dual (in-body) |
| [`bearer-auth/`](./bearer-auth/README.md)                           | Resource server with bearer token; `401` + `WWW-Authenticate`                                                                                               | http         | dual           |
| [`oauth/`](./oauth/README.md)                                       | OAuth `authorization_code`: in-repo AS (auto-consent) + headless redirect-following client                                                                  | http         | dual           |
| [`oauth-client-credentials/`](./oauth-client-credentials/README.md) | OAuth `client_credentials` (machine-to-machine): in-repo AS + `ClientCredentialsProvider`                                                                   | http         | dual           |
| [`scoped-tools/`](./scoped-tools/README.md)                         | Per-tool scope on `createMcpHandler` — bearer-verify gate + handler-level `ctx.http?.authInfo` checks                                                       | http         | modern         |

## HTTP hosting variants

| Story                                               | What it teaches                                               | Transports | Era            |
| --------------------------------------------------- | ------------------------------------------------------------- | ---------- | -------------- |
| [`stateless-legacy/`](./stateless-legacy/README.md) | `createMcpHandler` default posture (the minimal deployment)   | http       | dual (in-body) |
| [`json-response/`](./json-response/README.md)       | `createMcpHandler({ responseMode: 'json' })`                  | http       | modern         |
| [`hono/`](./hono/README.md)                         | `createMcpHandler(...).fetch` on Hono / web-standard runtimes | http       | dual           |
| [`sse-polling/`](./sse-polling/README.md)           | SEP-1699 SSE polling/resumption (sessionful 2025)             | http       | legacy         |
| [`standalone-get/`](./standalone-get/README.md)     | Standalone GET stream + `listChanged` push (sessionful 2025)  | http       | legacy         |

`dual (in-body)` = the client connects to both eras inside one runner invocation; the story demonstrates one server serving both side by side.

## Excluded

| Directory                                  | What it is                                                                                                                          | Why not in CI                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`repl/`](./repl/README.md)                | Fully-featured HTTP playground server + readline client                                                                             | Interactive — `client.ts` reads from stdin. Run manually in two terminals. |
| [`guides/`](./guides/README.md)            | Snippet collections synced into `docs/server.md` and `docs/client.md`                                                               | Typecheck-only; not a runnable pair.                                       |
| `server-quickstart/`, `client-quickstart/` | Website-tutorial sources                                                                                                            | External network / API key; typecheck-only.                                |
| `shared/`                                  | Argv/assert scaffold (`parseExampleArgs`/`check`/`siblingPath`); demo OAuth provider + `InMemoryEventStore` at the `./auth` subpath | Not a story — imported by every story as scaffolding.                      |

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

A client that needs to fall back from Streamable HTTP to the legacy HTTP+SSE transport (for servers that only implement the older transport) follows the [`connect_sseFallback`](../docs/client.md#sse-fallback-for-legacy-servers) recipe in the client guide — try
`StreamableHTTPClientTransport` first, fall back to `SSEClientTransport` on a 4xx. There is no runnable pair for this in `examples/` (the legacy SSE server transport is deprecated); the snippet in `guides/clientGuide.examples.ts` is the complete pattern.
