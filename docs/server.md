## Server overview

This SDK lets you build MCP servers in TypeScript and connect them to different transports.
For most use cases you will use `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
and choose one of:

- **Streamable HTTP** (recommended for remote servers)
- **HTTP + SSE** (deprecated, for backwards compatibility only)
- **stdio** (for local, process‑spawned integrations)

For a complete, runnable example server, see:

- `src/examples/server/simpleStreamableHttp.ts` – feature‑rich Streamable HTTP server
- `src/examples/server/jsonResponseStreamableHttp.ts` – Streamable HTTP with JSON response mode
- `src/examples/server/simpleStatelessStreamableHttp.ts` – stateless Streamable HTTP server
- `src/examples/server/simpleSseServer.ts` – deprecated HTTP+SSE transport
- `src/examples/server/sseAndStreamableHttpCompatibleServer.ts` – backwards‑compatible server for old and new clients

## Transports

### Streamable HTTP

Streamable HTTP is the modern, fully featured transport. It supports:

- Request/response over HTTP POST
- Server‑to‑client notifications over SSE (when enabled)
- Optional JSON‑only response mode with no SSE
- Session management and resumability

Key examples:

- `src/examples/server/simpleStreamableHttp.ts` – sessions, logging, tasks, elicitation, auth hooks
- `src/examples/server/jsonResponseStreamableHttp.ts` – `enableJsonResponse: true`, no SSE
- `src/examples/server/standaloneSseWithGetStreamableHttp.ts` – notifications with Streamable HTTP GET + SSE

See the MCP spec for full transport details:  
`https://modelcontextprotocol.io/specification/2025-03-26/basic/transports`

### Stateless vs stateful sessions

Streamable HTTP can run:

- **Stateless** – no session tracking, ideal for simple API‑style servers.
- **Stateful** – sessions have IDs, and you can enable resumability and advanced features.

Examples:

- Stateless Streamable HTTP: `src/examples/server/simpleStatelessStreamableHttp.ts`
- Stateful with resumability: `src/examples/server/simpleStreamableHttp.ts`

### Deprecated HTTP + SSE

The older HTTP+SSE transport (protocol version 2024‑11‑05) is supported only for
backwards compatibility. New implementations should prefer Streamable HTTP.

Examples:

- Legacy SSE server: `src/examples/server/simpleSseServer.ts`
- Backwards‑compatible server (Streamable HTTP + SSE):  
  `src/examples/server/sseAndStreamableHttpCompatibleServer.ts`

## Running your server

For a minimal “getting started” experience:

1. Start from `src/examples/server/simpleStreamableHttp.ts`.
2. Remove features you do not need (tasks, advanced logging, OAuth, etc.).
3. Register your own tools, resources and prompts.

For more detailed patterns (stateless vs stateful, JSON response mode, CORS, DNS
rebind protection), see the examples above and the MCP spec sections on transports.

## Multi‑node deployment patterns

The SDK supports multi‑node deployments using Streamable HTTP. The high‑level
patterns are documented in `src/examples/README.md`:

- Stateless mode (any node can handle any request)
- Persistent storage mode (shared database for session state)
- Local state with message routing (message queue + pub/sub)

Those deployment diagrams are kept in `src/examples/README.md` so the examples
and documentation stay aligned.

## Backwards compatibility

To handle both modern and legacy clients:

- Run a backwards‑compatible server:
  - `src/examples/server/sseAndStreamableHttpCompatibleServer.ts`
- Use a client that falls back from Streamable HTTP to SSE:
  - `src/examples/client/streamableHttpWithSseFallbackClient.ts`

For the detailed protocol rules, see the “Backwards compatibility” section of the MCP spec.



