---
'@modelcontextprotocol/client': patch
---

With `versionNegotiation` in `'auto'` or pin mode, a `server/discover` probe answered with a 2xx that carries no usable reply (a body that
is not JSON under `application/json`, a bare `204`, a missing or unaccepted content type) still rejects `connect()` with
`EraNegotiationFailed`; an empty SSE stream or a `202` surfaces as the probe timeout instead. The message now says
`the server answered with an unusable reply (...)` instead of reading like a network failure. To connect to a 2025 server behind a front that
answers the probe this way, pass `connect(transport, { prior: { kind: 'legacy' } })` or use `mode: 'legacy'`.
