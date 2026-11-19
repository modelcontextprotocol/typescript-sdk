---
'@modelcontextprotocol/client': patch
---

`Client.listTools()`, `Client.listPrompts()`, `Client.listResources()`, and `Client.listResourceTemplates()` now reject with `Error('Not connected')` when `client.transport` is `undefined` (before `connect()`, after `close()`, or after the transport closes), matching all other `Client` request methods and without consulting `ResponseCacheStore`.

**Breaking change:** Previously, calling these four methods while disconnected fell into the missing-capability leniency path and resolved with an empty list (`{ tools: [] }`, `{ prompts: [] }`, `{ resources: [] }`, `{ resourceTemplates: [] }`) instead of rejecting. Callers that await `listTools()`, `listPrompts()`, `listResources()`, or `listResourceTemplates()` before `connect()` or after `close()` without handling errors will now reject with `Not connected`. Calling them on an active connection against a server that does not advertise the corresponding capability still returns an empty list unless `enforceStrictCapabilities` is enabled.
