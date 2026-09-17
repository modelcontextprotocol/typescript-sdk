---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Server and client extensions. `ServerOptions.extensions` takes `ServerExtension` objects (`{ id, install(server) }`): each is advertised under `capabilities.extensions[id]` and installed at construction; everything else an extension does, settings included, happens in `install`. Extensions register custom methods with `setRequestHandler(method, { params, result }, handler)` and intercept spec methods with the new `Protocol.use(method, (request, ctx, next) => …)` — middleware around the registered handler, composed at dispatch time in registration order (so middleware on `tools/call` applies even though `McpServer` registers that handler lazily); `use(middleware)` or `use('*', middleware)` runs on every request. Both return a remover. `ClientOptions.extensions` takes the symmetric `ClientExtension` objects, advertised under the client's `capabilities.extensions[id]` (in `initialize` on a legacy connection, in every request's client-capabilities envelope on 2026-07-28) and installed with the `Client`. `Protocol.acceptResultType(method, resultType)` declares an extension result kind for a method: a raw response carrying that `resultType` bypasses the era codec's closed vocabulary and is validated against the caller's explicit result schema as-is, which is how a client extension receives shapes such as the Tasks extension's `resultType: "task"` on `tools/call`.

`McpServer` tool dispatch now re-throws `MissingRequiredClientCapabilityError` (`-32021`) as a JSON-RPC error instead of converting it into an `isError` tool result, matching the existing `UrlElicitationRequiredError` passthrough.
