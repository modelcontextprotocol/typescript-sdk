---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add custom (non-spec) method support: a 3-arg `setRequestHandler(method, schemas, handler)` / `setNotificationHandler(method, schemas, handler)` form for vendor-prefixed methods, and a `request(req, resultSchema)` overload (also on `ctx.mcpReq.send`) for typed custom-method results. Spec-method calls are unchanged.

Response result-schema validation failure now rejects with `SdkError(InvalidResult)` instead of a raw `ZodError`. Adds `SdkErrorCode.InvalidResult`.
