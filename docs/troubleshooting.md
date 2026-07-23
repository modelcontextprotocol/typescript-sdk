---
shape: reference
---

# Troubleshooting

Each heading on this page is the verbatim error message. Match yours, then apply that entry's fix.

## `SyntaxError: Unexpected token ... is not valid JSON`

On stdio, standard output is the wire: the host parses every line your server writes to `stdout` as JSON-RPC. One `console.log` — yours or a dependency's — puts a stray line on it, and the host reports that line with this error. Log to `stderr` instead; `serveStdio` owns `stdout`, and `console.error` is safe anywhere in the process.

```ts source="../examples/guides/troubleshooting.stdio.examples.ts#serveStdio_stderr"
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

serveStdio(() => {
    const server = new McpServer({ name: 'app', version: '1.0.0' });
    console.error('app server running on stdio'); // stderr — never console.log
    return server;
});
```

The host shows the `stderr` line in the server's log and keeps parsing `stdout` cleanly. [Serve over stdio](./serving/stdio.md) covers the entry point.

::: tip
The quoted token is the first character of the stray line, which usually identifies the call that wrote it.
:::

## `TS2589: Type instantiation is excessively deep and possibly infinite`

Two copies of `zod` in the dependency tree. The SDK derives its tool, prompt and resource types from Zod v4 schemas; a second `zod` copy makes TypeScript instantiate cross-version types until it hits its recursion limit and fails at an unrelated-looking call site.

List every installed copy:

```sh
npm ls zod        # or: pnpm why zod / yarn why zod
```

Align everything on one Zod 4 version. When a transitive dependency pins another copy, force one with your package manager's override field (`overrides` for npm and pnpm, `resolutions` for Yarn):

```json
{
    "overrides": {
        "zod": "^4.2.0"
    }
}
```

`npm ls zod` reporting a single version means the duplicate is gone and the error with it.

## `ReferenceError: crypto is not defined`

The OAuth client helpers sign and verify through the Web Crypto API at `globalThis.crypto`. Every `@modelcontextprotocol/*` package requires Node.js 20, where that global is always defined — this error means the process is running on an older runtime (Node.js 18 and earlier).

Upgrade Node.js. Where you cannot, assign the polyfill from `node:crypto` before anything touches the SDK:

```ts source="../examples/guides/troubleshooting.examples.ts#webcrypto_polyfill"
import { webcrypto } from 'node:crypto';

if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = webcrypto;
}
```

With the global in place the [client OAuth](./clients/oauth.md) flows run unchanged.

## `SdkError: ERA_NEGOTIATION_FAILED`

`connect()` found no **protocol era** both sides speak, or the negotiation probe was cut short. Match the message tail:

- `the server did not offer pinned protocol version ... via server/discover (no fallback in pin mode)` — the pin names a revision the server does not offer, and pinning never falls back: drop the pin or use `'auto'`.
- `the connection closed during the server/discover probe before the server offered pinned protocol version ...` — same pin, but the server exited on the probe (an exit-on-probe legacy server): use `'auto'`.
- `the server gave no modern evidence and this client supports no pre-2026-07-28 protocol version to fall back to` — or its `the connection closed during the server/discover probe and this client supports no ...` variant — `mode: 'auto'` with a modern-only `supportedProtocolVersions` list removes the legacy fallback: restore a pre-2026 entry.
- `the connection closed during the server/discover probe (this transport probed in place — the disposable sibling probe requires the SDK's base StdioClientTransport)` — a subclass of `StdioClientTransport`, or a custom stdio-shaped transport, probed in place and met a server that exits on any pre-`initialize` request: use the base `StdioClientTransport` (which probes on a disposable sibling), or `mode: 'legacy'`.
- `the transport was closed during the server/discover probe` — the caller closed the transport while the probe was in flight; the connect aborted deliberately and the session child was never spawned.
- `Version negotiation probe failed: ...` — the probe hit a transport failure (network outage, HTTP connection drop): fix connectivity and retry.

The pinned shape — `transport` here reaches a server still on the 2025 revisions ([Test a server](./testing.md) shows the in-memory wiring these outputs come from):

```ts source="../examples/guides/troubleshooting.examples.ts#connect_pinRejected"
const pinned = new Client({ name: 'app', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

try {
    await pinned.connect(transport);
} catch (error) {
    if (!(error instanceof SdkError)) throw error;
    console.log(`${error.code}: ${error.message}`);
}
```

The rejection names the pinned revision the server never offered:

```
ERA_NEGOTIATION_FAILED: Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 via server/discover (no fallback in pin mode)
```

Change the mode to `'auto'`: the probe falls back to the 2025 `initialize` handshake.

