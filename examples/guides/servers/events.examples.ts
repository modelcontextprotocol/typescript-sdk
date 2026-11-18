/**
 * Companion example for `docs/servers/events.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs (`pnpm docs:examples`):
 * clients subscribe in process (`handler.fetch`, no port) to what the regions
 * define, and the checks at the end hold the page to its claims.
 *
 *     npx tsx guides/servers/events.examples.ts    # from examples/
 *
 * @module
 */

//#region registerEvent_check
import { EventsExtension } from '@modelcontextprotocol/server/ext/events';
import * as z from 'zod/v4';

// Your upstream: here, a log of ticket changes, where a cursor is a position in the log.
const changes: Array<{ changeId: string; queue: string; ticketId: string; status: string }> = [];

const events = new EventsExtension();

events.registerEvent('ticket.updated', {
    description: 'A ticket in a queue changed status',
    inputSchema: z.object({ queue: z.string() }),
    payloadSchema: z.object({ ticketId: z.string(), status: z.string() }),
    check: (ctx, { queue }, cursor) => {
        if (cursor === null) return { events: [], cursor: String(changes.length) };
        const from = Number(cursor);
        const to = Math.min(changes.length, from + (ctx.maxEvents ?? changes.length));
        const page = changes.slice(from, to).filter(change => change.queue === queue);
        return {
            events: page.map(({ changeId, ticketId, status }) => ({ eventId: changeId, data: { ticketId, status } })),
            cursor: String(to),
            hasMore: to < changes.length
        };
    }
});
//#endregion registerEvent_check

//#region registerEvent_emitOnly
// The open subscriptions, by the id the SDK gives each one.
const open = new Set<string>();

const incidents = events.registerEvent('incident.created', {
    emitOnly: true,
    description: 'A new incident was opened',
    inputSchema: z.object({ severity: z.enum(['P1', 'P2', 'P3']).optional() }),
    payloadSchema: z.object({ incidentId: z.string(), title: z.string(), severity: z.enum(['P1', 'P2', 'P3']) }),
    match: (ctx, event, { severity }) => severity === undefined || event.data.severity === severity,
    onSubscribe: ctx => {
        open.add(ctx.subscriptionId);
    },
    onUnsubscribe: ctx => {
        open.delete(ctx.subscriptionId);
    }
});

// Wherever your upstream reports an incident, for example in its webhook handler:
await incidents.emit({ eventId: 'INC-7', data: { incidentId: 'INC-7', title: 'Checkout is down', severity: 'P1' } });
//#endregion registerEvent_emitOnly

//#region attach
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'helpdesk', version: '1.0.0' });
    events.attach(mcp);
    return mcp;
});
//#endregion attach

// ---------------------------------------------------------------------------
// Harness (not shown on the page): clients that talk to a handler in process.
// ---------------------------------------------------------------------------
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { EventsClientOptions, EventSubscription } from '@modelcontextprotocol/client/ext/events';
import { EventsClientExtension, EventsError as ClientEventsError } from '@modelcontextprotocol/client/ext/events';

const claim = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`servers/events.md: ${what}`);
};

// A 2026-07-28 client whose requests `target` serves in process.
async function connect(
    target: McpHttpHandler,
    options: EventsClientOptions = {}
): Promise<{ client: Client; subscriber: EventsClientExtension }> {
    const client = new Client({ name: 'events-docs-check', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const subscriber = new EventsClientExtension(options);
    subscriber.attach(client);
    await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: (url, init) => target.fetch(new Request(url, init)) })
    );
    return { client, subscriber };
}

// The next `count` events of `subscription`, then it is cancelled.
async function take<T>(subscription: EventSubscription<T>, count: number): Promise<T[]> {
    const data: T[] = [];
    for await (const event of subscription) {
        data.push(event.data);
        if (data.length === count) break;
    }
    return data;
}

