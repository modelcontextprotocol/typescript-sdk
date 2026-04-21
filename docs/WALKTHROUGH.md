# Walkthrough: why the SDK fights stateless, and how to fix it

This is a code walk, not a spec. I'm going to start in the current SDK, show where it hurts, and then show what the same thing looks like after the proposed split. The RFC has the formal proposal; this is the "let me show you" version.

---

## Part 1: The current code

### Start at the only entrance

There is exactly one way to make an MCP server handle requests:

```ts
// packages/core/src/shared/protocol.ts:437
async connect(transport: Transport): Promise<void> {
    this._transport = transport;
    transport.onmessage = (message, extra) => {
        // route to _onrequest / _onresponse / _onnotification
    };
    await transport.start();
}
```

You hand it a long-lived `Transport`, it takes over the `onmessage` callback, and from then on requests arrive asynchronously. There is no `handle(request) → response`. If you want to call a handler, you go through a transport.

`Transport` is shaped like a pipe:

```ts
// packages/core/src/shared/transport.ts:8
interface Transport {
    start(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
    onmessage?: (message, extra) => void;
    close(): Promise<void>;
    sessionId?: string;
    setProtocolVersion?(v: string): void;
}
```

`start`/`close` for lifecycle, fire-and-forget `send`, async `onmessage` callback. That's stdio's shape. It's also the shape every transport must implement, including HTTP.

### Follow an HTTP request through

The Streamable HTTP server transport is `packages/server/src/server/streamableHttp.ts` — 1038 lines. Let's follow a `tools/list` POST:

1. User's Express handler calls `transport.handleRequest(req, res, body)` (line 176)
2. `handlePostRequest` validates headers (217-268), parses body (282)
3. Now it has a JSON-RPC request and needs to get it to the dispatcher. But the only path is `onmessage`. So it... calls `this.onmessage?.(msg, extra)` (370). Fire and forget.
4. `Protocol._onrequest` runs the handler, gets a result, builds a response, calls `this._transport.send(response)` (634)
5. Back in the transport, `send(response)` needs to find *which* HTTP response stream to write to. It looks up `_streamMapping[streamId]` (756) using a `relatedRequestId` that was threaded through.

So the transport keeps a table mapping in-flight request IDs to open `Response` writers (`_streamMapping`, `_requestToStreamMapping`, ~80 LOC of bookkeeping), because `send()` is fire-and-forget and the response has to find its way back to the right HTTP response somehow.

This is the core impedance mismatch: **HTTP is request→response, but the only interface is pipe-shaped, so the transport reconstructs request→response correlation on top of a pipe abstraction that sits on top of HTTP's native request→response.**

### The session sniffing

The transport also has to know about `initialize`:

```ts
// streamableHttp.ts:323
if (isInitializeRequest(body)) {
    if (this._sessionIdGenerator) {
        this.sessionId = this._sessionIdGenerator();
        // ... onsessioninitialized callback
    }
    this._initialized = true;
}
```

A transport — whose job should be "bytes in, bytes out" — is parsing message bodies to detect a specific MCP method so it knows when to mint a session ID. There are 18 references to `initialize` in this file. The transport knows about the protocol's handshake.

### What "stateless" looks like today

The protocol direction (SEP-2575/2567) is: no `initialize`, no sessions, each request is independent. You can do this today with a module-scope transport:

```ts
const t = new NodeStreamableHTTPServerTransport({sessionIdGenerator: undefined});
await mcp.connect(t);
app.all('/mcp', (req, res) => t.handleRequest(req, res, req.body));
```

`sessionIdGenerator: undefined` is the opt-out — it makes `handleRequest` skip the session-ID minting/validation branches in the transport. The request still goes through the pipe-shaped path (`onmessage → _onrequest → handler → send → _streamMapping` lookup), but without sessions the mapping is just per-in-flight-request.

It works. It's not obvious — you have to know that `undefined` is the flag, that `connect()` is still needed, and that the transport class is doing pipe-correlation under a request/response API. (The shipped example actually constructs the transport per-request, which is unnecessary but suggests the authors weren't confident in the module-scope version either.)

### Why is Protocol 1100 lines?

`protocol.ts` is the abstract base for both `Server` and `Client`. It does:

- handler registry (`_requestHandlers`, `setRequestHandler`)
- outbound request/response correlation (`_responseHandlers`, `_requestMessageId`)
- timeouts (`_timeoutInfo`, `_setupTimeout`, `_resetTimeout`)
- progress callbacks (`_progressHandlers`)
- debounced notifications (`_pendingDebouncedNotifications`)
- cancellation (`_requestHandlerAbortControllers`)
- TaskManager binding (`_bindTaskManager`)
- 4 abstract `assert*Capability` methods subclasses must implement
- `connect()` — wiring all of the above to a transport

Some of those are per-connection state (correlation, timeouts, debounce). Some are pure routing (handler registry). Some are protocol semantics (capabilities). They're fused, so you can't get at the routing without the connection state.

