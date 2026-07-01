---
shape: how-to
---

# Support legacy clients

A **legacy client** speaks a 2025-era protocol revision: it opens with `initialize` and sends no per-request `_meta` envelope. Both serving entry points answer those clients from the same factory that serves modern ones; the `legacy` option decides whether they keep doing it. [Protocol versions](../protocol-versions.md) covers the era model itself.

## Choose a legacy posture

[`createMcpHandler`](./http.md) has two postures. The default, `legacy: 'stateless'`, serves each legacy request from a fresh instance out of your factory, with no sessions. `legacy: 'reject'` makes the endpoint modern-only.

```ts source="../../examples/guides/serving/legacy-clients.examples.ts#createMcpHandler_legacyReject"
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const buildServer = () => new McpServer({ name: 'notes', version: '1.0.0' });

const strict = createMcpHandler(buildServer, { legacy: 'reject' });
```

A 2025-era `initialize` POST to the strict handler gets HTTP `400` and the unsupported-protocol-version error naming the one revision the endpoint serves:

```
400
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32022,
    "message": "Unsupported protocol version: 2025-06-18",
    "data": {
      "supported": [
        "2026-07-28"
      ],
      "requested": "2025-06-18"
    }
  },
  "id": 1
}
```

Drop the option and the same request gets a normal 2025 `InitializeResult` from a fresh instance, torn down when the exchange ends. Per request means no sessions: under the default posture a legacy `GET` (the standalone SSE stream) and `DELETE` (session termination) answer `405 Method not allowed.` — a client that needs those needs the routing below.

::: tip
A strict endpoint still acknowledges legacy-classified notification POSTs with `202` — and then drops them. Legacy `GET` and `DELETE` answer `405` there too.
:::

## Choose the same posture on stdio

[`serveStdio`](./stdio.md) takes the same option with a different default — `'serve'` — and applies it once per connection, not per request.

```ts source="../../examples/guides/serving/legacy-clients.examples.ts#serveStdio_legacyReject"
serveStdio(buildServer, { legacy: 'reject' });
```

Under `'serve'` a 2025-era opening pins the connection to a legacy instance from your factory and serves it exactly as a hand-wired stdio server would. Under `'reject'` the entry answers the opening with the same unsupported-protocol-version error and keeps the connection open for a modern opening.

## Keep a sessionful 2025 deployment running

Neither entry point accepts a handler as the `legacy` value. To keep an existing sessionful deployment serving the 2025 clients it already has, route in front of a strict handler with `isLegacyRequest` — the entry's own classification step exported as a predicate, so the branch never disagrees with `createMcpHandler`.

```ts source="../../examples/guides/serving/legacy-clients.examples.ts#isLegacyRequest_route"
import { isLegacyRequest, legacyStatelessFallback } from '@modelcontextprotocol/server';

const legacy = legacyStatelessFallback(buildServer);

async function serve(request: Request): Promise<Response> {
    if (await isLegacyRequest(request)) {
        return legacy(request);
    }
    return strict.fetch(request);
}
```

