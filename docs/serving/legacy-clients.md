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

Under `'serve'` a 2025-era opening pins the connection to a legacy instance from your factory and serves it exactly as a hand-wired stdio server would. Under `'reject'` the opening is answered with the same unsupported-protocol-version error and the connection stays open for a modern opening.

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

## Know where SSE went

The v2 server never serves the HTTP+SSE transport. An SSE server moving to v2 moves to Streamable HTTP — `createMcpHandler` above — as part of the [v2 upgrade](../migration/upgrade-to-v2.md).

The client side keeps `SSEClientTransport`, so a v2 `Client` still reaches old SSE servers. For a server deployment that cannot move yet, a frozen v1 copy of the transport ships as `@modelcontextprotocol/server-legacy/sse` (deprecated).

## Recap

- Both entry points serve 2025-era clients from the same factory by default; `legacy: 'reject'` makes an endpoint modern-only.
- The default HTTP posture is per request and stateless: legacy `GET` and `DELETE` session operations answer `405`.
- `serveStdio` decides the era once per connection; its default is `'serve'`.
- `isLegacyRequest` in front of a strict handler keeps an existing sessionful 2025 deployment serving its clients.
- The v2 server never serves SSE; the frozen v1 transport is `@modelcontextprotocol/server-legacy/sse`, and the client keeps `SSEClientTransport`.
