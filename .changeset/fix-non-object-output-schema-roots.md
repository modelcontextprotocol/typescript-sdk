---
'@modelcontextprotocol/sdk': patch
---

Fix the `tools/call` crash for non-object `outputSchema` roots (`.optional()`, `.nullable()`, `.nullish()`, `z.union(...)`): output validation now parses the schema directly when it cannot be normalized to an object, mirroring the input-validation path. `tools/list` still cannot
advertise such schemas (the wire schema requires `type: "object"` at the root, per the MCP specification), but registration now warns about the omission instead of dropping it silently.
