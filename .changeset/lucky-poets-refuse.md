---
'@modelcontextprotocol/codemod': patch
---

Keep the result-schema argument on `request()` calls unless the method is a literal spec method, and keep the generic passthrough `ResultSchema` even then. Schema-less v2 `request()` enforces the spec result schema for spec methods and throws a `TypeError` for non-spec methods, so dropping the schema from a dynamic-method call site (the proxy/forwarder shape, `request({ method, params }, ResultSchema)`) or from a custom-method call broke the call. `callTool()` is unaffected — v2 `callTool()` has no schema parameter.
