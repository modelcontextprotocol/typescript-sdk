---
'@modelcontextprotocol/server': minor
---

Add `createMcpHandler(factory, { legacy?, onerror?, responseMode? })`, an HTTP entry point that serves the 2026-07-28 draft revision per request: each envelope-carrying request is classified once, served on a fresh instance from the factory bound to the claimed revision,
and answered with a JSON body or a lazily-upgraded SSE stream. 2025-era serving is selected with the `legacy` option (`'stateless'` — the default — for per-request stateless serving via the existing streamable HTTP transport, `'reject'` for a modern-only strict endpoint
that answers 2025-era requests with the unsupported-protocol-version error naming its supported revisions). The handler exposes a web-standard `fetch(request, { authInfo?, parsedBody? })` face and a duck-typed `node(req, res, parsedBody?)`
face, plus `close()` for tearing down in-flight modern exchanges. Also exported: `legacyStatelessFallback` (the same stateless legacy serving as a standalone fetch-shaped handler), the `PerRequestHTTPServerTransport` single-exchange transport and the
`classifyInboundRequest` classifier for hand-wired compositions, and the supporting types. `responseMode: 'json'` never streams and drops mid-call notifications (progress, logging and other related messages emitted before the result); listen-class subscription streams are
always served over SSE. The entry performs no Origin/Host validation (use the middleware packages) and no token verification — `authInfo` is pass-through and never derived from request headers.