When you trace a request through, you bounce between `Protocol._onrequest`, `Server.buildContext`, `McpServer`'s registry handlers, back to `Protocol`'s send path. Three classes, two levels of inheritance. (Python folks will recognize this — "is BaseSession or ServerSession handling this line?")

---

## Part 2: The proposed split

### The primitive

```ts
class Dispatcher {
    setRequestHandler(method, handler): void;
    dispatch(req: JSONRPCRequest, env?: RequestEnv): AsyncIterable<DispatchOutput>;
}
```

A `Map<method, handler>` and a function that looks up + calls. `dispatch` yields zero-or-more notifications then exactly one response (matching SEP-2260's wire constraint). `RequestEnv` is per-request context the caller provides — `{sessionId?, authInfo?, signal?, send?}`. No transport. No connection state. ~270 LOC.

That's it. You can call `dispatch` from anywhere — a test, a Lambda, a loop reading stdin.

### The channel adapter

For stdio/WebSocket/InMemory — things that *are* persistent pipes — `StreamDriver` wraps a `ChannelTransport` and a `Dispatcher`:

```ts
class StreamDriver {
    constructor(dispatcher, channel) { ... }
    start() {
        channel.onmessage = msg => {
            for await (const out of dispatcher.dispatch(msg, env)) channel.send(out);
        };
    }
    request(req): Promise<Result>;  // outbound, with correlation/timeout
}
```

This is where Protocol's per-connection half goes: `_responseHandlers`, `_timeoutInfo`, `_progressHandlers`, debounce. One driver per pipe; the dispatcher it wraps can be shared. ~450 LOC.

`connect(channelTransport)` builds one of these. So `connect` still works exactly as before for stdio.

### The request adapter

For HTTP — things that are *not* persistent pipes — `shttpHandler`:

```ts
function shttpHandler(dispatcher, opts?): (req: Request) => Promise<Response> {
    return async (req) => {
        const body = await req.json();
        const stream = sseStreamFrom(dispatcher.dispatch(body, env));
        return new Response(stream, {headers: {'content-type': 'text/event-stream'}});
    };
}
```

Parse → `dispatch` → stream the AsyncIterable as SSE. ~400 LOC including header validation, batch handling, EventStore replay. No `_streamMapping` — the response stream is just in lexical scope.

`mcp.handleHttp(req)` is McpServer's convenience wrapper around this.

### The deletable parts

`SessionCompat` — bounded LRU `{sessionId → negotiatedVersion}`. If you pass it to `shttpHandler`, the handler validates `mcp-session-id` headers and mints IDs on `initialize`. If you don't, it doesn't. ~200 LOC.

`BackchannelCompat` — per-session `{requestId → resolver}` so a tool handler can `await ctx.elicitInput()` and the response comes back via a separate POST. The 2025-11 server→client-over-SSE behavior. ~140 LOC.

These two are the *only* places 2025-11 stateful behavior lives. When that protocol version sunsets and MRTR (SEP-2322) is the floor, delete both files; `shttpHandler` is fully stateless.

### Same examples, after

```ts
// stateless — one server, no transport instance
const mcp = new McpServer({name: 'hello', version: '1'});
mcp.registerTool('greet', ..., ...);
app.post('/mcp', c => mcp.handleHttp(c.req.raw));
```

```ts
// 2025-11 stateful — same server, opt-in session
const session = new SessionCompat({sessionIdGenerator: () => randomUUID()});
app.all('/mcp', toNodeHttpHandler(shttpHandler(mcp, {session})));
```

```ts
// stdio — unchanged from today
const t = new StdioServerTransport();
await mcp.connect(t);
```

```ts
// the existing v1 pattern — also unchanged
const t = new NodeStreamableHTTPServerTransport({sessionIdGenerator: () => randomUUID()});
await mcp.connect(t);
app.all('/mcp', (req, res) => t.handleRequest(req, res, req.body));
// (internally, t.handleRequest now calls shttpHandler — same wire behavior)
```

---

## Part 3: What you get

**The stateless server is one line.** One `McpServer` at module scope, `handleHttp` per request. The per-request build-and-tear-down workaround is gone.

**Handlers are testable without a transport.** `await mcp.dispatchToResponse({...})` — no `InMemoryTransport` pair, no `connect`.

**The SHTTP transport drops from 1038 to ~290 LOC.** No `_streamMapping` (the response stream is in lexical scope), no body-sniffing for `initialize` (SessionCompat handles it), no fake `start()`.

**2025-11 protocol state lives in two named files.** When that version sunsets, delete `SessionCompat` and `BackchannelCompat`; `shttpHandler` is fully stateless. Today the same logic is `if (sessionIdGenerator)` branches scattered through one transport.

**Existing code doesn't change.** `new NodeStreamableHTTPServerTransport({...})` + `connect(t)` + `t.handleRequest(...)` works exactly as before — the class builds the compat pieces internally from the options you already pass.

---

*Reference implementation on [`fweinberger/ts-sdk-rebuild`](https://github.com/modelcontextprotocol/typescript-sdk/tree/fweinberger/ts-sdk-rebuild). See the [RFC](./rfc-stateless-architecture.md) for the formal proposal.*
