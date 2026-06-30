---
status: scaffold
shape: how-to
---
# Sessions, state, and scaling

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Sessions, Resumability, Multi-node — stateless ruling first, two sentences.
teaches: the stateless-by-default ruling (createMcpHandler), sessionIdGenerator, EventStore/eventStore, ServerEventBus (multi-node listen), the three deployment topologies
source: mined from docs/server.md "Streamable HTTP" Options paragraph + "Shutdown"; examples/README.md "Multi-node deployment patterns"
NOTE: the three H2 titles below are VERBATIM per the approved proposal (§1 + Appendix A "sessions H2s verbatim") — Felix ruling; this page is the one sanctioned exception to imperative micro-step headings, and to the 4-H2 floor.
-->

<!-- opening (before any H2), exactly two sentences — the stateless ruling:
`createMcpHandler` builds a fresh server instance per request and holds nothing between requests, so a v2 HTTP server is stateless and horizontally scalable by default. Read on only if you run a sessionful 2025-era deployment or need cross-request state. -->

## Sessions
<!-- teaches: sessionIdGenerator (stateful) vs undefined (stateless); sessions are a 2025-era hand-wired-transport concept | salvage: docs/server.md "Streamable HTTP" Options paragraph; examples/legacy-routing/server.ts -->

```ts
// draft - API verified against packages/middleware/node/src/streamableHttp.ts (NodeStreamableHTTPServerTransport, StreamableHTTPServerTransportOptions.sessionIdGenerator)
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { randomUUID } from 'node:crypto';

const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
```
<!-- result: one line — responses carry an Mcp-Session-Id header and the client replays it on every request -->
<!-- code (follow-up placeholder): the per-session transports map + routing by Mcp-Session-Id (salvage: examples/legacy-routing/server.ts, docs/server.md "Shutdown" transports map) -->

## Resumability
<!-- teaches: EventStore / the eventStore transport option; replaying missed SSE events after a dropped connection | salvage: examples/README.md "Persistent storage mode"; examples/shared/src/inMemoryEventStore.ts; examples/sse-polling/ -->
<!-- code: new NodeStreamableHTTPServerTransport({ sessionIdGenerator, eventStore }) -->

## Multi-node
<!-- teaches: the three topologies — stateless (default, nothing to do), persistent storage (shared eventStore), pub/sub message routing; for subscriptions/listen across nodes, pass a shared ServerEventBus to createMcpHandler({ bus }) | salvage: examples/README.md "Multi-node deployment patterns" (all three ASCII diagrams collapse to prose here) -->
<!-- code: createMcpHandler(factory, { bus: myDistributedBus }) -->

## Recap
<!-- the claims this page proves:
- createMcpHandler is stateless per request; multi-node needs no session affinity.
- Sessions belong to hand-wired 2025-era transports: sessionIdGenerator turns them on.
- An EventStore makes a dropped SSE stream resumable from any node that shares it.
- subscriptions/listen scales across nodes by sharing one ServerEventBus.
-->
