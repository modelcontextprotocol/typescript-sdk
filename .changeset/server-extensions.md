---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Server and client extensions. `ServerOptions.extensions` takes `ServerExtension` objects (`{ id, capability?, install(server) }`): each is advertised under `capabilities.extensions[id]` and installed at construction. Extensions register custom methods with `setRequestHandler(method, { params, result }, handler)` and intercept spec methods with the new `Protocol.overrideRequestHandler(method, (request, ctx, next) => …)`, which composes around the registered handler at dispatch time (so an override on `tools/call` applies even though `McpServer` registers that handler lazily) and returns a remover. `ClientOptions.extensions` takes the symmetric `ClientExtension` objects, advertised under the client's `capabilities.extensions[id]` (in `initialize` on a legacy connection, in every request's client-capabilities envelope on 2026-07-28) and installed with the `Client`.

`McpServer` tool dispatch now re-throws `MissingRequiredClientCapabilityError` (`-32021`) as a JSON-RPC error instead of converting it into an `isError` tool result, matching the existing `UrlElicitationRequiredError` passthrough.
