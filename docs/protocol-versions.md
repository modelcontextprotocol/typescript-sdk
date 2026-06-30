---
shape: explanation
---

# Protocol versions

## Name the two eras

An **era** is a behavior family, not a version string. Every protocol revision from `2024-10-07` through `2025-11-25` opens with the `initialize` handshake and shares one wire behavior — the SDK calls that family `legacy`. The `2026-07-28` revision starts the `modern` era: no `initialize`, a `server/discover` advertisement instead, and a `_meta` envelope on every request.

The SDK speaks both eras from the same `Client` and serves both from the same entry points. A connection's era is decided once, at connect time, and every difference it implies is in [the matrix below](#compare-the-eras).

## Negotiate the era from the client

`versionNegotiation` picks which handshake `connect()` performs. `mode: 'auto'` probes the server with `server/discover` and connects on whichever era it finds.

```ts source="../examples/guides/protocolVersions.examples.ts#versionNegotiation_auto"
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp')));

console.log(client.getProtocolEra());
```

`http://localhost:3000/mcp` is a `createMcpHandler` server — [built below](#serve-both-eras-from-one-entry-point) — so the probe finds the 2026-07-28 era:

```
modern
```

Point the same options at a 2025-only server and `connect()` falls back to the `initialize` handshake on the same connection — one extra round trip, no error.

```ts source="../examples/guides/protocolVersions.examples.ts#versionNegotiation_fallback"
const fallback = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

await fallback.connect(new StreamableHTTPClientTransport(new URL('http://localhost:4000/mcp')));

console.log(fallback.getProtocolEra());
```

`getProtocolEra()` reports the era the connection landed on; it returns `undefined` before `connect()` resolves and never changes after it.

```
legacy
```

## Pin an era

`mode` takes three values; the first is the default.

- Absent, or `mode: 'legacy'` — the 2025 `initialize` handshake, byte for byte. No probe.
- `mode: 'auto'` — probe with `server/discover`; fall back to `initialize` against a 2025-only server.
- `mode: { pin: '2026-07-28' }` — that revision or nothing. A pin never falls back.

Pin against the same 2025-only server and `connect()` rejects instead of falling back.

```ts source="../examples/guides/protocolVersions.examples.ts#versionNegotiation_pin"
import { SdkError } from '@modelcontextprotocol/client';

const pinned = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

try {
    await pinned.connect(new StreamableHTTPClientTransport(new URL('http://localhost:4000/mcp')));
} catch (error) {
    if (error instanceof SdkError) console.log(`${error.code}: ${error.message}`);
}
```

The rejection is a typed, local `SdkError` — nothing reaches the server beyond the probe:

```
ERA_NEGOTIATION_FAILED: Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 via server/discover (no fallback in pin mode)
```

## Understand the probe

`probe` bounds the `server/discover` round trip that `'auto'` and a pin run before anything else.

```ts source="../examples/guides/protocolVersions.examples.ts#versionNegotiation_probe"
const cli = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        versionNegotiation: {
            mode: 'auto',
            probe: {
                timeoutMs: 10_000, // default: the connection's request timeout
                maxRetries: 0 // default: no probe re-sends after a timeout
            }
        }
    }
);
```

A probe timeout is transport-aware. On stdio a silent server is a legacy server, so `connect()` falls back to `initialize` on the same stream; on HTTP silence is an outage, so `connect()` rejects with `SdkError(RequestTimeout)` instead of misreporting a dead server as legacy. One browser exception: an opaque CORS `TypeError` during the probe falls back to the legacy era, because deployed 2025 servers commonly have allow-lists that predate the 2026 headers.

The client's `supportedProtocolVersions` option shapes the probe: its 2026+ entries are the versions the probe offers, and the legacy fallback stays available only while the list keeps a pre-2026 entry. A list with no pre-2026 entry removes the fallback — against a 2025-only server, `connect()` rejects with `SdkError(EraNegotiationFailed)`.

::: warning
Do not default a spawn-per-invocation CLI tool to `'auto'`. On stdio, a legacy server that never answers unknown pre-`initialize` requests stalls `connect()` for the full probe timeout before falling back, and the extra round trip changes recorded transcripts. Keep the default and expose `'auto'` (or a pin) as a flag.
:::

## Serve both eras from one entry point

`createMcpHandler` is the HTTP entry that answered both clients above: it builds a fresh server per request and passes the factory the `era` that request belongs to.

```ts source="../examples/guides/protocolVersions.examples.ts#createMcpHandler_bothEras"
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(({ era }) => {
    const server = new McpServer({ name: 'forecast', version: '1.0.0' });
    server.registerTool(
        'forecast',
        {
            description: 'Forecast for a city',
            inputSchema: z.object({ city: z.string() })
        },
        async ({ city }) => ({ content: [{ type: 'text', text: `${city}: sunny (${era} era)` }] })
    );
    return server;
});
```

By default the handler also serves 2025-era traffic per request (`legacy: 'stateless'`); pass `legacy: 'reject'` to refuse it. Connect one more client with the default mode to the same URL — no probe, the 2025 handshake — and call the tool from both.

```ts source="../examples/guides/protocolVersions.examples.ts#createMcpHandler_callBothEras"
const defaultClient = new Client({ name: 'my-client', version: '1.0.0' });

await defaultClient.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp')));

for (const caller of [client, defaultClient]) {
    const result = await caller.callTool({ name: 'forecast', arguments: { city: 'Berlin' } });
    console.log(caller.getProtocolEra(), JSON.stringify(result.content));
}
```

One endpoint, one factory, two eras — and the era reached the handler:

```
modern [{"type":"text","text":"Berlin: sunny (modern era)"}]
legacy [{"type":"text","text":"Berlin: sunny (legacy era)"}]
```

On stdio, `serveStdio(factory)` from `@modelcontextprotocol/server/stdio` is the same shape per connection: the opening exchange pins the connection's era, and `legacy: 'reject'` refuses 2025 openings. [Serve legacy clients](./serving/legacy-clients.md) owns the `legacy` option and the hosting recipes for both entries.

## Compare the eras

This table is the only copy of the era differences in these docs. `getProtocolEra()` on the client and the factory's `era` on the server tell you which column you are in.

| Axis                                  | 2025 era (`'legacy'`, `2024-10-07` … `2025-11-25`)                       | 2026 era (`'modern'`, `2026-07-28`)                                |
| ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Server HTTP entry                     | `*StreamableHTTPServerTransport`                                         | `createMcpHandler` (`legacy: 'stateless'` also serves 2025)        |
| Server stdio entry                    | `server.connect(new StdioServerTransport())`                             | `serveStdio(factory)` (also serves 2025 unless `legacy: 'reject'`) |
| Client connect                        | `initialize` handshake                                                   | `server/discover` probe (`versionNegotiation`)                     |
| Client identity on the server         | `getClientCapabilities()` / `getClientVersion()` (initialize-scoped)     | `ctx.mcpReq.envelope` (per request)                                |
| Server→client requests                | `ctx.mcpReq.elicitInput` / `requestSampling`, instance `createMessage()` | `return inputRequired(...)` from the handler                       |
| Change notifications                  | unsolicited `list_changed` / `resources/updated`                         | `subscriptions/listen` stream                                      |
| Client cancellation (Streamable HTTP) | POST `notifications/cancelled`                                           | close the request's SSE response stream                            |
| `ctx.mcpReq.log()` level filter       | session-scoped `logging/setLevel`                                        | per-request `logLevel` `_meta` envelope key (absent = no logs)     |
| HTTP `400` with a JSON-RPC error body | `SdkHttpError`                                                           | `ProtocolError`, delivered in-band                                 |
| Era-mismatched spec method (outbound) | n/a                                                                      | `SdkError(MethodNotSupportedByProtocolVersion)`                    |

## Separate deprecation from era

Deprecation is not an era difference. `sampling`, `roots`, and the `logging` capability behind `ctx.mcpReq.log()` are deprecated as of `2026-07-28` (SEP-2577) but stay in the specification for at least twelve months; which API carries each one on a given connection is an era difference, and already has its row in the matrix above. Each deprecated surface opens its own page with a sunset banner naming the migration target; nothing in the matrix moves when a deprecation lands.

## Link here instead of explaining inline

Era differences live on this page and nowhere else. Every other page in these docs spends at most one sentence on an era and links here; do the same in your own server's documentation.

> The wire encoding of structured results differs by protocol era — see [Protocol versions](./protocol-versions.md).

## Recap

- An era is a behavior family: `legacy` covers `2024-10-07` through `2025-11-25`, `modern` starts at `2026-07-28`.
- `versionNegotiation` picks the client handshake; the default is the unchanged 2025 `initialize`, no probe.
- `mode: 'auto'` probes with `server/discover` and falls back to `initialize`; a pin never falls back and rejects with `SdkError(EraNegotiationFailed)`.
- `getProtocolEra()` reports the negotiated era on the client; the `createMcpHandler` / `serveStdio` factory receives the `era` it is about to serve.
- The behavior matrix on this page is the only copy; every other page links here in one line.
- Deprecation (SEP-2577) is not an era difference.
