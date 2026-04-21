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

The shipped stateless example constructs a fresh server and transport per request ([`examples/server/src/simpleStatelessStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/7bb79ebbbba88a503851617d053b13d8fd9228bb/examples/server/src/simpleStatelessStreamableHttp.ts#L99-L111)):

```ts
app.post('/mcp', async (req, res) => {
    const server = getServer();                            // McpServer + all registrations
    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined                      // opt-out flag
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
        transport.close();
        server.close();
    });
});
```

A module-scope version (one server, one transport, `sessionIdGenerator: undefined`) does work, but the example doesn't use it — and the request still goes through the pipe-shaped path either way.

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

| Piece | What it does | Replaces |
|---|---|---|
| **Dispatcher** | Knows which handler to call for which method. You register handlers (`setRequestHandler('tools/list', fn)`); `dispatch(request)` looks one up, runs it, returns the output. Doesn't know how the request arrived or where the response goes. | Protocol's handler-registry half |
| **StreamDriver** | Runs a Dispatcher over a persistent connection (stdio, WebSocket). Reads from the pipe → `dispatch()` → writes back. Owns the per-connection state: response correlation, timeouts, debounce. One per pipe; the Dispatcher it wraps can be shared. | Protocol's correlation/timeout half |
| **shttpHandler** | Runs a Dispatcher over HTTP. Takes a web `Request`, parses the body, calls `dispatch()`, streams the result as a `Response`. A function you mount on a router, not a class you connect. | The 1038-LOC SHTTP transport's core |
| **SessionCompat** | Remembers session IDs across HTTP requests. 2025-11 servers mint an ID on `initialize` and validate it on every later request — this is the bounded LRU that does that. Pass it to `shttpHandler` for 2025-11 clients; omit it for stateless. | `Transport.sessionId` + SHTTP `_initialized` |
| **BackchannelCompat** | Lets a tool handler ask the client a question mid-call (`ctx.elicitInput()`) over HTTP. 2025-11 does this by writing the question into the still-open SSE response and waiting for the client to POST the answer back; this holds the "waiting for answer N" table. Under MRTR the same thing is a return value, so this gets deleted. | `_streamMapping` + `relatedRequestId` |

The last two are the only places 2025-11 stateful behavior lives. They're passed to `shttpHandler` as options; without them it's pure request→response.

### Middleware

`Dispatcher.use(mw)` registers generator middleware that wraps every `dispatch()`:

```ts
mcp.use(next => async function* (req, env) {
    // before handler
    for await (const out of next(req, env)) {
        // around each notification + the response
        yield out;
    }
    // after
});
```

Runs for every method (including `initialize`), regardless of transport. Short-circuit (auth reject, cache hit), transform outputs, time the call. A small `onMethod('tools/list', fn)` helper gives typed per-method post-processing without the `if (req.method === ...)` boilerplate.

### Transport interfaces

`Transport` is renamed `ChannelTransport` (the pipe shape: `start/send/onmessage/close`). `Transport` stays as a deprecated alias. A second internal shape, `RequestTransport`, is what the SHTTP server transport implements — it doesn't pretend to be a pipe. `connect()` accepts both and picks the right adapter via an explicit `kind: 'channel' | 'request'` brand on the transport.

---

## Compatibility

**Existing stateful SHTTP code does not change:**

```ts
const t = new NodeStreamableHTTPServerTransport({sessionIdGenerator: () => randomUUID()});
await mcp.connect(t);
app.all('/mcp', (req, res) => t.handleRequest(req, res, req.body));
```

Same options, same wire behavior — sessions are minted on `initialize`, validated on every later request, `transport.sessionId` is populated, `onsessioninitialized`/`onsessionclosed` fire, `ctx.elicitInput()` works mid-tool-call. Under the hood the transport class constructs a `SessionCompat` and `BackchannelCompat` from those options and routes `handleRequest` through `shttpHandler`. The session-ful behavior is identical; the implementation is the new path.

**Existing stdio code does not change:**

```ts
const t = new StdioServerTransport();
await mcp.connect(t);
```

`connect()` sees a channel-shaped transport and builds a `StreamDriver(mcp, t)` internally — which reads stdin, calls `dispatch()`, writes stdout. The stdio transport class itself is unchanged (it was always just a pipe wrapper); what's different is that the read-dispatch-write loop now lives in `StreamDriver` instead of `Protocol`.

`Protocol` and `Server` stay as back-compat shims for direct subclassers (ext-apps).

---

## Client side

The same split applies. `Client extends Dispatcher` — its registry holds the handlers for requests the *server* sends (`elicitation/create`, `sampling/createMessage`, `roots/list`). When one arrives, `dispatch()` routes it.

For outbound (`callTool`, `listTools`, etc.), Client uses a `ClientTransport`:

```ts
interface ClientTransport {
    fetch(req: JSONRPCRequest, opts?): Promise<JSONRPCResponse>;  // request → response
    notify(n: Notification): Promise<void>;
    close(): Promise<void>;
}
```

This is the request-shaped mirror of the server side: `fetch` is one request → one response.

```
                ┌───────────────────────────────────────┐
                │ Client extends Dispatcher             │
                │  inbound:  dispatch() for elicit/     │
                │            sampling/roots             │
                │  outbound: callTool →                 │
                │            _clientTransport.fetch(req)│
                └─────────────────┬─────────────────────┘
                                  │ _clientTransport is ONE of:
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
        ┌───────────────────────┐     ┌────────────────────────────────┐
        │ pipeAsClientTransport │     │ StreamableHTTPClientTransport  │
        │ (wraps a channel via  │     │ (implements ClientTransport    │
        │  StreamDriver)        │     │  directly: POST → Response)    │
        │ stdio, WS, InMem      │     │ SHTTP                          │
        └───────────────────────┘     └────────────────────────────────┘
