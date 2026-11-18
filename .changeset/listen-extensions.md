---
'@modelcontextprotocol/server': minor
---

`createMcpHandler` and `serveStdio` accept `listenExtensions`, so an extension can honor its own fields of the `subscriptions/listen` filter (for example the Tasks extension's `taskIds`) and deliver its notifications on listen streams, while the entry keeps owning ack-first, subscription-ID stamping, keepalive, subscription limits and teardown.

- A `ListenExtension` declares its notification `methods`, `honor(requested, capabilities)` returning the fields it honors from the raw requested filter, `accepts(honored, event)`, and an optional `validate(requested)` that rejects a malformed field with `-32602`.
- The core filter is honored first against the server's capabilities; an extension cannot add a core field.
- If `honor()` throws, the ack and the subscription record both leave out that extension's fields, the error is reported through `onerror`, and the core subscription is served as usual.
- `ServerEvent` gains `{ kind: 'extension'; method; params? }`, published with `handler.notify.extension(method, params)`. On `serveStdio`, an instance's notification whose method an extension declares is routed per subscription and dropped when none accepts it.

New exported types: `ListenExtension`, `ExtensionServerEvent`. `ServerNotifier` gains `extension()`; code that implements `ServerNotifier` itself must add it.
