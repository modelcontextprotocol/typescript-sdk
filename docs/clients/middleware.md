---
shape: how-to
---
# Compose client middleware

A **middleware** wraps the `fetch` a client transport uses, so it sees every HTTP request on the way out and every `Response` on the way back.

## Write a middleware

`createMiddleware` builds one from a function that receives the next handler plus the request. Compose it onto `fetch` with `applyMiddlewares` and hand the result to the transport's `fetch` option.

```ts source="../../examples/guides/clients/middleware.examples.ts#middleware_create"
import { applyMiddlewares, createMiddleware, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const tagRequests = createMiddleware(async (next, input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Request-Source', 'reports-cli');
    return next(input, { ...init, headers });
});

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
    fetch: applyMiddlewares(tagRequests)(fetch)
});
```

Every request this transport sends now carries the header — including the requests the SDK sends that you never wrote, like `initialize`.

::: info Not the framework middleware packages
This page is about client request middleware: functions that wrap the `fetch` inside `@modelcontextprotocol/client`. The `@modelcontextprotocol/express`, `@modelcontextprotocol/fastify`, `@modelcontextprotocol/hono`, and `@modelcontextprotocol/node` packages also carry the word "middleware" — those are server-side framework adapters for mounting a handler. See [Express](../serving/express.md), [Fastify](../serving/fastify.md), and [Hono](../serving/hono.md).
:::

## Compose several middlewares

`applyMiddlewares` takes any number of middlewares; each one in the list wraps everything before it. Stub out the network and stamp each layer's name on both sides of `next` to watch the order.

```ts source="../../examples/guides/clients/middleware.examples.ts#middleware_order"
const stamp = (name: string) =>
    createMiddleware(async (next, input, init) => {
        console.log(`-> ${name}`);
        const response = await next(input, init);
        console.log(`<- ${name}`);
        return response;
    });

const base = async () => new Response('ok');
await applyMiddlewares(stamp('retry'), stamp('auth'), stamp('trace'))(base)('http://localhost:3000/mcp');
```

The last middleware you pass is outermost — it sees the request first and the response last:

```
-> trace
-> auth
-> retry
<- retry
<- auth
<- trace
```

The first middleware you pass sits closest to the network. Put a retry there so every layer above it sees one settled `Response`.

## Use the built-in logging middleware

`withLogging` ships in `@modelcontextprotocol/client`; called with no options it logs every request the wrapped `fetch` makes.

```ts source="../../examples/guides/clients/middleware.examples.ts#middleware_logging"
const loggedFetch = applyMiddlewares(tagRequests, withLogging())(fetch);
```

Connect through `loggedFetch` and call one tool. Four requests reach the wire, and you wrote one of them:

```
HTTP POST http://localhost:3000/mcp 200  (0ms)
HTTP POST http://localhost:3000/mcp 202  (0ms)
HTTP GET http://localhost:3000/mcp 405  (0ms)
HTTP POST http://localhost:3000/mcp 200  (0ms)
```

The `POST`s are `initialize`, the `notifications/initialized` notification, and your `tools/call`; the `GET` opens the server-to-client stream, which this server declines. Pass `statusLevel: 400` to log only failures, `includeRequestHeaders` / `includeResponseHeaders` to add headers to each line, and `logger` to replace the formatter entirely.

::: warning
The default logger writes to `console.log` and `console.error`. In a process whose stdout carries an MCP stdio transport, pass your own `logger` so these lines stay off that stream.
:::

## Combine middleware with an auth provider

`withOAuth(provider, serverUrl)` is the OAuth flow expressed as one middleware layer: it adds the `Authorization` header, and on a `401` it re-authenticates against `serverUrl` and retries the request once.

```ts source="../../examples/guides/clients/middleware.examples.ts#middleware_withOAuth"
const serverUrl = new URL('http://localhost:3000/mcp');
const authed = new StreamableHTTPClientTransport(serverUrl, {
    fetch: applyMiddlewares(withOAuth(provider, serverUrl), withLogging({ statusLevel: 400 }))(fetch)
});
```

`provider` is the same `OAuthClientProvider` you would hand to the transport directly. With `statusLevel: 400`, `withLogging` stays silent until a request fails.

::: tip
For the common case, pass `authProvider` to the transport instead — see [OAuth](./oauth.md). `withOAuth` is for stacks that already own `fetch` and need auth composed with other layers.
:::

## Inspect the response

A middleware runs on both sides of `next`: read the request body before the call and the `Response` after it. Map each JSON-RPC method to the HTTP status it came back with.

```ts source="../../examples/guides/clients/middleware.examples.ts#middleware_inspect"
const observeStatus = createMiddleware(async (next, input, init) => {
    const response = await next(input, init);
    if (typeof init?.body === 'string') {
        const { method } = JSON.parse(init.body) as { method?: string };
        console.log(`${method ?? 'response'} -> HTTP ${response.status}`);
    }
    return response;
});
```

Connecting through `observeStatus` and calling one tool prints one line per request that carried a body:

```
initialize -> HTTP 200
notifications/initialized -> HTTP 202
tools/call -> HTTP 200
```

Always return the `Response`; the transport consumes its body after you. To read the body too, read a `response.clone()`.

## Recap

- A middleware wraps the transport's `fetch`: `createMiddleware` builds one, `applyMiddlewares` composes many, and the transport's `fetch` option takes the result.
- The last middleware passed to `applyMiddlewares` is outermost; the first sits closest to the network.
- A middleware sees every HTTP request the transport sends, including the ones the SDK sends on its own.
- `withLogging` and `withOAuth` ship in `@modelcontextprotocol/client`.
- A middleware sees both directions: the request before `next`, the `Response` after it.
