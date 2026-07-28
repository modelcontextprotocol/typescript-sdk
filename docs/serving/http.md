---
shape: how-to
---

# Serve over HTTP

To host one MCP endpoint that many clients connect to, serve your factory over **Streamable HTTP**. A host that launches the server as a local child process speaks [stdio](./stdio.md) instead.

## Create a handler

`createMcpHandler` takes a **factory** — a function that builds and returns a fresh `McpServer` — and returns the handler that serves it.

```ts source="../../examples/guides/serving/http.examples.ts#createHandler"
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool(
        'add-note',
        {
            description: 'Save a note',
            inputSchema: z.object({ text: z.string() })
        },
        async ({ text }) => ({ content: [{ type: 'text', text: `Saved: ${text}` }] })
    );
    return server;
});
```

`handler.fetch` is a web-standard `(Request) => Promise<Response>` — nothing is listening yet. The tool calls on this page come from a real `Client` driving the handler's `fetch` in process; [Test a server](../testing.md) shows that wiring.

Calling `add-note` through it returns the tool result:

```
[ { type: 'text', text: 'Saved: ship the release notes' } ]
```

The handler also carries `close` for shutdown and the `notify`/`bus` pair that publishes change events to subscribed clients — see [Notifications](../servers/notifications.md).

::: info Coming from v1?
`createMcpHandler` replaces the per-request `StreamableHTTPServerTransport` + `connect()` wiring — run the codemod, then see the [upgrade guide](../migration/upgrade-to-v2.md).
:::

## Understand the per-request factory

The factory runs once per HTTP request: a fresh instance serves every request, and the handler holds nothing between requests. Register tools, resources, and prompts inside the factory, never on a shared instance outside it.

The factory receives the **request context** — `era`, `authInfo`, and the inbound `Request` as `requestInfo`. Destructure `authInfo` to build the instance around one caller; [Pass authentication through](#pass-authentication-through) shows where the value comes from.

```ts source="../../examples/guides/serving/http.examples.ts#factoryContext"
const perCaller = createMcpHandler(({ authInfo }) => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool('whoami', { description: 'Name the authenticated caller' }, async () => ({
        content: [{ type: 'text', text: authInfo?.clientId ?? 'anonymous' }]
    }));
    return server;
});
```

Every request now gets an instance built for its own caller. Keep the factory cheap and side-effect-free: create connection pools and caches once at module scope and close over them.

`era` names the protocol revision the request speaks — see [Protocol versions](../protocol-versions.md).

Because no state lives on the instance, the endpoint is stateless and scales horizontally as-is; sessions, resumability, and multi-node fan-out are their own page, [Sessions, state, and scaling](./sessions-state-scaling.md).

## Mount it on your runtime

On a web-standard runtime — Cloudflare Workers, Deno, Bun — `export default handler` is the entire mount. Node frameworks wrap the handler once with `toNodeHandler` from `@modelcontextprotocol/node`; on plain `node:http`, bind loopback explicitly and compose the `localhostHostValidation` / `localhostOriginValidation` guards (also from `@modelcontextprotocol/node`) in front of it, matching the framework factories' defaults:

```ts source="../../examples/guides/serving/http.examples.ts#mountNode"
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
}).listen(3000, '127.0.0.1');
```

`POST http://127.0.0.1:3000/mcp` now reaches the factory; the guards answer anything else with `403` before the handler sees it — [the next section](#validate-host-and-origin-in-front-of-it) explains why they belong in front. The same wrapped handler mounts under [Express](./express.md), [Fastify](./fastify.md), and [Hono](./hono.md); [Serve on web-standard runtimes](./web-standard.md) covers the `export default` side.

## Validate Host and Origin in front of it

The handler trusts its caller: it validates no `Host` header, no `Origin` header, and no token. Mount those checks in front of it — on a localhost bind, the `Host` check is what stops **DNS rebinding**, a malicious page resolving its own domain to `127.0.0.1` so the browser treats your local server as same-origin.

Under a framework you never wire either check by hand: `createMcpExpressApp`, `createMcpHonoApp`, and `createMcpFastifyApp` all arm both by default on localhost binds — the [Express](./express.md), [Hono](./hono.md), and [Fastify](./fastify.md) recipes start there. On plain `node:http`, compose `localhostHostValidation` and `localhostOriginValidation` (from `@modelcontextprotocol/node`) in front of the wrapped handler, as [the mount above](#mount-it-on-your-runtime) does. On a bare fetch runtime, put `hostHeaderValidationResponse` and `originValidationResponse` (from `@modelcontextprotocol/server`) in front of `handler.fetch` — [Serve on web-standard runtimes](./web-standard.md#protect-against-dns-rebinding) builds that wrapper.

## Pass authentication through

`authInfo` is pass-through: the handler never reads it from headers and never verifies a token. Verify the bearer token in front of the handler and hand it the result as `fetch`'s second argument, `handler.fetch(request, { authInfo })`; the factory reads it back as `authInfo`, and tool handlers as `ctx.http.authInfo`.

Under a Node framework the verifying middleware runs first and `toNodeHandler` forwards what it sets — each recipe shows its own mount, and [Require authorization](./authorization.md) builds the verifier with `requireBearerAuth`.

With an `AuthInfo` whose `clientId` is `alice`, `whoami` from [the factory above](#understand-the-per-request-factory) answers:

```
[ { type: 'text', text: 'alice' } ]
```

## Shape the response stream

The handler answers a request with a single JSON body and upgrades to an SSE stream only when a tool handler emits a notification — progress, logging — before its result. `responseMode` pins one shape instead.

```ts source="../../examples/guides/serving/http.examples.ts#shapeResponse"
const jsonOnly = createMcpHandler(factory, { responseMode: 'json' });
```

`'json'` never streams: the SDK drops mid-call notifications and delivers only the terminal result. `'sse'` always streams. `subscriptions/listen` streams stay on SSE whichever you pick.

::: info
The handler serves 2025-era clients statelessly from the same factory by default. The `legacy` option — and where the SSE transport went — is on [Support legacy clients](./legacy-clients.md).
:::

## Shut down

`handler.close()` aborts in-flight exchanges and closes their per-request instances; the handler holds nothing else.

```ts source="../../examples/guides/serving/http.examples.ts#shutDown"
process.on('SIGINT', async () => {
    await handler.close();
    process.exit(0);
});
```

`close()` resolves once every in-flight instance has closed; `fetch` then throws on any further request.

## Recap

- `createMcpHandler(factory)` returns `{ fetch, close, notify, bus }`; `fetch` is a web-standard `(Request) => Promise<Response>`.
- The factory builds one fresh instance per request and receives `era`, `authInfo`, and `requestInfo`.
- `export default handler` mounts it on web-standard runtimes; `toNodeHandler(handler)` mounts it once under Node frameworks.
- The handler validates no `Host` or `Origin` header and verifies no token — mount both checks in front of it; the framework app factories arm the header checks for you.
- `authInfo` flows from `fetch(request, { authInfo })` into the factory and tool handlers; each framework recipe shows its own mount.
- `responseMode` pins the response shape; `'json'` drops mid-call notifications.
