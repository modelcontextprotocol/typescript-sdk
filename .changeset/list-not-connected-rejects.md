---
'@modelcontextprotocol/client': patch
---

`Client.listTools()`, `Client.listPrompts()`, `Client.listResources()`, and `Client.listResourceTemplates()` now reject with `Error('Not connected')` when `client.transport` is `undefined` (before `connect()`, after `close()`, or after the transport closes), without consulting `ResponseCacheStore`.

**Breaking change:** Previously, calling these four methods before `connect()` or after `close()` fell into the missing-capability leniency path and resolved with an empty list (`{ tools: [] }`, `{ prompts: [] }`, `{ resources: [] }`, `{ resourceTemplates: [] }`) instead of rejecting (and after a server-side transport close, an unexpired cached list could still be returned). Callers that await `listTools()`, `listPrompts()`, `listResources()`, or `listResourceTemplates()` while disconnected without handling errors will now reject with `Not connected`. Calling them on an active connection against a server that does not advertise the corresponding capability still returns an empty list unless `enforceStrictCapabilities` is enabled.
