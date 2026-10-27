---
shape: how-to
---

# Extensions

::: warning Experimental
The `extensions` option, the `ServerExtension` and `ClientExtension` shapes, their contexts, `use` and `acceptResultType` are experimental and may change in a minor release.
:::

An **extension** packages protocol behaviour outside the core specification, such as the `io.modelcontextprotocol/tasks` or `io.modelcontextprotocol/skills` extension or a vendor feature, as one object you pass to the server or the client. The SDK advertises it, sets it up, and checks what it depends on before serving.

## Write a server extension

An extension is an `id` and a `setup(ctx)` function. What is both required and declarative sits on the object, which today is just the `id`. Everything else happens in `setup`, which runs once while the server is constructed: optional declarations first (`ctx.capability`, `ctx.require`), then handlers, middleware and anything registered on `ctx.mcp`. Everything `setup` adds goes through `ctx`:

| Member                                          | What it does                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.capability(settings)`                      | Sets what the server advertises under `capabilities.extensions[id]`. Without a call, the server advertises `{}`.                                                                  |
| `ctx.require(extensionId)`                      | Declares that this extension needs another extension. Construction fails, naming both, when the server doesn't install it. Order in `extensions` doesn't matter.                  |
| `ctx.setRequestHandler(name, schemas, handler)` | Registers the handler for a custom request method, with the same arguments as `setRequestHandler`. Throws for a core method name, or for a method another handler already serves. |
| `ctx.use(method, middleware)`                   | Middleware around whatever handler serves `method`, core or custom.                                                                                                               |
| `ctx.mcp`                                       | The `McpServer`, for `registerTool`, `registerResource` and `ResourceTemplate`.                                                                                                   |

This extension adds a custom method, and refuses `tools/call` from clients that didn't declare it. It reads the 2026-07-28 per-request envelope, so as written it refuses every 2025-11-25 request:

```ts
import type { ServerExtension } from '@modelcontextprotocol/server';
import { MissingRequiredClientCapabilityError, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const GATE = 'com.example/gate';

export const gate: ServerExtension = {
    id: GATE,
    setup(ctx) {
        // Settings for the advertised capability, if the extension has any.
        ctx.capability({ exampleData: true });

        // A custom method: setRequestHandler, checked for name clashes.
        ctx.setRequestHandler('gate/status', { params: z.looseObject({}) }, () => ({ armed: true }));

        // Middleware on a spec method: runs around the registered handler,
        // may answer, transform, or refuse.
        ctx.use('tools/call', (request, requestCtx, next) => {
            const declared = requestCtx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY]?.extensions ?? {};
            if (!(GATE in declared)) {
                throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [GATE]: {} } } }, 'declare the gate');
            }
            return next(request, requestCtx);
        });
    }
};
```

An extension that serves resources or tools registers them on `ctx.mcp`, like any server:

```ts
const changelog: ServerExtension = {
    id: 'com.example/changelog',
    setup(ctx) {
        ctx.mcp.registerResource('changelog', 'changelog://latest', { mimeType: 'text/markdown' }, async uri => ({
            contents: [{ uri: uri.href, text: await readChangelog() }]
        }));
    }
};
```

## Install it

Pass extensions to `McpServer` at construction:

```ts
const server = new McpServer({ name: 'gated', version: '1.0.0' }, { extensions: [gate, changelog] });
```

The server then:

1. Checks the ids. A duplicate fails construction before any extension is set up, and so does an entry for an installed id in `capabilities.extensions`: an extension's entry belongs to it, so set its settings with `ctx.capability`. `registerCapabilities` refuses that entry later too.
2. In array order, advertises each extension under `capabilities.extensions[id]` as `{}` and runs its `setup`. Legacy connections see the map in the `initialize` result, and 2026-07-28 connections see it in `server/discover`. Settings from `ctx.capability` replace the `{}`.

A `setup` that throws fails the constructor, so a server with a partly set up extension never exists. That includes `ctx.require` for an extension the server doesn't install. A `setup` that runs after an `await`, or after an async `setup` listed before it, fails `connect` instead, with the same error.

`setup` may be async, to load what the extension serves:

```ts
const catalog: ServerExtension = {
    id: 'com.example/catalog',
    async setup(ctx) {
        const entries = await loadCatalog();
        ctx.capability({ size: entries.length });
        ctx.setRequestHandler('catalog/list', { params: z.looseObject({}) }, () => ({ entries }));
    }
};
```

The setups after an async one wait for it, so they still run in array order. `connect` waits for every setup to finish before the server processes anything, and rejects with the error if one fails. The ids are known before any `setup` runs, so a required extension can be listed before or after the one that needs it.

`ctx.require` is for an extension that can't work without another one. When the other one only adds something optional, check for what you need in code, such as in a handler or middleware at the moment it runs, and carry on without it. Extensions are an `McpServer` option; the low-level `Server` doesn't take them.

## Client extensions

The client takes the same shape, `{ id, setup(ctx) }`, in `ClientOptions.extensions`. The client advertises each extension under its own `capabilities.extensions[id]`: in `initialize` on a legacy connection, and in every request's `_meta` client-capabilities envelope on a 2026-07-28 connection, which is where a server extension reads it. Its context has:

- `ctx.capability(settings)`, `ctx.use(method, middleware)` and `ctx.require(extensionId)`, as on the server. `setup` may be async here too; `connect` waits for it before sending anything.
- `ctx.setRequestHandler(name, schemas, handler)` for custom server-to-client requests. These are served on 2025-11-25 connections only: 2026-07-28 has no server-to-client request channel.
- `ctx.acceptResultType(method, resultType)`, so results of `method` may carry a `resultType` the extension defines. The explicit-schema `request()` path then hands them to the caller's schema as-is, instead of rejecting the unknown kind; typed calls such as `callTool` reject it with `UnsupportedResultType` on either protocol version.
- `ctx.client`, the client being set up.

```ts
import type { ClientExtension } from '@modelcontextprotocol/client';

