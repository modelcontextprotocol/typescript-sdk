---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

`setRequestHandler`/`setNotificationHandler` accept the v1 `(ZodSchema, handler)` form as a first-class alternative to `(methodString, handler)`. `request()` accepts an explicit result schema (`request(req, resultSchema, options?)`) and has a method-keyed return type for spec methods. `callTool(params, resultSchema?)` accepts the v1 schema arg (ignored). `removeRequestHandler`/`removeNotificationHandler`/`assertCanSetRequestHandler` accept any method string.
