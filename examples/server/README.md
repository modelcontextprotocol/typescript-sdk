# MCP TypeScript SDK Examples (Server)

This directory contains runnable MCP **server** examples built with `@modelcontextprotocol/server` plus framework adapters:

- `@modelcontextprotocol/express`
- `@modelcontextprotocol/hono`

For client examples, see [`../client/README.md`](../client/README.md). For guided docs, see [`../../docs/server.md`](../../docs/server.md).

## Running examples

From anywhere in the SDK:

```bash
pnpm install
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleStreamableHttp.ts
```

Or, from within this package:

```bash
cd examples/server
pnpm tsx src/simpleStreamableHttp.ts
```

## Example index

| Scenario                                            | Description                                                                                     | File                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Streamable HTTP server (stateful)                   | Feature-rich server with tools/resources/prompts, logging, tasks, sampling, and optional OAuth. | [`src/simpleStreamableHttp.ts`](src/simpleStreamableHttp.ts)                                 |
| Streamable HTTP server (stateless)                  | No session tracking; good for simple API-style servers.                                         | [`src/simpleStatelessStreamableHttp.ts`](src/simpleStatelessStreamableHttp.ts)               |
| JSON response mode (no SSE)                         | Streamable HTTP with JSON-only responses and limited notifications.                             | [`src/jsonResponseStreamableHttp.ts`](src/jsonResponseStreamableHttp.ts)                     |
| Server notifications over Streamable HTTP           | Demonstrates server-initiated notifications via GET+SSE.                                        | [`src/standaloneSseWithGetStreamableHttp.ts`](src/standaloneSseWithGetStreamableHttp.ts)     |
| Deprecated HTTP+SSE server (legacy)                 | Legacy HTTP+SSE transport for backwards-compatibility testing.                                  | [`src/simpleSseServer.ts`](src/simpleSseServer.ts)                                           |
| Backwards-compatible server (Streamable HTTP + SSE) | One server that supports both Streamable HTTP and legacy SSE clients.                           | [`src/sseAndStreamableHttpCompatibleServer.ts`](src/sseAndStreamableHttpCompatibleServer.ts) |
| Form elicitation server                             | Collects **non-sensitive** user input via schema-driven forms.                                  | [`src/elicitationFormExample.ts`](src/elicitationFormExample.ts)                             |
| URL elicitation server                              | Secure browser-based flows for **sensitive** input (API keys, OAuth, payments).                 | [`src/elicitationUrlExample.ts`](src/elicitationUrlExample.ts)                               |
| Sampling + tasks server                             | Demonstrates sampling and experimental task-based execution.                                    | [`src/toolWithSampleServer.ts`](src/toolWithSampleServer.ts)                                 |
| Task interactive server                             | Task-based execution with interactive server→client requests.                                   | [`src/simpleTaskInteractive.ts`](src/simpleTaskInteractive.ts)                               |
| Hono Streamable HTTP server                         | Streamable HTTP server built with Hono instead of Express.                                      | [`src/honoWebStandardStreamableHttp.ts`](src/honoWebStandardStreamableHttp.ts)               |
| SSE polling demo server                             | Legacy SSE server intended for polling demos.                                                   | [`src/ssePollingExample.ts`](src/ssePollingExample.ts)                                       |

## OAuth demo flags (Streamable HTTP server)

```bash
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleStreamableHttp.ts --oauth
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleStreamableHttp.ts --oauth --oauth-strict
```

## URL elicitation example (server + client)

Run the server:

```bash
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/elicitationUrlExample.ts
```

Run the client in another terminal:

```bash
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/elicitationUrlExample.ts
```

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

Start one of the servers:

```bash
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleSseServer.ts
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleStreamableHttp.ts
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/sseAndStreamableHttpCompatibleServer.ts
```

Then run the backwards-compatible client:

```bash
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/streamableHttpWithSseFallbackClient.ts
```