// The check type, by push and by poll: both replay the billing changes since cursor '0'.
changes.push(
    { changeId: 'c1', queue: 'billing', ticketId: 'T-7', status: 'open' },
    { changeId: 'c2', queue: 'shipping', ticketId: 'T-8', status: 'open' },
    { changeId: 'c3', queue: 'billing', ticketId: 'T-7', status: 'closed' }
);
const BILLING = JSON.stringify([
    { ticketId: 'T-7', status: 'open' },
    { ticketId: 'T-7', status: 'closed' }
]);
const helpdesk = await connect(handler);
const listed = await helpdesk.subscriber.list();
claim(
    JSON.stringify(listed.events.map(type => [type.name, type.delivery])) ===
        JSON.stringify([
            ['ticket.updated', ['poll', 'push']],
            ['incident.created', ['poll', 'push']]
        ]),
    'without webhook options, both types offer poll and push'
);
for (const delivery of ['push', 'poll'] as const) {
    const tickets = await helpdesk.subscriber.subscribe({ name: 'ticket.updated', arguments: { queue: 'billing' }, cursor: '0', delivery });
    claim(JSON.stringify(await take(tickets, 2)) === BILLING, `${delivery}: check must deliver the billing changes since the cursor`);
}

// Push still streams when the handler answers everything else as plain JSON.
const jsonOnly = createMcpHandler(
    () => {
        const mcp = new McpServer({ name: 'helpdesk', version: '1.0.0' });
        events.attach(mcp);
        return mcp;
    },
    { responseMode: 'json' }
);
const plain = await connect(jsonOnly);
const streamed = await plain.subscriber.subscribe({ name: 'ticket.updated', arguments: { queue: 'billing' }, cursor: '0' });
claim(streamed.deliveryMode === 'push', "push is chosen under responseMode: 'json'");
claim(JSON.stringify(await take(streamed, 2)) === BILLING, "push must stream under responseMode: 'json'");

// The emit-only type: match drops the P2, the hooks track the subscription.
const p1 = await helpdesk.subscriber.subscribe({ name: 'incident.created', arguments: { severity: 'P1' } });
claim(open.size === 1, 'onSubscribe must run when the subscription starts');
await incidents.emit({ eventId: 'INC-8', data: { incidentId: 'INC-8', title: 'Search is slow', severity: 'P2' } });
await incidents.emit({ eventId: 'INC-9', data: { incidentId: 'INC-9', title: 'Login fails', severity: 'P1' } });
claim(
    JSON.stringify(await take(p1, 1)) === JSON.stringify([{ incidentId: 'INC-9', title: 'Login fails', severity: 'P1' }]),
    'match must keep the P2 incident from a P1 subscription'
);
claim(open.size === 0, 'onUnsubscribe must run when the subscription ends');

// Terminate one subscription; its client's loop ends with the error.
const revoked = await helpdesk.subscriber.subscribe({ name: 'incident.created', arguments: {} });
const [revokedId] = open;

//#region terminate
import { EventsError } from '@modelcontextprotocol/server/ext/events';

// Ends one subscription, by the id its hooks received as ctx.subscriptionId.
function revoke(subscriptionId: string): Promise<void> {
    return incidents.terminate(new EventsError('forbidden', 'Access revoked'), { subscriptionId });
}
//#endregion terminate

await revoke(revokedId!);
let ended: unknown;
try {
    await take(revoked, 1);
} catch (error) {
    ended = error;
}
claim(ended instanceof ClientEventsError && ended.kind === 'forbidden', "terminate must end the client's loop with its error");
claim(open.size === 0, 'terminate must run onUnsubscribe');

//#region webhook_setup
import type { ServerContext } from '@modelcontextprotocol/server';
import { nodeWebhookSender } from '@modelcontextprotocol/server/ext/events/node';

// The user your token verifier authenticated; this one puts the subject in AuthInfo.extra.
function principalOf(ctx: ServerContext): string | null {
    const sub = ctx.http?.authInfo?.extra?.sub;
    return typeof sub === 'string' ? sub : null;
}

const webhookEvents = new EventsExtension({
    webhookTtlMs: 30 * 60_000,
    webhookSender: nodeWebhookSender(),
    getPrincipal: principalOf
});
//#endregion webhook_setup

let partial: unknown;
try {
    new EventsExtension({ webhookTtlMs: 30 * 60_000, webhookSender: nodeWebhookSender() });
} catch (error) {
    partial = error;
}
claim(partial instanceof TypeError, 'webhook options without getPrincipal must throw TypeError');

// A stand-in for a shared database: string values, each deleted at its expiry.
const database = new Map<string, { value: string; expiresAt: number }>();
const kv = {
    get: async (key: string) => {
        const entry = database.get(key);
        return entry !== undefined && entry.expiresAt > Date.now() ? entry.value : undefined;
    },
    set: async (key: string, value: string, expiresAt: number) => {
        database.set(key, { value, expiresAt });
    },
    delete: async (key: string) => database.delete(key),
    keys: async function* (prefix: string) {
        for (const key of database.keys()) if (key.startsWith(prefix)) yield key;
    }
};

