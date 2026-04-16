---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

`setRequestHandler`/`setNotificationHandler` gain a 3-arg `(method: string, paramsSchema, handler)` form for custom (non-spec) methods. `paramsSchema` is any Standard Schema (Zod, Valibot, ArkType, etc.); the handler receives validated `params`.
