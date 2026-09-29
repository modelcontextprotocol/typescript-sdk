---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Fixed the inbound era gate rejecting explicit-schema request handlers (`setRequestHandler(method, schemas, handler)`) for method names that a past protocol revision used for an unrelated core method, even though the current era's registry no longer defines that name at all. This made extension methods reusing a historical core name — like the Tasks extension's (SEP-2663) `tasks/get` and `tasks/cancel`, which collide with the 2025-11-25 core methods of the same name — permanently unreachable on the 2026-07-28 era: every inbound request answered `-32601 Method not found` before the registered handler was ever consulted, regardless of what the handler or its schema accepted.

The era gate now only blocks methods registered through the typed `setRequestHandler(method, handler)` overload (the SDK's own built-ins, like `initialize` or `ping`, correctly keep answering by absence once an era moves past them). A method registered with an explicit schema is the extension-authoring path, and the consumer's own schema now takes precedence over the historical registry collision.
