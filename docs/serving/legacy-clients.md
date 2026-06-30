---
status: scaffold
shape: how-to
---
# Support legacy clients

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: The legacy: option; where SSE went.
teaches: CreateMcpHandlerOptions.legacy ('stateless' | 'reject'), ServeStdioOptions.legacy ('serve' | 'reject'), isLegacyRequest, legacyStatelessFallback, @modelcontextprotocol/server-legacy/sse
source: mined from docs/server.md "Serving the 2026-07-28 draft revision over HTTP" Options + routing paragraphs; docs/faq.md "Why did we remove server SSE transport?"; examples/legacy-routing/, examples/dual-era/
-->

## Choose a legacy posture
<!-- teaches: legacy: 'stateless' (default — 2025 clients served per request from the same factory) vs 'reject' (modern-only strict) | salvage: docs/server.md "Options:" paragraph under createMcpHandler -->

```ts
// draft - API verified against packages/server/src/server/createMcpHandler.ts (CreateMcpHandlerOptions.legacy: 'stateless' | 'reject')
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(
  () => new McpServer({ name: 'notes', version: '1.0.0' }),
  { legacy: 'reject' },
);
```
<!-- result: one line — a 2025-era request gets the unsupported-protocol-version error naming the supported revisions; modern traffic is unaffected -->
<!-- aside: what "legacy" means is one line linking /protocol-versions -->

## Choose the same posture on stdio
<!-- teaches: ServeStdioOptions.legacy ('serve' default | 'reject'); the era is pinned once per connection | salvage: docs/server.md "Options:" paragraph under serveStdio -->
<!-- code: serveStdio(factory, { legacy: 'reject' }) -->

## Keep a sessionful 2025 deployment running
<!-- teaches: there is no handler-valued legacy option — route in user land with isLegacyRequest in front of a strict handler and hand legacy traffic to your existing wiring (or legacyStatelessFallback) | salvage: docs/server.md "To keep an existing sessionful 2025 deployment..." paragraph; examples/legacy-routing/server.ts, examples/dual-era/server.ts -->
<!-- code: if (isLegacyRequest(body)) return legacyHandler(request); return strict.fetch(request); -->

## Know where SSE went
<!-- teaches: the v2 server does not serve the HTTP+SSE (2024) transport; the client keeps SSEClientTransport to reach old servers; a frozen v1 copy lives at @modelcontextprotocol/server-legacy/sse — migrate to Streamable HTTP | salvage: docs/faq.md "Why did we remove server SSE transport?" -->
<!-- code: none — one migration link to /migration/upgrade-to-v2 -->

## Recap
<!-- the claims this page proves:
- Both entries serve 2025 clients from the same factory by default; 'reject' makes them modern-only.
- 'stateless' legacy serving is per-request: 2025 GET/DELETE session operations answer 405.
- An existing sessionful deployment keeps working behind isLegacyRequest routing.
- v2 never serves SSE; the frozen transport lives in @modelcontextprotocol/server-legacy/sse.
-->