const gateClient: ClientExtension = {
    id: GATE,
    setup(ctx) {
        ctx.setRequestHandler('gate/ping', { params: z.looseObject({}) }, () => ({ pong: true }));
        ctx.acceptResultType('tools/call', 'gate');
    }
};

const client = new Client({ name: 'gated-client', version: '1.0.0' }, { extensions: [gateClient] });
```

## How middleware composes

`ctx.setRequestHandler` registers the route handler. `ctx.use(method, middleware)` is the middleware around it, in the Koa style: `await next(request, requestCtx)` yields the result, and the middleware returns what goes on the wire. It wraps whatever handler serves `method` at dispatch time, including one another extension registered. That matters for `tools/call`, which `McpServer` registers on the first tool registration: middleware installed at construction still applies.

Middleware works at the JSON-RPC level, before the handler's own steps:

- It receives the request with wire-only material (the reserved `_meta` envelope keys, `inputResponses`, `requestState`) already lifted onto `requestCtx.mcpReq`. Params are not validated yet.
- `requestCtx.mcpReq.requestState()` is the raw wire value. The `requestState.verify` hook runs inside the handler, so don't trust that state in middleware.
- A result the middleware returns without calling `next` skips the handler's result validation.

With no underlying handler, `next` throws `MethodNotFound`. If the middleware lets it through, the request is answered as an unknown method (HTTP 404 on a per-request HTTP exchange), the way a web framework answers 404 through route middleware. If the middleware answers instead, its answer goes out. Over 2026-07-28, a request that lacks the `_meta` envelope is refused with `-32602` before middleware runs, even for a method only middleware serves.

Several middleware nest in registration order, the first outermost. Extension middleware runs outside middleware the application adds with `server.server.use`, whenever either was added, and extensions' middleware nests in array order, the first extension's outermost. Method names are exact, and there is no wildcard.

An extension wraps the methods it doesn't own with `ctx.use`, and never registers them again; `ctx.setRequestHandler` refuses to. Something every peer must know about the extension belongs in its advertised capability (`ctx.capability`), not in per-request `_meta`. Where a result does carry extension `_meta`, the middleware adds its own namespaced key, and the encoder still stamps the SDK's reserved keys and `resultType` on top.

A thrown `ProtocolError` becomes the JSON-RPC error response. Inside a tool handler, `McpServer` converts most throws into an `isError` tool result. The exceptions are the protocol-level errors the client must see as errors: `UrlElicitationRequiredError` and `MissingRequiredClientCapabilityError` (`-32021`).

## Recap

- An extension is `{ id, setup(ctx) }`, passed in `McpServerOptions.extensions` or `ClientOptions.extensions`.
- `setup` registers everything through `ctx`: `capability`, `setRequestHandler`, `use`, `require`, plus `ctx.mcp` on the server and `acceptResultType` on the client.
- Extensions are set up in array order, and `setup` may be async; `connect` waits for it. Duplicate ids, a `capabilities.extensions` entry for an installed id, and a `ctx.require` for an extension that isn't installed fail construction, or `connect` once an async `setup` is involved.
- Middleware composes at dispatch time, extensions' outside the application's, and applies to handlers registered later, including other extensions' handlers. It sees the request before validation.
- The SDK owns the hooks, the checks and the capability advertisement, not the extension's state or execution.
