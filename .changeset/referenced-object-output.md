---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Recognize same-document JSON Pointer references to output schemas constrained to objects so 2025-era clients receive the tool's object directly, matching equivalent inline schemas, instead of an extra `{ result: ... }` wrapper. References to schemas that allow non-object values keep their existing wrapping. Cyclic, unresolved, external, and nested-resource references remain conservatively classified.
