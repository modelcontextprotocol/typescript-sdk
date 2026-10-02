# json-response

`createMcpHandler({ responseMode: 'json' })` — a single `application/json` body per request instead of an SSE stream. Useful for serverless / edge runtimes that can't hold a stream open. Mid-call notifications are dropped.

**HTTP-only** by definition.
