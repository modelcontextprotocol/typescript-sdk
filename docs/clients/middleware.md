---
status: scaffold
shape: how-to
---
# Compose client middleware

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Compose request/response middleware.
teaches: createMiddleware, applyMiddlewares, Middleware, withLogging, withOAuth, the transport fetch option
source: mined from docs/client.md "Client middleware", "Trace context propagation" (middleware block); packages/client/src/client/middleware.ts
-->

## Write a middleware

<!-- teaches: createMiddleware((next, input, init) => ...) wrapping fetch | salvage: docs/client.md "Client middleware" -->

```ts
// draft - API verified against packages/client/src/client/middleware.ts (createMiddleware, applyMiddlewares) and packages/client/src/client/streamableHttp.ts (fetch option)
import { applyMiddlewares, createMiddleware, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const authMiddleware = createMiddleware(async (next, input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('X-Custom-Header', 'my-value');
  return next(input, { ...init, headers });
});

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
  fetch: applyMiddlewares(authMiddleware)(fetch),
});
```

<!-- result: every HTTP request the transport makes now carries the header; the middleware sees the raw Response on the way back. -->

## Compose several middlewares

<!-- teaches: applyMiddlewares(...mws) ordering — first argument is outermost | salvage: docs/client.md "Client middleware"; net-new ordering note -->
<!-- code: applyMiddlewares(retry, auth, logging)(fetch) with a one-line comment per layer -->

## Use the built-in logging middleware

<!-- teaches: withLogging(options) | salvage: net-new from packages/client/src/client/middleware.ts (withLogging) -->
<!-- code: applyMiddlewares(withLogging({ ... }))(fetch) -->

## Combine middleware with an auth provider

<!-- teaches: withOAuth — the auth provider expressed AS a middleware, for stacks that already own fetch | salvage: net-new from packages/client/src/client/middleware.ts (withOAuth) -->
<!-- code: applyMiddlewares(withOAuth(provider, serverUrl))(fetch) -->
<!-- aside: ::: tip — for the common case just pass authProvider to the transport (clients/oauth); withOAuth is for composing it with other middleware -->

## Inspect the response

<!-- teaches: middleware sees both directions — read response status/headers after awaiting next() | salvage: net-new; docs/client.md "Trace context propagation" (traceContext_middleware) as the worked case -->
<!-- code: const response = await next(input, init); read response.status; return response -->

## Recap

<!-- the claims this page will prove:
- Middleware wraps the transport's fetch; createMiddleware builds one, applyMiddlewares composes many.
- Pass the composed fetch to the transport's fetch option.
- A middleware sees the request before next() and the Response after it.
- withLogging and withOAuth ship in the box.
-->
