---
"@modelcontextprotocol/client": patch
---

fix(client): append custom Accept headers to spec-required defaults in StreamableHTTPClientTransport

Custom Accept headers provided via `requestInit.headers` are now appended to the spec-mandated Accept types instead of being overwritten. This ensures the required media types (`application/json, text/event-stream` for POST; `text/event-stream` for GET SSE) are always present while allowing users to include additional types for proxy/gateway routing.
