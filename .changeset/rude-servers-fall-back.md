---
'@modelcontextprotocol/client': patch
---

`versionNegotiation: { mode: 'auto' }` now falls back to the classic `initialize` handshake whenever the `server/discover` probe gets a completed, non-auth HTTP answer that is not a valid modern reply, instead of failing `connect()`. Newly falling back:

- a 2xx reply whose JSON body fails strict JSON-RPC validation — e.g. the JSON-RPC 2.0 parse-error shape `{"error":{"code":-32700,...},"id":null}` some deployed servers send for unknown methods (anomalyco/opencode#39354), or error replies with extra/unknown members;
- a 2xx `application/json` reply with an empty or unparseable body;
- a 2xx reply in a non-MCP content type (e.g. a proxy's HTML error page, `text/plain`, or a missing content-type);
- a `202 Accepted` answer to the probe — now immediate legacy evidence instead of waiting out the full probe timeout;
- any `5xx` answer, with or without a JSON-RPC error body (some deployments map JSON-RPC errors to 500). Hosts that cache era verdicts for `connect({ prior })` should date cached legacy verdicts — a 5xx can be a modern server's transient failure; the SDK itself never persists a verdict.

Unchanged: 401/403 remain typed auth failures (never era evidence), network-level failures and an HTTP probe timeout still reject with typed errors, and `pin` mode still never falls back. In `pin` mode — and for modern-only clients — the typed `ERA_NEGOTIATION_FAILED` rejection for these newly-legacy outcomes now names the concrete cause in its message (the HTTP status, or the invalid reply) and carries the evidence on `error.data` (status/statusText/response text, or the offending body and original validation error), so a transient 5xx stays distinguishable from a server that genuinely lacks the pinned revision.
