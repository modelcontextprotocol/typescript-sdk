/**
 * Companion example for `docs/clients/events.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs (`pnpm docs:examples`)
 * against a helpdesk server served in process (`handler.fetch`, no port) on
 * 2026-07-28, and prints the output the page quotes.
 *
 *     npx tsx guides/clients/events.examples.ts    # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { EventsError as ServerEventsError, EventsExtension } from '@modelcontextprotocol/server/ext/events';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Harness server (not shown on the page): ticket changes behind a check
// function, and webhook POSTs handed to the page's receiver in process.
// ---------------------------------------------------------------------------
const changes: Array<{ changeId: string; queue: string; ticketId: string; status: string }> = [];
let receive: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
const helpdesk = new EventsExtension({
    checkIntervalMs: 50,
    webhookTtlMs: 60_000,
    webhookSender: async ({ url, headers, body }) => {
        const response = await receive(new Request(url, { method: 'POST', headers, body }));
        return { status: response.status, body: await response.text() };
    },
    getPrincipal: () => 'ops-console'
});
let started = false;
const tickets = helpdesk.registerEvent('ticket.updated', {
    inputSchema: z.object({ queue: z.string() }),
    payloadSchema: z.object({ ticketId: z.string(), status: z.string() }),
    check: (_ctx, { queue }, cursor) => {
        if (cursor === null) return { events: [], cursor: String(changes.length) };
        const page = changes.slice(Number(cursor)).filter(change => change.queue === queue);
        return {
            events: page.map(({ changeId, ticketId, status }) => ({ eventId: changeId, data: { ticketId, status } })),
            cursor: String(changes.length)
        };
    },
    // The first subscription sets the queue moving: one change, once it has started.
    onSubscribe: () => {
        if (started) return;
        started = true;
        setTimeout(() => changes.push({ changeId: 'c1', queue: 'billing', ticketId: 'T-7', status: 'open' }), 0);
    }
});
const handler = createMcpHandler(() => new McpServer({ name: 'helpdesk', version: '1.0.0' }, { extensions: [helpdesk] }));
const inProcess = () =>
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) });
const transport = inProcess();

// Every `console.log` line, recorded for the checks at the end.
const logged: string[] = [];
const realLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
    logged.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    realLog(...args);
};

//#region subscribe_basic
import { Client } from '@modelcontextprotocol/client';
import { EventsClientExtension } from '@modelcontextprotocol/client/ext/events';

const events = new EventsClientExtension();
const client = new Client({ name: 'ops-console', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' }, extensions: [events] });
await client.connect(transport);

const subscription = await events.subscribe({ name: 'ticket.updated', arguments: { queue: 'billing' } });
for await (const event of subscription) {
    console.log(event.name, event.data);
    break;
}
//#endregion subscribe_basic

const firstMode = subscription.deliveryMode;
// While nothing is subscribed, the ticket is closed.
changes.push({ changeId: 'c2', queue: 'billing', ticketId: 'T-7', status: 'closed' });

//#region subscribe_cursor
// Save the cursor; it covers every event the loop finished with.
const saved = subscription.cursor;

// Later, maybe in a new process: resume from the saved cursor.
const resumed = await events.subscribe({ name: 'ticket.updated', arguments: { queue: 'billing' }, cursor: saved });
for await (const event of resumed) {
    console.log(event.name, event.data);
    if (event.data.status === 'closed') break;
}
//#endregion subscribe_cursor

//#region webhook_receiver
import { Hono } from 'hono';

const hooked = new EventsClientExtension({ webhook: { url: 'https://hooks.example.com/mcp/events' } });
const handleWebhook = hooked.createWebhookHandler();

// Serve the receiver at the webhook URL from any fetch-style server; here, Hono.
const app = new Hono();
app.post('/mcp/events', c => handleWebhook(c.req.raw));
//#endregion webhook_receiver

//#region errors
import { EventsError } from '@modelcontextprotocol/client/ext/events';

try {
    const refused = await events.subscribe({ name: 'ticket.updated', arguments: { queue: 42 } });
    for await (const event of refused) console.log(event.data);
} catch (error) {
    if (!(error instanceof EventsError)) throw error;
    console.log(error.kind);
}
//#endregion errors

// Claims the page makes, checked on every run.
const claim = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`clients/events.md: ${what}`);
};
claim(
    JSON.stringify(logged) ===
        JSON.stringify([
            'ticket.updated {"ticketId":"T-7","status":"open"}',
            'ticket.updated {"ticketId":"T-7","status":"open"}',
            'ticket.updated {"ticketId":"T-7","status":"closed"}',
            'invalidParams'
        ]),
    'the page quotes this output, in this order'
);
claim(events.supported && firstMode === 'push', 'without a webhook URL, a subscription picks push where the server offers it');

// The webhook client: set up and connected like the first one, its subscriptions take webhook.
const hookedClient = new Client({ name: 'ops-console', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' }, extensions: [hooked] });
await hookedClient.connect(inProcess());
receive = async request => app.fetch(request);
const hook = await hooked.subscribe({ name: 'ticket.updated', arguments: { queue: 'billing' }, cursor: '0' });
claim(hook.deliveryMode === 'webhook', 'with a webhook URL, a subscription prefers webhook');
// Each event is its own POST, so they may arrive in either order.
const delivered: string[] = [];
for await (const event of hook) {
    delivered.push(JSON.stringify(event.data));
    if (delivered.length === 2) break;
}
claim(
    JSON.stringify(delivered.toSorted()) === JSON.stringify(['{"ticketId":"T-7","status":"closed"}', '{"ticketId":"T-7","status":"open"}']),
    'the receiver must deliver the webhook POSTs into the subscription'
);

// A server that ends the subscription ends the loop with an EventsError saying why.
const watched = await events.subscribe({ name: 'ticket.updated', arguments: { queue: 'billing' } });
await tickets.terminate(new ServerEventsError('forbidden', 'Access revoked'));
let ended: unknown;
try {
    for await (const event of watched) console.log(event.data);
} catch (error) {
    ended = error;
}
claim(ended instanceof EventsError && ended.kind === 'forbidden', 'a terminated subscription must end the loop with EventsError');

// Closing the client ends its subscriptions with SdkError(ConnectionClosed).
const last = await events.subscribe({ name: 'ticket.updated', arguments: { queue: 'billing' } });
const next = last[Symbol.asyncIterator]().next();
await client.close();
let closed: unknown;
try {
    await next;
} catch (error) {
    closed = error;
}
claim(
    closed instanceof SdkError && closed.code === SdkErrorCode.ConnectionClosed,
    'closing the client must end subscriptions with ConnectionClosed'
);

await hookedClient.close();
await handler.close();
