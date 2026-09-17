---
shape: how-to
---

# Server extensions

A **server extension** packages protocol behaviour outside the core specification — an MCP extension such as `io.modelcontextprotocol/tasks`, or a vendor feature — as one object you pass to the server. The SDK advertises it, installs it, and gives it two seams: custom methods and overrides of spec methods. What the extension does behind those seams is its own business.

## Write an extension

An extension is an `id`, an optional settings object, and an `install` function that receives the low-level `Server`.

```ts
import type { ServerExtension } from '@modelcontextprotocol/server';
import { MissingRequiredClientCapabilityError, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const GATE = 'com.example/gate';

export const gate: ServerExtension = {
    id: GATE,
    capability: { exampleData: true },
    install(server) {
        // A custom method, exactly as in Custom methods.
        server.setRequestHandler('gate/status', { params: z.looseObject({}) }, () => ({ armed: true }));

        // An override of a spec method: runs before the registered handler,
        // may answer, transform, or refuse.
        server.overrideRequestHandler('tools/call', (request, ctx, next) => {
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

Pass extensions at construction. Each is advertised under `capabilities.extensions[id]` — legacy connections see it in the `initialize` result, 2026-07-28 connections in `server/discover` — and installed in order after the built-in handlers exist.

```ts
const server = new McpServer({ name: 'gated', version: '1.0.0' }, { extensions: [gate] });
```

The same option exists on the low-level `Server`.

## Client extensions

The client half is symmetric: `ClientExtension` is `{ id, capability?, install(client) }`, passed in `ClientOptions.extensions`. The client advertises it under its own `capabilities.extensions[id]` — in `initialize` on a legacy connection, and in every request's `_meta` client-capabilities envelope on a 2026-07-28 connection, which is where a server extension reads it — and `install` receives the `Client` to register handlers for server-to-client requests and notifications, or override the ones the SDK installs.

```ts
import type { ClientExtension } from '@modelcontextprotocol/client';

const gateClient: ClientExtension = {
    id: GATE,
    install(client) {
        client.setRequestHandler('gate/ping', { params: z.looseObject({}) }, () => ({ pong: true }));
    }
};

const client = new Client({ name: 'gated-client', version: '1.0.0' }, { extensions: [gateClient] });
```

## How overrides compose

`overrideRequestHandler(method, override)` wraps whatever handler serves `method` at dispatch time. That matters for `tools/call`, which `McpServer` registers on the first tool registration: an override installed at construction still applies. With no underlying handler, `next` throws `MethodNotFound`. Several overrides nest, the latest outermost. The returned function removes the override.

A thrown `ProtocolError` becomes the JSON-RPC error response. Inside a tool handler, `McpServer` converts most throws into an `isError` tool result; the exceptions are protocol-level errors the client must see as errors — `UrlElicitationRequiredError` and `MissingRequiredClientCapabilityError` (`-32021`).

## Recap

- `ServerExtension` is `{ id, capability?, install(server) }`; pass it in `ServerOptions.extensions`. `ClientExtension` mirrors it on `ClientOptions.extensions`.
- `install` gets the low-level `Server`: `setRequestHandler` for custom methods, `overrideRequestHandler` to intercept spec methods.
- Overrides compose at dispatch time and apply to handlers registered later.
- The SDK owns the seams and the capability advertisement, not the extension's state or execution.
