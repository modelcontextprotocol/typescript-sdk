---
'@modelcontextprotocol/codemod': patch
---

Keep the result-schema argument on `request()` calls whose method is not a literal string, and keep the generic passthrough `ResultSchema` even for literal methods. Schema-less v2 `request()` enforces the spec result schema for known methods and resolves `undefined` for unknown ones, so dropping the schema from a proxy/forwarder call site (`request({ method, params }, ResultSchema)`) silently changed forwarding semantics. `callTool()` is unaffected — v2 `callTool()` has no schema parameter.
