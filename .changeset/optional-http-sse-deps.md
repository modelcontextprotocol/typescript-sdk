---
'@modelcontextprotocol/sdk': major
---

Move HTTP, SSE, and OAuth transport packages from runtime `dependencies` to optional `peerDependencies`. Stdio-only consumers no longer pay an ~22 MB / 60+ transitive package install for code paths they never load (closes #1924).

Affected packages, now installed only when the matching transport is used:

- `express`, `cors`, `express-rate-limit` (Express adapters + OAuth helpers)
- `@hono/node-server` (Node `StreamableHTTPServerTransport`)
- `raw-body`, `content-type` (`SSEServerTransport`)
- `eventsource`, `eventsource-parser` (SSE / Streamable HTTP client transports)
- `jose` (`createPrivateKeyJwtAuth`)

`hono` is dropped entirely from runtime deps (it was only referenced by an example).

Existing apps that already depend on Express, Hono, etc. in their own `package.json` continue to work unchanged. Apps that relied on the SDK to install these transitively will receive an `ERR_MODULE_NOT_FOUND` at import time pointing at the missing package; install it and the import resolves. See the updated `README.md` for the per-transport install matrix.
