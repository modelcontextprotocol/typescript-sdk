# MCP Events SDK — Quick Reference for Example Authors

The Events primitive lets MCP servers deliver domain events (new email, PR opened, pod phase changed) to clients via three delivery modes: **poll**, **push**, and **webhook**. The server author writes one `registerEvent` call per event type; the SDK handles delivery mechanics.

## Core API

```ts
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    {
        events: {
            push: { heartbeatIntervalMs: 10_000 }, // optional
            webhook: { ttlMs: 5 * 60 * 1000 } // optional; omit to disable webhook mode
        }
    }
);
```

### `server.registerEvent(name, config, checkCallback)`

```ts
server.registerEvent(
    'source.event_name',
    {
        description: 'Human-readable description',
        inputSchema: z.object({                     // subscription params schema
            filter: z.string().optional()
        }),
        payloadSchema: z.object({                   // event data shape (advisory)
            id: z.string(),
            ...
        }),
        hooks: {                                    // optional lifecycle hooks
            onSubscribe: async (subId, params, ctx) => { /* set up upstream */ },
            onUnsubscribe: async (subId, params, ctx) => { /* tear down */ }
        },
        matches: (params, data) => true,            // filter for broadcast emit()
        bufferEmits: { capacity: 500 }              // opt-in: emit() visible to poll
    },
    // The check callback — the one function that backs all delivery modes.
    async (params, cursor, ctx) => {
        if (cursor === null) {
            // Bootstrap: return empty events + a fresh cursor representing "now"
            return { events: [], cursor: freshCursor(), nextPollSeconds: 30 };
        }
        // Resume: fetch events since `cursor`
        const delta = await upstream.fetchSince(cursor);
        return {
            events: delta.map(d => ({ name: 'source.event_name', data: {...} })),
            cursor: delta.newCursor,
            nextPollSeconds: 30,          // how long until next poll
            hasMore: delta.hasMore        // if true, client polls again immediately
        };
    }
);
```

**Check callback contract:**

- `cursor: null` means bootstrap. Return `{ events: [], cursor: <now> }`.
- `cursor: string` means resume. Return events since that position.
- Throw `new ProtocolError(CURSOR_EXPIRED, msg)` if the cursor is stale (e.g., upstream 410 Gone). The client will re-bootstrap with `cursor: null`.
- `nextPollSeconds` drives the SDK's internal poll loops for push/webhook and the client's poll cadence. Return it every time.

### `server.emitEvent(name, data, options?)`

For real-time push/webhook delivery that bypasses the check callback. Use when the upstream pushes to you (webhooks, WebSocket, change streams).

```ts
// Broadcast — delivered to all subscriptions matching the `matches` filter.
server.emitEvent('source.event_name', { id: 'evt-1', ... });

// Targeted — delivered to exactly one subscription ID.
server.emitEvent('source.event_name', { ... }, { subscriptionId: 'sub_abc' });
```

**If you want poll clients to see emits**, set `bufferEmits: { capacity: N }` on the event config. The SDK buffers broadcast emits in a ring buffer and merges them into poll responses.

### `server.terminateEventSubscription(subId, reason?)`

Kill a single active push/webhook subscription (e.g., user's access revoked).

## Patterns by upstream shape

| Upstream                                                                          | Pattern                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Poll-only API with cursor (Gmail historyId, Stripe `/events`)                     | Check callback only. No `emit()`.                                                                                                                                                     |
| Webhook inbound (GitHub, PagerDuty, Shopify)                                      | HTTP route verifies HMAC → `server.emitEvent(...)`. Check callback returns `{ events: [], cursor: 'emit-only', nextPollSeconds: N }`. Add `bufferEmits` so poll clients see them.     |
| Outbound WebSocket/gRPC stream (Slack Socket Mode, Salesforce Pub/Sub, k8s watch) | Open stream in `onSubscribe` (refcounted), push via `emitEvent()` in message handler, close in `onUnsubscribe`.                                                                       |
| Dual-path (webhook + cursor API)                                                  | Check callback reads the durable cursor API. Webhook handler calls `emitEvent()` for low-latency. Client gets whichever arrives first; `eventId` dedup at the client handles overlap. |

## Error codes

```ts
import { ProtocolError, CURSOR_EXPIRED, EVENT_NOT_FOUND } from '@modelcontextprotocol/core';

throw new ProtocolError(CURSOR_EXPIRED, 'Upstream returned 410 Gone; resync needed');
```

## Example file conventions

- One file per data source: `examples/server/src/events-stress/<source>.ts`
- Each file calls its real upstream SDK (`googleapis`, `stripe`, `discord.js`, etc.). Configuration comes from environment variables — missing required vars throw at startup.
- Top-of-file comment includes numbered setup steps (credential acquisition, webhook tunnel setup) and an env-var table.
- Export `createServer(clientOverride?)` so tests can inject a mock client without needing credentials.
- Include a `main()` guard (`if (import.meta.url === ...)`) that connects over stdio so the file is directly runnable.
- See the [README](./README.md) for the full server list and common setup patterns.
