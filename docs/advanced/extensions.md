---
shape: how-to
---

# Server extensions

A **server extension** packages protocol behaviour outside the core specification — an MCP extension such as `io.modelcontextprotocol/tasks`, or a vendor feature — as one object you pass to the server. The SDK advertises it, installs it, and gives it two hooks: custom methods and middleware on spec methods. What the extension does behind those hooks is its own business.

## Write an extension

An extension is an `id` and an `install` function that receives the low-level `Server`. Everything it does to the protocol happens in `install`.

```ts
import type { ServerExtension } from '@modelcontextprotocol/server';
import { MissingRequiredClientCapabilityError, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const GATE = 'com.example/gate';

export const gate: ServerExtension = {
    id: GATE,
    install(server) {
        // Settings for the advertised capability, if the extension has any.
        server.registerCapabilities({ extensions: { [GATE]: { exampleData: true } } });

        // A custom method, exactly as in Custom methods.
        server.setRequestHandler('gate/status', { params: z.looseObject({}) }, () => ({ armed: true }));

        // Middleware on a spec method: runs around the registered handler,
        // may answer, transform, or refuse.
        server.use('tools/call', (request, ctx, next) => {
            const declared = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY]?.extensions ?? {};
            if (!(GATE in declared)) {
                throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [GATE]: {} } } }, 'declare the gate');
            }
            return next(request, ctx);
        });
    }
};
```

## Install it

Pass extensions at construction. Each is advertised under `capabilities.extensions[id]` as `{}` — legacy connections see it in the `initialize` result, 2026-07-28 connections in `server/discover` — and then installed in order, after the built-in handlers exist. An extension with settings registers them in `install`, as above; the maps merge.

```ts
const server = new McpServer({ name: 'gated', version: '1.0.0' }, { extensions: [gate] });
```

The same option exists on the low-level `Server`.

## Client extensions

The client half is symmetric: `ClientExtension` is `{ id, install(client) }`, passed in `ClientOptions.extensions`. The client advertises it under its own `capabilities.extensions[id]` — in `initialize` on a legacy connection, and in every request's `_meta` client-capabilities envelope on a 2026-07-28 connection, which is where a server extension reads it — and `install` receives the `Client` to register handlers for server-to-client requests and notifications, or wrap the ones the SDK installs with middleware.

```ts
import type { ClientExtension } from '@modelcontextprotocol/client';

const gateClient: ClientExtension = {
    id: GATE,
    install(client) {
        client.setRequestHandler('gate/ping', { params: z.looseObject({}) }, () => ({ pong: true }));
        // Results of tools/call may carry the extension's own kind; the
        // explicit-schema request() path then hands them to the caller's
        // schema as-is instead of rejecting the unknown resultType.
        client.acceptResultType('tools/call', 'gate');
    }
};

const client = new Client({ name: 'gated-client', version: '1.0.0' }, { extensions: [gateClient] });
```

## How middleware composes

`setRequestHandler` is the route handler; `use(method, middleware)` is the middleware around it, Koa-shaped: `await next(request, ctx)` yields the result and the middleware returns what goes on the wire. It wraps whatever handler serves `method` at dispatch time. That matters for `tools/call`, which `McpServer` registers on the first tool registration: middleware installed at construction still applies. With no underlying handler, `next` throws `MethodNotFound`. Several middleware nest in registration order, the first installed outermost. The returned function removes the middleware. `use(middleware)` — or `use('*', middleware)` — installs it on every request, in that same order, which is how an extension stamps a `_meta` key on every result:

```ts
server.use(async (request, ctx, next) => {
    const result = await next(request, ctx);
    return { ...result, _meta: { ...result._meta, 'com.example/gate': { armed: true } } };
});
```

The encoder still stamps the SDK's reserved `_meta` keys and `resultType` on top; an extension adds its own namespaced keys, it does not replace those.

A thrown `ProtocolError` becomes the JSON-RPC error response. Inside a tool handler, `McpServer` converts most throws into an `isError` tool result; the exceptions are protocol-level errors the client must see as errors — `UrlElicitationRequiredError` and `MissingRequiredClientCapabilityError` (`-32021`).

## Recap

- `ServerExtension` is `{ id, install(server) }`; pass it in `ServerOptions.extensions`. `ClientExtension` mirrors it on `ClientOptions.extensions`.
- `install` gets the low-level `Server`: `setRequestHandler` for custom methods, `use` for middleware on spec methods, `registerCapabilities` for the extension's settings.
- Middleware composes at dispatch time, in registration order, and applies to handlers registered later.
- `acceptResultType(method, resultType)` lets a client extension receive a result kind outside `complete` / `input_required` through the explicit-schema `request()` path.
- The SDK owns the hooks and the capability advertisement, not the extension's state or execution.
