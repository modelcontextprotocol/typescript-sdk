---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport` no longer fires `onerror` twice when the standalone GET stream fails to open. `_startOrAuthSse` reported the failure itself and then re-threw it to call sites that report it again; errors are now surfaced only by the call sites, so a single failure (including the abort from a deliberate `close()` while the GET is in flight) produces a single callback.
