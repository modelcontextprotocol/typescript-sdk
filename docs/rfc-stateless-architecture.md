# RFC: Request-first SDK architecture

**Status:** Draft, seeking direction feedback
**Reference impl:** [`fweinberger/ts-sdk-rebuild`](https://github.com/modelcontextprotocol/typescript-sdk/tree/fweinberger/ts-sdk-rebuild) (proof-of-concept, not for direct merge)

---

## TL;DR

The only way into the SDK today is `server.connect(transport)`, which assumes a persistent channel. The protocol is moving to per-request stateless (SEP-2575/2567/2322). This RFC proposes adding `dispatch(request, env) → response` as the core primitive and building the connection model as one adapter on top of it. Existing code keeps working unchanged.

---

## Problem

```
                ┌────────────────────────────────────────────┐
                │ Protocol  (~1100 LOC, abstract)            │
                │  ├ handler registry                        │
                │  ├ request/response correlation            │
                │  ├ timeouts, debounce, progress            │
                │  ├ capability assertions (abstract)        │
                │  ├ TaskManager binding                     │
                │  └ connect(transport) — wires onmessage    │
                └────────────────────────────────────────────┘
                          ▲                    ▲
                  extends │                    │ extends
                ┌─────────┴──┐         ┌───────┴──────┐
                │   Server   │         │    Client    │
                └─────┬──────┘         └──────────────┘
                wraps │
                ┌─────┴──────┐
                │  McpServer │
                └────────────┘
```

Everything goes through `connect(transport)`. `Transport` is pipe-shaped (`{start, send, onmessage, close}`). The Streamable HTTP transport (1038 LOC) implements that pipe shape on top of HTTP — keeping a `_streamMapping` table to route fire-and-forget `send()` calls back to the right HTTP response, sniffing message bodies to detect `initialize` so it knows when to mint a session ID.

The recommended stateless server pattern is to construct a `McpServer`, register all tools, build a transport with `sessionIdGenerator: undefined`, `connect()`, handle one request, then let it all GC — per request.

---

## Proposal

```
                ┌───────────────────────────────────────┐
                │ Dispatcher  (~270 LOC)                │
                │  ├ handler registry                   │
                │  └ dispatch(req, env) → AsyncIterable │
                │  No transport. No connection state.   │
                └───────────────────────────────────────┘
                                  ▲
                          extends │
                ┌─────────────────┴─────────────────┐
                │ McpServer / Client                │
                │ (MCP handlers, registries)        │
                └─────────────────┬─────────────────┘
                                  │ dispatch() called by:
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
        ┌───────────────────┐         ┌──────────────────────────┐
        │ StreamDriver      │         │ shttpHandler             │
        │ (channel adapter) │         │ (request adapter)        │
        │ correlation,      │         │ ├ SessionCompat    (opt) │
        │ timeouts, debounce│         │ └ BackchannelCompat(opt) │
        │ stdio, WS, InMem  │         │ SHTTP                    │
        └───────────────────┘         └──────────────────────────┘
```

| Piece | What it is | Replaces |
|---|---|---|
| **Dispatcher** | `Map<method, handler>` + `dispatch(req, env)` | Protocol's handler-registry half |
| **StreamDriver** | Wraps a pipe; `onmessage → dispatch → send` loop | Protocol's correlation/timeout half |
| **shttpHandler** | `(Request) → Promise<Response>` calling `dispatch()` | The 1038-LOC SHTTP transport's core |
| **SessionCompat** | Bounded LRU `{sessionId → version}` | `Transport.sessionId` + SHTTP `_initialized` |
| **BackchannelCompat** | Per-session `{requestId → resolver}` for server→client over SSE | `_streamMapping` + `relatedRequestId` |

SessionCompat and BackchannelCompat hold all 2025-11 stateful behavior. When that protocol version sunsets and MRTR is the floor, they're deleted and `shttpHandler` is fully stateless.

---

## Compatibility

**Existing SHTTP code does not change.** This:

```ts
const t = new NodeStreamableHTTPServerTransport({sessionIdGenerator: () => randomUUID()});
await mcp.connect(t);
app.all('/mcp', (req, res) => t.handleRequest(req, res, req.body));
```

works exactly as before. The transport class constructs `SessionCompat`/`BackchannelCompat` internally from the options you already pass; `handleRequest` calls `shttpHandler` under the hood. Same wire behavior, same options, no code change.

`Protocol` and `Server` stay as back-compat shims for direct subclassers. Stdio/WS unchanged.

---

## Wins

**Stateless becomes one line.**
```ts
const mcp = new McpServer({name: 'hello', version: '1'});
mcp.registerTool('greet', ..., ...);
app.post('/mcp', c => mcp.handleHttp(c.req.raw));
```
One server at module scope, called per request. No transport instance, no `connect`, no per-request construction.

**Handlers are testable without a transport.**
```ts
const result = await mcp.dispatchToResponse({jsonrpc:'2.0', id:1, method:'tools/list'});
```

**2025-11 state is deletable.** Two named files (`SessionCompat`, `BackchannelCompat`) instead of branches through one transport. When 2025-11 sunsets, delete them.

**HTTP-shaped transports stop pretending to be pipes.** No `_streamMapping`, no body-sniffing for `initialize`, no fake `start()`. SHTTP transport drops from 1038 to ~290 LOC.

**Custom transports get a request-shaped option.** gRPC/Lambda/CF Workers can call `dispatch()` directly instead of implementing a fake pipe.

---

The reference implementation passes all SDK tests, conformance (40/40 server, 317/317 client), and 14/14 consumer typecheck after the existing v2 back-compat PRs. See the [WALKTHROUGH](./WALKTHROUGH.md) for a code-level walk through the current pain and the fix.