`legacyStatelessFallback(factory)` is the entry's default legacy serving as a standalone handler — it holds the legacy leg's place here. Put your existing wiring there instead and it keeps its sessions, its event store, and its clients: [`legacy-routing/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/legacy-routing/server.ts) runs a sessionful `StreamableHTTPServerTransport` deployment behind this exact branch. Route every `false` to the strict handler — the modern path owns the error answers for malformed modern requests.

The `initialize` the strict handler rejected above now completes the 2025 handshake on the legacy leg:

```
200
{
  protocolVersion: '2025-06-18',
  capabilities: {},
  serverInfo: { name: 'notes', version: '1.0.0' }
}
```

::: tip
Behind an Express body parser the Node stream is already drained: build the `Request` the predicate takes with `toWebRequest(req, req.body)` from `@modelcontextprotocol/node`.
:::

## Serve elicitation to 2025-era HTTP clients

Per-request legacy serving has no return path for server→client requests, so a tool that asks for input mid-call answers a **2025-era HTTP client** with an error result instead. The same tool serves its interactive rounds to 2026-07-28 clients as [`input_required` round trips](../servers/input-required.md), and to legacy clients over stdio, where the connection is the session.

Stay on the default posture until the 2025-era HTTP clients you serve need elicitation — [sampling is deprecated](../servers/sampling.md) as of 2026-07-28. To serve those rounds, mint a session for the legacy `initialize`: one transport connected to one instance from your factory, with every request that carries its `Mcp-Session-Id` routed back to that pair.

```ts source="../../examples/guides/serving/legacy-clients.examples.ts#isLegacyRequest_sessions"
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

const handler = createMcpHandler(buildServer);
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

async function serveWithSessions(request: Request): Promise<Response> {
    // Session traffic goes to the transport that owns the session.
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId !== null) {
        const transport = sessions.get(sessionId);
        if (!transport) return new Response('Unknown or expired session', { status: 404 });
        return transport.handleRequest(request);
    }

    // A legacy `initialize` opens a session: its own transport, its own instance.
    const body: unknown =
        request.method === 'POST'
            ? await request
                  .clone()
                  .json()
                  .catch(() => {})
            : undefined;
    const looksLikeInitialize = typeof body === 'object' && body !== null && 'method' in body && body.method === 'initialize';
    if (looksLikeInitialize && (await isLegacyRequest(request, body))) {
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: id => {
                sessions.set(id, transport);
            }
        });
        // Set before connect: the server chains an onclose that is already on the transport.
        transport.onclose = () => {
            if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
        };
        await buildServer().connect(transport);
        const response = await transport.handleRequest(request);
        // A refused handshake mints no session: close, or the pair leaks until process exit.
        if (transport.sessionId === undefined) await transport.close();
        return response;
    }

    // Everything else — modern traffic and legacy one-shots — rides the entry.
    return handler.fetch(request, body === undefined ? undefined : { parsedBody: body });
}
```

`isLegacyRequest` decides whether the request is legacy at all; the `method` peek only narrows which legacy requests open a session. An `initialize` that carries the modern envelope (or names a modern revision in its `MCP-Protocol-Version` header) belongs to the modern path's validation ladder, and a bare method sniff would mint it a 2025 session instead. The already-parsed body goes to the predicate as its second argument, which skips the predicate's internal body clone.

One transport is one session, and the transport's `onclose` — set before `connect`, which chains it — is where the registry entry dies. Never share a transport or a server instance across sessions.

::: tip
Bound the registry: cap concurrent sessions and evict idle ones — an unauthenticated `initialize` is all it takes to allocate a transport and a server instance. [`todos-server/worker.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/todos-server/worker.ts) does both and runs this exact hybrid on Cloudflare Workers, with the registry in a per-visitor Durable Object.
:::

Unknown session ids answer `404` and the client re-initializes; `DELETE` tears the session down through that same `onclose`. [Sessions, state, and scaling](./sessions-state-scaling.md) covers the lifecycle, resumability, and scaling; the [`cli-client`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/cli-client/README.md) e2e drives elicitation rounds over exactly this hybrid.

## Know where SSE went

The v2 server never serves the HTTP+SSE transport. An SSE server moving to v2 moves to Streamable HTTP — `createMcpHandler` above — as part of the [v2 upgrade](../migration/upgrade-to-v2.md).

The client side keeps `SSEClientTransport`, so a v2 `Client` still reaches old SSE servers. For a server deployment that cannot move yet, a frozen v1 copy of the transport ships as `@modelcontextprotocol/server-legacy/sse` (deprecated).

## Recap

- Both entry points serve 2025-era clients from the same factory by default; `legacy: 'reject'` makes an endpoint modern-only.
- The default HTTP posture is per request and stateless: legacy `GET` and `DELETE` session operations answer `405`.
- `serveStdio` decides the era once per connection; its default is `'serve'`.
- `isLegacyRequest` in front of a strict handler keeps an existing sessionful 2025 deployment serving its clients.
- The default posture answers 2025-era HTTP clients per request, with no channel for server-initiated messages; a session minted for the legacy `initialize` — classified by `isLegacyRequest`, never a method sniff — restores elicitation.
- The v2 server never serves SSE; the frozen v1 transport is `@modelcontextprotocol/server-legacy/sse`, and the client keeps `SSEClientTransport`.
