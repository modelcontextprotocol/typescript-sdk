---
'@modelcontextprotocol/sdk': patch
---

Fix `tool(name, desc, schema, {}, cb)` overload where an empty annotations object made the callback unreachable. `isZodRawShapeCompat({})` returns `true` to accommodate no-arg-tool schemas, so an empty annotations slot was misclassified as a second schema and the handler position
fell through to `{}`, producing `typedHandler is not a function` at dispatch time. The annotations-position parser now accepts `{}` after a schema has already been consumed.