//#region webhook_store
import type { WebhookSubscriptionRecord, WebhookSubscriptionStore } from '@modelcontextprotocol/server/ext/events';

// What the store needs from a database every replica shares, such as Redis.
interface SharedKeyValue {
    get(key: string): Promise<string | undefined>;
    // The database deletes the key at expiresAt (with Redis: SET ... PXAT expiresAt).
    set(key: string, value: string, expiresAt: number): Promise<void>;
    delete(key: string): Promise<boolean>;
    keys(prefix: string): AsyncIterable<string>;
}

function sharedWebhookStore(kv: SharedKeyValue): WebhookSubscriptionStore {
    const read = async (id: string) => {
        const json = await kv.get(`events:sub:${id}`);
        return json === undefined ? undefined : (JSON.parse(json) as WebhookSubscriptionRecord);
    };
    return {
        get: read,
        async put(record) {
            await kv.set(`events:sub:${record.id}`, JSON.stringify(record), record.expiresAt);
            await kv.set(`events:name:${record.name}:${record.id}`, '', record.expiresAt);
        },
        async delete(id) {
            const record = await read(id);
            if (record !== undefined) await kv.delete(`events:name:${record.name}:${id}`);
            return kv.delete(`events:sub:${id}`);
        },
        async *listByName(name) {
            const prefix = `events:name:${name}:`;
            for await (const key of kv.keys(prefix)) {
                const record = await read(key.slice(prefix.length));
                if (record !== undefined) yield record;
            }
        }
    };
}

// `kv` is your SharedKeyValue client for that database, connected at startup.
const replicated = new EventsExtension({
    webhookTtlMs: 30 * 60_000,
    webhookSender: nodeWebhookSender(),
    webhookStore: sharedWebhookStore(kv),
    getPrincipal: principalOf
});
//#endregion webhook_store

// Two replicas share the store; their webhook POSTs reach the client's receiver in process.
let receive: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
function replica() {
    const extension = new EventsExtension({
        webhookTtlMs: 60_000,
        webhookSender: async ({ url, headers, body }) => {
            const response = await receive(new Request(url, { method: 'POST', headers, body }));
            return { status: response.status, body: await response.text() };
        },
        webhookStore: sharedWebhookStore(kv),
        getPrincipal: () => 'ops'
    });
    const feed = extension.registerEvent('incident.created', {
        emitOnly: true,
        payloadSchema: z.object({ incidentId: z.string(), title: z.string(), severity: z.enum(['P1', 'P2', 'P3']) })
    });
    return { extension, feed };
}
const [first, second] = [replica(), replica()];
const handlerOf = (extension: EventsExtension) =>
    createMcpHandler(() => {
        const mcp = new McpServer({ name: 'helpdesk', version: '1.0.0' });
        extension.attach(mcp);
        return mcp;
    });
const firstHandler = handlerOf(first.extension);
const hooked = await connect(firstHandler, { webhook: { url: 'https://hooks.example.com/mcp/events' } });
receive = hooked.subscriber.createWebhookHandler();
const hook = await hooked.subscriber.subscribe({ name: 'incident.created', arguments: {} });
claim(hook.deliveryMode === 'webhook', 'a client with a webhook URL must subscribe by webhook');
const stored = [...database.keys()].filter(key => key.startsWith('events:sub:'));
claim(stored.length === 1, 'the subscription must be stored in the shared store');
const record = JSON.parse(database.get(stored[0]!)!.value) as WebhookSubscriptionRecord;
claim(record.secret.startsWith('whsec_'), 'the stored record must hold the webhook secret');
// An emit on the other replica reaches the subscription made through the first.
await second.feed.emit({ eventId: 'INC-10', data: { incidentId: 'INC-10', title: 'Payments are down', severity: 'P1' } });
claim(
    JSON.stringify(await take(hook, 1)) === JSON.stringify([{ incidentId: 'INC-10', title: 'Payments are down', severity: 'P1' }]),
    'emit() on one replica must reach a webhook subscription made on another'
);
claim(database.size === 0, 'cancel must delete the record from the shared store');

for (const extension of [webhookEvents, replicated]) extension.attach(new McpServer({ name: 'docs-check', version: '1.0.0' }));
for (const { client } of [helpdesk, plain, hooked]) await client.close();
for (const target of [handler, jsonOnly, firstHandler]) await target.close();
