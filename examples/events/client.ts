/**
 * Connects to `./server.ts` and subscribes to both of its event types in every
 * delivery mode the leg offers: poll and push over stdio, and over HTTP also
 * webhook, with the receiver served on 127.0.0.1. It bumps the counter once
 * and checks what each subscription receives.
 *
 * Spawns the sibling `server.ts` over stdio by default, or connects to a
 * running endpoint under `--http <url>`. See `examples/CONTRIBUTING.md` for
 * the canonical shape.
 */
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { DeliveryMode, EventSubscription } from '@modelcontextprotocol/client/ext/events';
import { EventsClientExtension } from '@modelcontextprotocol/client/ext/events';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Where the webhook receiver listens; server.ts trusts this origin.
const RECEIVER_PORT = Number(process.env.EVENTS_RECEIVER_PORT ?? '8599');

const { transport, url } = parseExampleArgs();
const http = transport === 'http';

// Events is a 2026-07-28 extension: negotiate the modern revision.
const client = new Client({ name: 'events-example-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
// Webhook delivery needs a URL the server can POST to: this process, on the HTTP leg.
const events = new EventsClientExtension(http ? { webhook: { url: `http://127.0.0.1:${RECEIVER_PORT}/events` } } : {});
events.attach(client);

// The receiver is up before any subscribe, since the server verifies the endpoint first.
let receiver: ServerType | undefined;
if (http) {
    receiver = await new Promise<ServerType>(resolve => {
        const server = serve({ fetch: events.createWebhookHandler(), port: RECEIVER_PORT, hostname: '127.0.0.1' }, () => resolve(server));
    });
}

await client.connect(
    http
        ? new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => 'demo-token' } })
        : new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] })
);

// 1. List: both event types, in every mode the server offers on this leg.
const modes: DeliveryMode[] = http ? ['poll', 'push', 'webhook'] : ['poll', 'push'];
const { events: types } = await events.list();
check.deepEqual(
    types.map(type => [type.name, type.delivery]),
    [
        ['counter.changed', modes],
        ['timer.tick', modes]
    ]
);

// 2. Subscribe to each type in each mode; every subscription starts from now.
const subscriptions: Array<[DeliveryMode, EventSubscription<{ value: number }>, EventSubscription<{ tick: number }>]> = [];
for (const delivery of modes) {
    const counter = await events.subscribe<{ value: number }>({ name: 'counter.changed', delivery });
    const timer = await events.subscribe<{ tick: number }>({ name: 'timer.tick', delivery });
    subscriptions.push([delivery, counter, timer]);
}

// 3. Bump the counter once, then read one event from each subscription.
await client.callTool({ name: 'increment', arguments: {} });

// Leaving a `for await` loop cancels the subscription (for webhook, `events/unsubscribe`).
async function firstEvent<T>(subscription: EventSubscription<T>) {
    for await (const event of subscription) return event;
    throw new Error('the subscription ended before its first event');
}

for (const [delivery, counter, timer] of subscriptions) {
    check.equal(counter.deliveryMode, delivery);
    check.equal(timer.deliveryMode, delivery);
    // The check type reads the counter's history: value 1 reaches every mode.
    const changed = await firstEvent(counter);
    check.equal(changed.name, 'counter.changed');
    check.deepEqual(changed.data, { value: 1 });
    // The emit-only type delivers ticks emitted after the subscription started.
    const ticked = await firstEvent(timer);
    check.equal(ticked.name, 'timer.tick');
    check.ok(Number.isInteger(ticked.data.tick) && ticked.data.tick > 0);
}

console.log(`[client] ${transport} leg: counter and timer events by ${modes.join(', ')}`);
await client.close();
await new Promise(resolve => (receiver === undefined ? resolve(undefined) : receiver.close(resolve)));