```

**Over HTTP:** `StreamableHTTPClientTransport.fetch` POSTs the request and reads the response (SSE or JSON). If the server writes a JSON-RPC *request* into that SSE stream (2025-11 elicitation), the transport calls `opts.onrequest(r)` — which Client wires to `this.dispatch(r)` — and POSTs the answer back. Same flow as today, request-shaped underneath.

**Over stdio:** `pipeAsClientTransport(stdioTransport)` wraps the channel in a StreamDriver and exposes `{fetch, notify, close}`. `fetch` becomes "send over the pipe, await the correlated response."

**MRTR (SEP-2322):** the stateless server→client path. Instead of the held-stream backchannel, the server *returns* `{input_required, requests: [...]}` as the `tools/call` result. Client sees that, services each request via its own `dispatch()`, and re-sends `tools/call` with the answers attached. No held stream, works over any transport. Client's `_request` runs this loop transparently — `await client.callTool(...)` looks the same to the caller whether the server used the backchannel or MRTR.

**Compat:** `client.connect(transport)` keeps working with both `ChannelTransport` and `ClientTransport`. Existing code (`new StreamableHTTPClientTransport(url)` + `connect`) is unchanged.

---

## Wins

**Stateless without the opt-out.** Today's stateless is `sessionIdGenerator: undefined` — a flag that opts you out of session handling but leaves the request going through the pipe-shaped path (`onmessage → dispatch → send → _streamMapping` lookup). It's stateless at the wire but not in the code: concurrent requests still share a `_streamMapping` table on the transport instance, the transport still parses bodies looking for `initialize`, and the shipped example constructs everything per-request because the module-scope version isn't obviously safe. After:
```ts
import { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';

const mcp = new McpServer({name: 'hello', version: '1.0.0'});
mcp.registerTool('greet', {description: 'Say hello'}, async () => ({
    content: [{type: 'text', text: 'hello'}]
}));

const app = new Hono();
app.post('/mcp', c => mcp.handleHttp(c.req.raw));
```
No transport class, no `connect`, no flag. The path is `parse → dispatch → respond`.

**Handlers are testable without a transport.** Today, unit-testing a tool handler means an `InMemoryTransport` pair, two `connect()` calls, and a client to drive it. After:
```ts
const mcp = new McpServer({name: 'test', version: '1.0.0'});
mcp.registerTool('greet', {description: '...'}, async () => ({
    content: [{type: 'text', text: 'hello'}]
}));

const out = await mcp.dispatchToResponse({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'greet', arguments: {}}
});
expect(out.result.content[0].text).toBe('hello');
```
The HTTP layer is testable the same way — `await shttpHandler(mcp)(new Request('http://test/mcp', {method: 'POST', body: ...}))` returns a `Response` you can assert on, no server to spin up.

**Method-level middleware.** There's no per-method hook today — auth is HTTP-layer (`requireBearerAuth` checks the bearer token before MCP parsing), and to log/trace/rate-limit by MCP method you'd wrap each handler manually. `Dispatcher.use(mw)` wraps every dispatch including `initialize`:
```ts
mcp.use(next => async function* (req, env) {
    const start = Date.now();
    yield* next(req, env);
    metrics.timing('mcp.method', Date.now() - start, {method: req.method});
});
```
(Python's FastMCP ships ten middleware modules — auth, caching, rate-limiting, tracing — and had to subclass an SDK-private method to intercept `initialize`. That's the demand signal; `use()` is the hook.)

**Pluggable transports stop paying the pipe tax.** A gRPC/WebTransport/Lambda integration today has to implement `{start, send, onmessage, close}` and reconstruct request→response on top. After, request-shaped transports call `dispatch()` directly; only genuinely persistent channels (stdio, WebSocket) implement `ChannelTransport`.

**Extensions plug in cleanly.** Tasks (and later sampling/roots when they move to `ext-*` packages) attach via `mcp.use(tasksMiddleware(store))` instead of being wired into Protocol. The core SDK doesn't import them.

**2025-11 state is deletable.** Two named files instead of `if (sessionIdGenerator)` branches through one transport. The sunset is `git rm sessionCompat.ts backchannelCompat.ts`, not a hunt.

**Protocol stops being a god class.** Today `Protocol` (~1100 LOC) is registry + correlation + timeouts + capabilities + tasks + connect, abstract, with both Server and Client extending it. Tracing a request means bouncing between Protocol, Server, and McpServer. After: Dispatcher does routing, StreamDriver does per-connection state, McpServer does MCP semantics. Each file has one job; you can read one without the others.

**The SHTTP server transport class drops from 1038 to ~290 LOC.** New server code doesn't need the class at all (`handleHttp` is the entry). The class still exists for back-compat — existing code that does `new NodeStreamableHTTPServerTransport(...)` keeps working — but it's now a thin shim that constructs `shttpHandler` internally. No `_streamMapping`, no body-sniffing for `initialize`, no fake `start()`. (Client-side still needs a transport instance — it has to know where to send. `StreamableHTTPClientTransport` stays, just request-shaped underneath.)

---

The reference implementation passes all SDK tests, conformance (40/40 server, 317/317 client), and 14/14 consumer typecheck after the existing v2 back-compat PRs. See the [WALKTHROUGH](./WALKTHROUGH.md) for a code-level walk through the current pain and the fix.
