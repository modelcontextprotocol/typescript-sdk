---
'@modelcontextprotocol/core-internal': patch
---

Fix a memory leak in the validator providers: schemas without an `$id` were recompiled (or re-instantiated) on every `getValidator()` call and retained forever, so long-running clients that periodically refresh their tool catalogue (e.g. via `Client.listTools()`) grew the heap without bound. Identical schemas are now cached by their canonical serialization (key order independent), each distinct schema compiles at most once, compiled snapshots defeat Ajv's identity-based cache on in-place mutation, and the cache is FIFO-bounded so schemas that genuinely come and go cannot accumulate forever. Applies to both `AjvJsonSchemaValidator` and `CfWorkerJsonSchemaValidator` (the latter keys by schema + draft).
