---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Server and client extensions (experimental: the `extensions` option, the extension shapes and their contexts, `use` and `acceptResultType` may change in a minor release). An extension is `{ id, setup(ctx) }`, passed in `McpServerOptions.extensions` or `ClientOptions.extensions`. `setup` runs at construction, in array order, and adds everything through its context: `ctx.capability(settings)` sets what is advertised under `capabilities.extensions[id]` (`{}` by default), `ctx.setRequestHandler(name, schemas, handler)` registers the handler for a custom request method and refuses core method names and methods that already have a handler, `ctx.use(method, middleware)` wraps a method's handler, and `ctx.require(extensionId)` declares that the extension needs another extension, failing construction when it isn't installed. The server context also carries `ctx.mcp`, the `McpServer`; the client context carries `ctx.client` and `ctx.acceptResultType`. A duplicate id fails construction before any extension is set up.

`Protocol.use(method, (request, ctx, next) => …)` is middleware around the registered handler, composed at dispatch time in registration order, so middleware on `tools/call` applies even though `McpServer` registers that handler lazily; it returns a remover. `Protocol.acceptResultType(method, resultType)` declares an extension result kind for a method: a raw response carrying that `resultType` bypasses the era codec's closed vocabulary and is validated against the caller's explicit result schema as-is, which is how a client extension receives shapes such as the Tasks extension's `resultType: "task"` on `tools/call`.

`McpServer` tool dispatch now re-throws `MissingRequiredClientCapabilityError` (`-32021`) as a JSON-RPC error instead of converting it into an `isError` tool result, matching the existing `UrlElicitationRequiredError` passthrough.
