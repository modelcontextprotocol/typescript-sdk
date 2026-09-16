---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/server': minor
---

Server extensions. `ServerOptions.extensions` takes `ServerExtension` objects (`{ id, capability?, install(server) }`): each is advertised under `capabilities.extensions[id]` and installed at construction. Extensions register custom methods with `setRequestHandler(method, { params, result }, handler)` and intercept spec methods with the new `Protocol.overrideRequestHandler(method, (request, ctx, next) => …)`, which composes around the registered handler at dispatch time (so an override on `tools/call` applies even though `McpServer` registers that handler lazily) and returns a remover.

`McpServer` tool dispatch now re-throws `MissingRequiredClientCapabilityError` (`-32021`) as a JSON-RPC error instead of converting it into an `isError` tool result, matching the existing `UrlElicitationRequiredError` passthrough.
