---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Report protocol errors on stderr when no `onerror` handler is registered. `_onerror` only
called the optional handler, and that handler is undefined by default, so in the default
configuration every error routed through it was dropped.

The case that motivated this is a transport `send()` that fails after a request handler has
already run: the peer waits for a response that was never sent, nothing explains why, and
the only signal is the peer's own timeout firing much later.

stderr is used because the stdio transport reserves stdout for protocol messages. Setting
`onerror` keeps full control of the reporting and suppresses the fallback, so applications
that already handle errors see no change.
