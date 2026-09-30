---
'@modelcontextprotocol/client': patch
---

With `versionNegotiation` in `'auto'` or pin mode, a `server/discover` probe answered with a 2xx that carries no usable reply (an empty or
non-JSON body, a `204`, a missing or unexpected content type) still rejects `connect()` with `EraNegotiationFailed`. The message now says
`the server answered with an unusable reply (...)` instead of reading like a network failure. To connect to a 2025 server behind a front that
answers the probe this way, pass `connect(transport, { prior: { kind: 'legacy' } })` or use `mode: 'legacy'`.