```ts source="../examples/guides/troubleshooting.examples.ts#connect_autoFallback"
const negotiated = new Client({ name: 'app', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

await negotiated.connect(transport);
console.log(negotiated.getProtocolEra());
```

`connect()` resolves and the client reports the era it landed on:

```
legacy
```

Keep `{ pin }` where a legacy connection is unacceptable and a hard failure is the behavior you want. [Protocol versions](./protocol-versions.md) defines the eras and what each negotiation mode offers.

## `SdkError: METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`

You sent a spec method the negotiated protocol era does not define. The SDK raises this locally — nothing reached the transport — and the message names the method, the negotiated revision, and the era-appropriate replacement.

`subscriptions/listen` exists only on a 2026-07-28 connection; this client negotiated a 2025 era, the default:

```ts source="../examples/guides/troubleshooting.examples.ts#listen_legacyConnection"
const client = new Client({ name: 'app', version: '1.0.0' });
await client.connect(transport);

try {
    await client.listen({ resourceSubscriptions: ['file:///logs/app.log'] });
} catch (error) {
    if (!(error instanceof SdkError)) throw error;
    console.log(`${error.code}: ${error.message}`);
}
```

The message carries the fix:

```
METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION: subscriptions/listen requires a 2026-07-28-era connection (negotiated: 2025-11-25). On a 2025-era connection, change notifications are delivered unsolicited: use ClientOptions.listChanged and resources/subscribe instead.
```

Either negotiate the era that defines the method — `versionNegotiation: { mode: 'auto' }` against a server that serves 2026-07-28, as in the previous entry — or call the surface the negotiated era does define. [Subscriptions](./clients/subscriptions.md) covers both delivery models; [Protocol versions](./protocol-versions.md) lists which methods each era defines.

## `Module '"@modelcontextprotocol/server"' has no exported member 'SSEServerTransport'`

`@modelcontextprotocol/server` no longer ships the server-side SSE transport, and the OAuth Authorization Server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`) left with it. Both live on as a frozen v1 copy in `@modelcontextprotocol/server-legacy`.

Rewrite the imports:

```diff
- import { SSEServerTransport } from '@modelcontextprotocol/server';
+ import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse';

- import { mcpAuthRouter, ProxyOAuthServerProvider } from '@modelcontextprotocol/server';
+ import { mcpAuthRouter, ProxyOAuthServerProvider } from '@modelcontextprotocol/server-legacy/auth';
```

The Resource Server helpers did not move there: `requireBearerAuth`, `mcpAuthMetadataRouter` and `OAuthTokenVerifier` are first-class in `@modelcontextprotocol/express` — see [Authorization](./serving/authorization.md). `@modelcontextprotocol/server-legacy` is frozen and receives no new features; serve new code over [Streamable HTTP](./serving/http.md), which still reaches 2025-era clients through [legacy client support](./serving/legacy-clients.md). A client limited to the HTTP+SSE transport is the one case that still needs the frozen `@modelcontextprotocol/server-legacy/sse` import above.

## `SSE stream disconnected: TypeError: terminated`

An idle SSE stream was killed by an intermediary or an idle-connection timeout — Node's `server.requestTimeout` defaults to 300 seconds, and reverse proxies and cloud load balancers have similar watchdogs. The client observes the dropped socket as this error (typically every ~5 minutes) and reconnects in a loop.

`WebStandardStreamableHTTPServerTransport` prevents this by writing an SSE comment frame (`: keepalive`) to every open SSE stream every 15 seconds by default. Comment frames are dropped by SSE parsers before event dispatch, so they never surface as protocol messages. Tune or disable the interval with the transport's `keepAliveMs` option (`0` disables); `createMcpHandler`'s `keepAliveMs` option covers both its `subscriptions/listen` streams and the legacy fallback's per-request transport.

If you still see this error, either keep-alive is disabled (`keepAliveMs: 0`) or an intermediary between client and server buffers or strips SSE data — check for proxies that buffer streaming responses (e.g. nginx without `proxy_buffering off`).

## Recap

- Every heading on this page is the exact message you searched for.
- On stdio, `stdout` carries JSON-RPC; log with `console.error`.
- `TS2589` means two `zod` copies in the dependency tree.
- The SDK raises `ERA_NEGOTIATION_FAILED` and `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION` locally — neither is a wire error.
- Server SSE and the Authorization Server helpers live in `@modelcontextprotocol/server-legacy`.

<!-- maintainers: an entry on this page lives only as long as the surface that
produces it. When an era, package, or supported Node.js version is removed,
delete its entries in the same change — this page never accretes. -->
