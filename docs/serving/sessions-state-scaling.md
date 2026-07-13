---
shape: how-to
---
# Sessions, state, and scaling

`createMcpHandler` builds a fresh server instance from your factory for every HTTP request and holds nothing between requests, so a v2 server is stateless and scales horizontally by default — [Serve over HTTP](./http.md) is the whole setup. Read on if you run a sessionful 2025-era deployment, need a dropped stream to resume, or push change notifications across nodes.

## Pin a client to a session

A **session** pins a client to one long-lived transport instance; sessions belong to the hand-wired 2025-era transport — the 2026-07-28 revision is per-request and has no `Mcp-Session-Id` ([Protocol versions](../protocol-versions.md)). On `NodeStreamableHTTPServerTransport`, `sessionIdGenerator` turns sessions on; leaving it `undefined` is stateless mode. A stateless transport serves exactly one request exchange; construct a fresh transport + server pair per request — reuse throws. For stateless HTTP hosting prefer `createMcpHandler`, which builds the per-request pair for you.

```ts source="../../examples/guides/serving/sessions-state-scaling.examples.ts#sessions_stateful"
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { randomUUID } from 'node:crypto';

const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
});
```

The transport answers `initialize` with the generated id in an `Mcp-Session-Id` response header and rejects later requests that arrive without it. The SDK's `StreamableHTTPClientTransport` sends the header back on every request with no configuration.

One transport instance is one session, so a sessionful deployment keeps a map: build a transport when `initialize` arrives, store it in `onsessioninitialized`, and route every later request to the transport that owns its `Mcp-Session-Id`. This Express route handles all three verbs — `POST`, the `GET` notification stream, and `DELETE` ([Serve with Express](./express.md) covers the app itself).

```ts source="../../examples/guides/serving/sessions-state-scaling.examples.ts#sessions_routing"
const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

const route = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.handleRequest(req, res, req.body);
        return;
    }
    if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
                sessions.set(id, transport);
            }
        });
        transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await buildServer().connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
    }
    if (sessionId) {
        // Unknown session id: the client should start a new session.
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
    }
    // No session header on a non-initialize request: the request is malformed.
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Session ID required' }, id: null });
};

app.post('/mcp', route);
app.get('/mcp', route);
app.delete('/mcp', route);
```

The map cleans itself up: `transport.onclose` fires when the session ends, whether the client sent `DELETE` or you called `transport.close()`. A request with an unknown `Mcp-Session-Id` gets the `404` above, which tells the client to start a new session; a request with no session header at all gets the `400`, which tells it to re-send the id it already has instead of re-initializing.

::: tip
On shutdown, close every stored transport — `for (const [, transport] of sessions) await transport.close()` — before exiting; `close()` ends the session's SSE streams and rejects its pending requests.
:::

## Resume a dropped stream

A sessionful client holds a `GET` SSE stream open for server notifications, and anything sent while that connection is down is lost. An **event store** closes the gap: with one configured, the transport stamps every SSE message with an event id from the store before sending it.

`EventStore` is a two-method contract — `storeEvent(streamId, message)` persists a message and returns its event id; `replayEventsAfter(lastEventId, { send })` re-sends every later message on that stream. Implement it over storage every node can reach (`databaseEventStore` here) and pass it next to `sessionIdGenerator`.

```ts source="../../examples/guides/serving/sessions-state-scaling.examples.ts#resumability_eventStore"
const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore: databaseEventStore
});
```

When the connection drops, the client reconnects with the last event id it received as a `Last-Event-ID` header and the transport replays everything stored after it. The SDK's `StreamableHTTPClientTransport` reconnects and sends that header on its own.

::: tip
`examples/shared/src/inMemoryEventStore.ts` in the SDK repository is a complete `EventStore` reference implementation — in memory, so single-process only.
:::

## Scale across nodes

The stateless default is the scaling story: every node builds a fresh instance from the same factory and holds nothing between requests, so put the nodes behind any load balancer — no session affinity, nothing to share, nothing to configure.

Sessionful 2025-era nodes hold their sessions in process memory, so they scale two ways. **Persistent storage**: keep `sessionIdGenerator` and point every node at the same `eventStore`, so a dropped stream is resumable from any node that shares the store. **Local state with message routing**: keep per-node sessions and send each session's traffic to the node that owns it — load-balancer affinity, or pub/sub routing between nodes.

One thing still crosses nodes on a stateless deployment: `subscriptions/listen`. Its streams deliver the change events published on the handler's **`ServerEventBus`** ([Notifications](../servers/notifications.md)), and the default bus is in-process — `handler.notify.toolsChanged()` on node A never reaches a subscriber whose stream node B holds. Implement `ServerEventBus` over your pub/sub (`publish(event)` forwards to the broker; `subscribe(listener)` registers for events arriving from it) and hand one to every node's `createMcpHandler`.

```ts source="../../examples/guides/serving/sessions-state-scaling.examples.ts#multiNode_bus"
const handler = createMcpHandler(buildServer, { bus: redisBus });
```

Now `handler.notify.resourceUpdated(uri)` on any node publishes through the shared bus, and every node delivers the notification to its own open subscription streams.

## Recap

- `createMcpHandler` builds a fresh server per request and holds nothing between requests, so stateless nodes scale behind any load balancer with no session affinity.
- Sessions belong to the hand-wired 2025-era transport: `sessionIdGenerator` turns them on, and responses carry `Mcp-Session-Id`.
- A sessionful deployment keeps one transport per session and routes every request to it by that header; unknown ids get a `404`.
- An `eventStore` makes a dropped SSE stream resumable: the client reconnects with `Last-Event-ID` and the transport replays what it missed.
- `subscriptions/listen` scales across nodes by handing every node's `createMcpHandler` the same `ServerEventBus`.
