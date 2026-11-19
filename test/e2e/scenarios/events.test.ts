/**
 * Self-contained test bodies for the Events extension (SEP-3415).
 *
 * Each body builds its own EventsExtension, passes it in the extensions of
 * the servers its factory builds (the entry builds a server per request, so
 * one extension serves them all), wires a real Client and asserts through EventsClientExtension,
 * raw events/* requests or the recorded HTTP exchanges. Webhook POSTs go to an
 * in-process endpoint through the extension's webhookSender: the client's
 * receiver, or a stand-in that echoes verification challenges. Bodies that
 * send events/* pass EVENTS_WIRE so the wire sniffer permits them.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { Client, SdkError, SdkErrorCode, SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/client';
import type { EventsClientOptions, EventSubscription } from '@modelcontextprotocol/client/ext/events';
import {
    EVENTS_EXTENSION_ID,
    EventsClientExtension,
    EventsError,
    NoCompatibleDeliveryModeError
} from '@modelcontextprotocol/client/ext/events';
import { McpServer } from '@modelcontextprotocol/server';
import type { EventsOptions, WebhookSender } from '@modelcontextprotocol/server/ext/events';
import {
    EventsError as ServerEventsError,
    EventsExtension,
    InMemoryWebhookSubscriptionStore
} from '@modelcontextprotocol/server/ext/events';
import { expect, vi } from 'vitest';
import * as z from 'zod/v4';

import type { RecordedHttpExchange, Wired } from '../helpers/index';
import { defined, modernEnvelopeMeta, modernStandardHeaders, tapWire, wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const EVENTS_WIRE = { allowCustomMethods: true } as const;
const NOTE = 'note';
const HOOK_URL = 'https://hooks.example.com/mcp/events';
const SECRET = `whsec_${btoa('a'.repeat(32))}`;
const ROTATED = `whsec_${btoa('b'.repeat(32))}`;
// The client polls as often as a test's server asks.
const FAST: EventsClientOptions = { pollIntervalFloorMs: 20 };
const Loose = z.looseObject({});
const NoteInput = z.object({ tag: z.string().optional() });
const NotePayload = z.object({ text: z.string() });

type Note = z.infer<typeof NotePayload>;

const newClient = (): Client => new Client({ name: 'c', version: '0' });

function serving(events: EventsExtension): () => McpServer {
    return () => new McpServer({ name: 's', version: '0' }, { extensions: [events] });
}

/** An extension with one emit-only event type, `note`. */
function noteEvents(options?: EventsOptions) {
    const events = new EventsExtension(options);
    const note = events.registerEvent(NOTE, { emitOnly: true, inputSchema: NoteInput, payloadSchema: NotePayload });
    return { events, note };
}

/** A client with an EventsClientExtension in its extensions, ready for wire(). */
function eventsClient(options: EventsClientOptions = FAST): { client: Client; clientEvents: EventsClientExtension } {
    const clientEvents = new EventsClientExtension(options);
    const client = new Client({ name: 'c', version: '0' }, { extensions: [clientEvents] });
    return { client, clientEvents };
}

function raw(client: Client, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return client.request({ method, ...(params !== undefined && { params }) }, Loose);
}

/** The error a promise rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected the promise to reject');
}

/** The next `count` events' data, leaving the subscription open. */
async function take<T>(subscription: EventSubscription<T>, count = 1): Promise<T[]> {
    const iterator = subscription[Symbol.asyncIterator]();
    const data: T[] = [];
    while (data.length < count) {
        const result = await iterator.next();
        if (result.done === true) throw new Error('the subscription ended');
        data.push(result.value.data);
    }
    return data;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Frame = JSONRPCMessage & { method: string; params: Record<string, unknown> & { _meta: Record<string, unknown> } };

/** The ids of the events/stream requests the client sent. */
function streamIds(tap: ReturnType<typeof tapWire>): unknown[] {
    return tap.sent.flatMap(message => ('id' in message && 'method' in message && message.method === 'events/stream' ? [message.id] : []));
}

/** The messages the client received for the events/stream request `id`, in order. */
function framesOf(tap: ReturnType<typeof tapWire>, id: unknown): Frame[] {
    return tap.received.filter((message): message is Frame => {
        const meta = 'params' in message ? (message.params?._meta as Record<string, unknown> | undefined) : undefined;
        return meta?.[SUBSCRIPTION_ID_META_KEY] === id;
    });
}

/** The recorded HTTP exchanges for one MCP method, by their Mcp-Method header. */
function exchangesFor(wired: Wired, method: string): RecordedHttpExchange[] {
    return (wired.httpLog ?? []).filter(exchange => exchange.requestHeaders.get('mcp-method') === method);
}

// ───────────────────────────────────────────────────────────────────────────────
// Webhook plumbing: an in-process endpoint behind the server's webhookSender
// ───────────────────────────────────────────────────────────────────────────────

/** One webhook POST, as the server's sender handed it over, and the endpoint's answer. */
interface Post {
    readonly url: string;
    readonly headers: Headers;
    readonly body: string;
    readonly json: Record<string, unknown>;
    readonly trusted: boolean;
    status?: number;
}

type Endpoint = (request: Request) => Promise<Response>;

/** An endpoint that echoes verification challenges and acknowledges everything else. */
async function echoing(request: Request): Promise<Response> {
    const body = (await request.json()) as { type?: string; challenge?: string };
    return body.type === 'verification' ? Response.json({ challenge: body.challenge }) : new Response(null, { status: 200 });
}

/** A webhookSender that records each POST and hands it to `endpoint` as a Request (no network). */
function senderTo(endpoint: Endpoint, posts: Post[]): WebhookSender {
    return async ({ url, headers, body, trusted }) => {
        const post: Post = { url, headers: new Headers(headers), body, json: JSON.parse(body) as Record<string, unknown>, trusted };
        posts.push(post);
        const response = await endpoint(new Request(url, { method: 'POST', headers, body }));
        post.status = response.status;
        return { status: response.status, body: await response.text() };
    };
}

/** Webhook mode on, every subscriber the principal `alice`. */
function webhookOptions(sender: WebhookSender, more: EventsOptions = {}): EventsOptions {
    return { webhookTtlMs: 60_000, webhookSender: sender, getPrincipal: () => 'alice', ...more };
}

function eventPosts(posts: Post[]): Post[] {
    return posts.filter(post => post.json.type === undefined);
}

function hook(secret = SECRET, url = HOOK_URL) {
    return { mode: 'webhook', url, secret };
}

/** The Standard Webhooks signature of `post` under `secret`: v1, base64 HMAC-SHA256 of `id.timestamp.body`. */
async function signatureOf(secret: string, post: Post): Promise<string> {
    const keyBytes = Uint8Array.from(atob(secret.slice('whsec_'.length)), char => char.codePointAt(0)!);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = `${post.headers.get('webhook-id')}.${post.headers.get('webhook-timestamp')}.${post.body}`;
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)));
    return `v1,${btoa(String.fromCodePoint(...mac))}`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Capability and discovery
// ───────────────────────────────────────────────────────────────────────────────

verifies('events:capability:declared', async ({ transport }: TestArgs) => {
    const { events } = noteEvents();
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

    const settings = client.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION_ID];
    expect(settings).toBeTypeOf('object');
    expect(settings).not.toBeNull();
    expect(Array.isArray(settings)).toBe(false);
    // Without listChanged: true, a listen stream that asks for event-list changes is acknowledged without them.
    if ((settings as { listChanged?: unknown }).listChanged !== true) {
        const tap = tapWire(client);
        const filter: Record<string, unknown> = { eventsListChanged: true };
        const subscription = await client.listen(filter as Parameters<Client['listen']>[0]);

        const ack = tap.received.find(message => 'method' in message && message.method === 'notifications/subscriptions/acknowledged');
        expect(defined(ack, 'the acknowledgement')).toMatchObject({ params: { notifications: expect.any(Object) } });
        expect((ack as Frame).params.notifications).not.toHaveProperty('eventsListChanged');
        expect(subscription.honoredFilter).not.toHaveProperty('eventsListChanged');
        await subscription.close();
        await subscription.closed;
    }
});

verifies('typescript:events:capability:empty', async ({ transport }: TestArgs) => {
    const { events } = noteEvents();
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

    expect(client.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION_ID]).toEqual({});
});

verifies('events:fallback:method-not-found', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using wired = await wire(transport, () => new McpServer({ name: 's', version: '0' }), client, EVENTS_WIRE);
    const requests: Array<[string, Record<string, unknown>]> = [
        ['events/list', {}],
        ['events/poll', { name: NOTE, cursor: null }],
        ['events/stream', { name: NOTE, cursor: null }],
        ['events/subscribe', { name: NOTE, delivery: hook() }],
        ['events/unsubscribe', { name: NOTE, delivery: { url: HOOK_URL } }]
    ];

    for (const [method, params] of requests) {
        await expect(raw(client, method, params)).rejects.toBeDefined();
        const [exchange] = exchangesFor(wired, method);
        const answer = (await defined(exchange, method).response.json()) as { error?: { code: number } };
        expect(answer.error?.code).toBe(-32_601);
    }
});

verifies('events:list:descriptors', async ({ transport }: TestArgs) => {
    const events = new EventsExtension();
    events.registerEvent('incident.created', {
        emitOnly: true,
        description: 'Fires when an incident is created',
        inputSchema: z.object({ severity: z.enum(['P1', 'P2']).optional() }),
        payloadSchema: z.object({ incidentId: z.string() }),
        _meta: { 'example.com/tier': 'gold' }
    });
    events.registerEvent('tick', { payloadSchema: z.object({ n: z.number() }), check: (_ctx, _args, cursor) => ({ events: [], cursor }) });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

    const listed = await raw(client, 'events/list');

    expect(listed.events).toEqual([
        {
            name: 'incident.created',
            description: 'Fires when an incident is created',
            delivery: ['poll', 'push'],
            inputSchema: expect.objectContaining({ type: 'object', properties: { severity: { type: 'string', enum: ['P1', 'P2'] } } }),
            payloadSchema: expect.objectContaining({ type: 'object', properties: { incidentId: { type: 'string' } } }),
            _meta: { 'example.com/tier': 'gold' }
        },
        {
            name: 'tick',
            delivery: ['poll', 'push'],
            inputSchema: { type: 'object' },
            payloadSchema: expect.objectContaining({ type: 'object', properties: { n: { type: 'number' } } })
        }
    ]);
});

verifies('events:list:delivery', async ({ transport }: TestArgs) => {
    const MODES = ['poll', 'push', 'webhook'];
    const optOuts = [{}, { poll: false }, { push: false }, { webhook: false }] as const;
    const configurations = [
        { events: new EventsExtension(), optOuts },
        { events: new EventsExtension(webhookOptions(senderTo(echoing, []))), optOuts: [...optOuts, { poll: false, push: false }] }
    ];
    for (const { events, optOuts: definitions } of configurations) {
        for (const [index, delivery] of definitions.entries()) {
            events.registerEvent(`e${index}`, { emitOnly: true, payloadSchema: NotePayload, delivery });
        }
        const client = newClient();
        await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

        const { events: descriptors } = (await raw(client, 'events/list')) as { events: Array<{ delivery: string[] }> };

        expect(descriptors).toHaveLength(definitions.length);
        for (const { delivery } of descriptors) {
            expect(delivery.length).toBeGreaterThan(0);
            expect(new Set(delivery).size).toBe(delivery.length);
            for (const mode of delivery) expect(MODES).toContain(mode);
        }
    }
});

verifies('typescript:events:delivery:inferred', async ({ transport }: TestArgs) => {
    const configurations = [
        { events: new EventsExtension(), all: ['poll', 'push'] },
        { events: new EventsExtension(webhookOptions(senderTo(echoing, []))), all: ['poll', 'push', 'webhook'] }
    ];
    for (const { events, all } of configurations) {
        events.registerEvent('default', { emitOnly: true, payloadSchema: NotePayload });
        events.registerEvent('no-push', { emitOnly: true, payloadSchema: NotePayload, delivery: { push: false } });
        events.registerEvent('no-poll', { emitOnly: true, payloadSchema: NotePayload, delivery: { poll: false } });
        events.registerEvent('no-webhook', { emitOnly: true, payloadSchema: NotePayload, delivery: { webhook: false } });
        const client = newClient();
        await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

        const { events: descriptors } = (await raw(client, 'events/list')) as { events: Array<{ name: string; delivery: string[] }> };

        expect(Object.fromEntries(descriptors.map(({ name, delivery }) => [name, delivery]))).toEqual({
            default: all,
            'no-push': all.filter(mode => mode !== 'push'),
            'no-poll': all.filter(mode => mode !== 'poll'),
            'no-webhook': ['poll', 'push']
        });
    }
    const plain = new EventsExtension();
    expect(() =>
        plain.registerEvent('nothing', { emitOnly: true, payloadSchema: NotePayload, delivery: { poll: false, push: false } })
    ).toThrow(TypeError);
    const withWebhook = new EventsExtension(webhookOptions(senderTo(echoing, [])));
    expect(() =>
        withWebhook.registerEvent('webhook-only', { emitOnly: true, payloadSchema: NotePayload, delivery: { poll: false, push: false } })
    ).not.toThrow();
});

// ───────────────────────────────────────────────────────────────────────────────
// Poll
// ───────────────────────────────────────────────────────────────────────────────

verifies('events:poll:bootstrap', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents();
    // A check that would return events: a null cursor still answers with none.
    events.registerEvent('ticket', {
        payloadSchema: NotePayload,
        check: () => ({ events: [{ eventId: 'old', data: { text: 'old' } }], cursor: 't1' })
    });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    await note.emit({ data: { text: 'before' } });

    const bootstrap = await raw(client, 'events/poll', { name: NOTE, cursor: null });
    expect(bootstrap).toMatchObject({ events: [], cursor: expect.any(String), truncated: false, hasMore: false });
    await expect(raw(client, 'events/poll', { name: 'ticket', cursor: null })).resolves.toMatchObject({ events: [], cursor: 't1' });

    await note.emit({ data: { text: 'after' } });
    const next = await raw(client, 'events/poll', { name: NOTE, cursor: bootstrap.cursor });
    expect((next.events as Array<{ data: Note }>).map(event => event.data.text)).toEqual(['after']);
});

verifies('events:poll:replay', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents({ defaultNextPollMs: 1234 });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const { cursor } = await raw(client, 'events/poll', { name: NOTE, cursor: null });
    await note.emit({ eventId: 'n1', data: { text: 'one' } });
    await note.emit({ eventId: 'n2', data: { text: 'two' } });

    const replay = await raw(client, 'events/poll', { name: NOTE, cursor });

    expect(replay).toMatchObject({
        events: [
            { eventId: 'n1', name: NOTE, timestamp: expect.any(String), data: { text: 'one' } },
            { eventId: 'n2', name: NOTE, timestamp: expect.any(String), data: { text: 'two' } }
        ],
        cursor: expect.any(String),
        truncated: false,
        hasMore: false,
        nextPollMs: 1234
    });
    await expect(raw(client, 'events/poll', { name: NOTE, cursor: replay.cursor })).resolves.toMatchObject({ events: [], hasMore: false });
});

verifies('events:poll:has-more', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents();
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    let { cursor } = await raw(client, 'events/poll', { name: NOTE, cursor: null });
    for (const text of ['a', 'b', 'c', 'd', 'e']) await note.emit({ data: { text } });

    const pages: Array<{ texts: string[]; hasMore: unknown }> = [];
    for (let page = 0; page < 3; page++) {
        const result = await raw(client, 'events/poll', { name: NOTE, cursor, maxEvents: 2 });
        expect(result.cursor).not.toBe(cursor);
        pages.push({ texts: (result.events as Array<{ data: Note }>).map(event => event.data.text), hasMore: result.hasMore });
        cursor = result.cursor;
    }

    expect(pages).toEqual([
        { texts: ['a', 'b'], hasMore: true },
        { texts: ['c', 'd'], hasMore: true },
        { texts: ['e'], hasMore: false }
    ]);
});

verifies('events:poll:truncated', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents({ emitBuffer: { maxEvents: 2 } });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const { cursor } = await raw(client, 'events/poll', { name: NOTE, cursor: null });
    for (const text of ['n1', 'n2', 'n3', 'n4']) await note.emit({ data: { text } });

    const gap = await raw(client, 'events/poll', { name: NOTE, cursor });

    expect(gap).toMatchObject({ events: [], truncated: true, cursor: expect.any(String) });
    expect(gap.cursor).not.toBe(cursor);
    const resumed = await raw(client, 'events/poll', { name: NOTE, cursor: gap.cursor });
    expect(resumed).toMatchObject({ truncated: false, events: [{ data: { text: 'n3' } }, { data: { text: 'n4' } }] });
});

verifies('events:poll:errors', async ({ transport }: TestArgs) => {
    const { events } = noteEvents();
    events.registerEvent('push-only', { emitOnly: true, payloadSchema: NotePayload, delivery: { poll: false } });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

    await expect(raw(client, 'events/poll', { name: 'missing', cursor: null })).rejects.toMatchObject({ code: -32_023 });
    await expect(raw(client, 'events/poll', { name: NOTE, arguments: { tag: 5 }, cursor: null })).rejects.toMatchObject({ code: -32_602 });
    await expect(raw(client, 'events/poll', { name: 'push-only', cursor: null })).rejects.toMatchObject({
        code: -32_026,
        data: { feature: 'deliveryMode', value: 'poll' }
    });
});

// ───────────────────────────────────────────────────────────────────────────────
// Cursors
// ───────────────────────────────────────────────────────────────────────────────

verifies('events:cursor:absent-is-null', async ({ transport }: TestArgs) => {
    {
        // Requests: no cursor field starts from now, as cursor: null does.
        const { events, note } = noteEvents(webhookOptions(senderTo(echoing, [])));
        const client = newClient();
        await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
        await note.emit({ data: { text: 'before' } });

        const withNull = await raw(client, 'events/poll', { name: NOTE, cursor: null });
        await expect(raw(client, 'events/poll', { name: NOTE })).resolves.toMatchObject({
            events: [],
            cursor: withNull.cursor,
            truncated: false
        });
        await expect(raw(client, 'events/subscribe', { name: NOTE, delivery: hook() })).resolves.toMatchObject({
            cursor: withNull.cursor,
            truncated: false
        });
    }
    {
        // Results: a server that never writes cursor; the client delivers, and polls from null after resuming from c5.
        const polls: Array<Record<string, unknown>> = [];
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.server.registerCapabilities({ extensions: { [EVENTS_EXTENSION_ID]: {} } });
            s.server.setRequestHandler('events/list', { params: Loose }, () => ({
                events: [{ name: NOTE, delivery: ['poll'], inputSchema: { type: 'object' }, payloadSchema: { type: 'object' } }]
            }));
            s.server.setRequestHandler('events/poll', { params: Loose }, params => {
                polls.push(params);
                const events =
                    polls.length === 2 ? [{ eventId: 'e1', name: NOTE, timestamp: new Date().toISOString(), data: { text: 'one' } }] : [];
                return { events, nextPollMs: 0 };
            });
            return s;
        };
        const { client, clientEvents } = eventsClient();
        await using _ = await wire(transport, makeServer, client, EVENTS_WIRE);

        const subscription = await clientEvents.subscribe<Note>({ name: NOTE, cursor: 'c5' });
        expect(await take(subscription)).toEqual([{ text: 'one' }]);
        await vi.waitFor(() => expect(polls.length).toBeGreaterThan(2));
        expect(subscription.cursor).toBeNull();
        await subscription.cancel();
        expect(polls[0]?.cursor).toBe('c5');
        for (const params of polls.slice(1)) expect(params.cursor ?? null).toBeNull();
    }
});

verifies('events:cursor:max-age', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents();
    // A check type whose upstream has one event ten minutes old and one from now.
    events.registerEvent('ticket', {
        payloadSchema: NotePayload,
        check: (_ctx, _args, cursor) =>
            cursor === null
                ? { events: [], cursor: 't0' }
                : {
                      events: [
                          { eventId: 'stale', timestamp: new Date(Date.now() - 600_000).toISOString(), data: { text: 'stale' } },
                          { eventId: 'fresh', timestamp: new Date().toISOString(), data: { text: 'fresh' } }
                      ],
                      cursor: 't2'
                  }
    });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const texts = (result: Record<string, unknown>) => (result.events as Array<{ data: Note }>).map(event => event.data.text);
    const { cursor: start } = await raw(client, 'events/poll', { name: NOTE, cursor: null });
    await note.emit({ data: { text: 'old' } });
    const { cursor: afterOld } = await raw(client, 'events/poll', { name: NOTE, cursor: start });
    await pause(300);
    await note.emit({ data: { text: 'new' } });

    // The floor passes the cursor: replay starts at the floor, and says so.
    const floored = await raw(client, 'events/poll', { name: NOTE, cursor: start, maxAgeMs: 150 });
    expect({ texts: texts(floored), truncated: floored.truncated }).toEqual({ texts: ['new'], truncated: true });
    // The cursor is later than the floor: replay starts at the cursor.
    const later = await raw(client, 'events/poll', { name: NOTE, cursor: afterOld, maxAgeMs: 150_000 });
    expect({ texts: texts(later), truncated: later.truncated }).toEqual({ texts: ['new'], truncated: false });
    const unbounded = await raw(client, 'events/poll', { name: NOTE, cursor: start });
    expect({ texts: texts(unbounded), truncated: unbounded.truncated }).toEqual({ texts: ['old', 'new'], truncated: false });
    // With cursor: null it is ignored.
    await expect(raw(client, 'events/poll', { name: NOTE, cursor: null, maxAgeMs: 150 })).resolves.toMatchObject({
        events: [],
        truncated: false
    });
    const checked = await raw(client, 'events/poll', { name: 'ticket', cursor: 't0', maxAgeMs: 60_000 });
    expect({ texts: texts(checked), truncated: checked.truncated }).toEqual({ texts: ['fresh'], truncated: true });
});

// ───────────────────────────────────────────────────────────────────────────────
// Push
// ───────────────────────────────────────────────────────────────────────────────

verifies('events:push:active-first', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents();
    const { client, clientEvents } = eventsClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const { cursor } = await raw(client, 'events/poll', { name: NOTE, cursor: null });
    await note.emit({ data: { text: 'a' } });
    await note.emit({ data: { text: 'b' } });
    const tap = tapWire(client);

    // A cursor with events after it: the replay still comes after active.
    const subscription = await clientEvents.subscribe<Note>({ name: NOTE, delivery: 'push', cursor: cursor as string });
    expect(await take(subscription, 2)).toEqual([{ text: 'a' }, { text: 'b' }]);

    const [id] = streamIds(tap);
    expect(id).toBeDefined();
    expect(framesOf(tap, id).map(frame => frame.method)).toEqual([
        'notifications/events/active',
        'notifications/events/event',
        'notifications/events/event'
    ]);
    expect(framesOf(tap, id)[0]?.params._meta).toEqual({ [SUBSCRIPTION_ID_META_KEY]: id });
    await subscription.cancel();
});

verifies('events:push:heartbeat-grant', async ({ transport }: TestArgs) => {
    const GRANT = 150;
    const events = new EventsExtension({ heartbeatMs: GRANT, checkIntervalMs: 50 });
    let checks = 0;
    // The third check reports a gap, so the server sends a second active.
    events.registerEvent('ticket', {
        payloadSchema: NotePayload,
        check: (_ctx, _args, cursor) => {
            checks += 1;
            if (cursor === null) return { events: [], cursor: 'c0' };
            return checks === 3 ? { events: [], cursor: 'c1', truncated: true } : { events: [], cursor };
        }
    });
    const { client, clientEvents } = eventsClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const tap = tapWire(client);

    const subscription = await clientEvents.subscribe({ name: 'ticket', delivery: 'push' });
    const [id] = streamIds(tap);
    const frames = () => framesOf(tap, id);
    await vi.waitFor(() => expect(frames().filter(frame => frame.method === 'notifications/events/active')).toHaveLength(2));
    const quietFrom = frames().length;
    await pause(10 * GRANT);

    for (const active of frames().filter(frame => frame.method === 'notifications/events/active')) {
        expect(active.params.heartbeatMs).toBe(GRANT);
    }
    const heartbeats = frames()
        .slice(quietFrom)
        .filter(frame => frame.method === 'notifications/events/heartbeat');
    // Ten quiet intervals; a server heartbeating at twice the grant would send five.
    expect(heartbeats.length).toBeGreaterThanOrEqual(6);
    for (const heartbeat of heartbeats) expect(heartbeat.params.cursor).toBe('c1');
    await subscription.cancel();
});

verifies('events:push:delivery', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents();
    const { client, clientEvents } = eventsClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const tap = tapWire(client);
    const subscription = await clientEvents.subscribe<Note>({ name: NOTE, delivery: 'push' });
    const [id] = streamIds(tap);

    await note.emit({ eventId: 'evt-1', data: { text: 'pushed' }, _meta: { 'vendor/k': 1 } });
    const received = await subscription[Symbol.asyncIterator]().next();
    expect(received.value).toMatchObject({ data: { text: 'pushed' } });
    expect(received.value?._meta).toEqual({ 'vendor/k': 1 });

    const delivered = framesOf(tap, id).filter(frame => frame.method === 'notifications/events/event');
    expect(delivered).toEqual([
        expect.objectContaining({
            params: {
                eventId: 'evt-1',
                name: NOTE,
                timestamp: expect.any(String),
                data: { text: 'pushed' },
                cursor: expect.any(String),
                _meta: { 'vendor/k': 1, [SUBSCRIPTION_ID_META_KEY]: id }
            }
        })
    ]);
    await subscription.cancel();
});

verifies('events:push:terminated', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents();
    const { client, clientEvents } = eventsClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const tap = tapWire(client);
    const subscription = await clientEvents.subscribe<Note>({ name: NOTE, delivery: 'push' });
    const [id] = streamIds(tap);

    await note.terminate(new ServerEventsError('forbidden', 'Access revoked', { reason: 'revoked' }));

    await expect(take(subscription)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(framesOf(tap, id).at(-1)).toMatchObject({
        method: 'notifications/events/terminated',
        params: {
            error: { code: -32_024, message: 'Access revoked', data: { reason: 'revoked' } },
            _meta: { [SUBSCRIPTION_ID_META_KEY]: id }
        }
    });
});

verifies('events:push:cancel', async ({ transport }: TestArgs) => {
    const hooks: string[] = [];
    const events = new EventsExtension();
    const note = events.registerEvent(NOTE, {
        emitOnly: true,
        payloadSchema: NotePayload,
        onSubscribe: ctx => void hooks.push(`subscribe ${ctx.mode}`),
        onUnsubscribe: ctx => void hooks.push(`unsubscribe ${ctx.mode}`)
    });
    const { client, clientEvents } = eventsClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const tap = tapWire(client);
    const subscription = await clientEvents.subscribe<Note>({ name: NOTE, delivery: 'push' });
    const [id] = streamIds(tap);

    await subscription.cancel();

    await vi.waitFor(() => expect(hooks).toEqual(['subscribe push', 'unsubscribe push']));
    const framesBefore = framesOf(tap, id).length;
    await note.emit({ data: { text: 'after cancel' } });
    await pause(50);
    expect(framesOf(tap, id)).toHaveLength(framesBefore);
});

// ───────────────────────────────────────────────────────────────────────────────
// Webhook subscriptions
// ───────────────────────────────────────────────────────────────────────────────

verifies('events:webhook:auth-required', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const { events } = noteEvents({ ...webhookOptions(senderTo(echoing, posts)), getPrincipal: () => null });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

    await expect(raw(client, 'events/subscribe', { name: NOTE, delivery: hook() })).rejects.toMatchObject({ code: -32_024 });
    expect(posts).toEqual([]);
});

verifies('events:webhook:https-required', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const { events } = noteEvents(webhookOptions(senderTo(echoing, posts)));
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

    for (const url of ['http://hooks.example.com/mcp/events', 'ftp://hooks.example.com/mcp/events', 'hooks.example.com/mcp/events']) {
        await expect(raw(client, 'events/subscribe', { name: NOTE, delivery: hook(SECRET, url) })).rejects.toMatchObject({
            code: -32_602
        });
    }
    expect(posts).toEqual([]);
    await expect(raw(client, 'events/subscribe', { name: NOTE, delivery: hook() })).resolves.toMatchObject({ id: expect.any(String) });
});

verifies('events:webhook:secret-format', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const { events } = noteEvents(webhookOptions(senderTo(echoing, posts)));
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const subscribe = (secret: string, tag: string) =>
        raw(client, 'events/subscribe', { name: NOTE, arguments: { tag }, delivery: hook(secret) });

    for (const secret of [
        '',
        'not-a-secret',
        btoa('a'.repeat(32)),
        `whsec_${btoa('a'.repeat(23))}`,
        `whsec_${btoa('a'.repeat(65))}`,
        'whsec_!!!!'
    ]) {
        await expect(subscribe(secret, 'bad')).rejects.toMatchObject({ code: -32_602 });
    }
    expect(posts).toEqual([]);
    await expect(subscribe(`whsec_${btoa('a'.repeat(24))}`, 'shortest')).resolves.toMatchObject({ id: expect.any(String) });
    await expect(subscribe(`whsec_${btoa('a'.repeat(64))}`, 'longest')).resolves.toMatchObject({ id: expect.any(String) });
});

verifies('events:webhook:identity', async ({ transport }: TestArgs) => {
    let principal = 'alice';
    const { events } = noteEvents({ ...webhookOptions(senderTo(echoing, [])), getPrincipal: () => principal });
    events.registerEvent('other', { emitOnly: true, inputSchema: NoteInput, payloadSchema: NotePayload });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const idOf = async (params: Record<string, unknown>) => {
        const { id } = await raw(client, 'events/subscribe', params);
        return id;
    };
    const key = { name: NOTE, arguments: { tag: 'a' }, delivery: hook() };

    const id = await idOf(key);
    // Refreshes, with another secret and TTL too, keep the id.
    expect(await idOf(key)).toBe(id);
    expect(await idOf({ ...key, delivery: hook(ROTATED), ttlMs: 120_000 })).toBe(id);

    const others = [
        await idOf({ ...key, name: 'other' }),
        await idOf({ ...key, arguments: { tag: 'b' } }),
        await idOf({ ...key, delivery: hook(SECRET, 'https://hooks.example.com/mcp/other') })
    ];
    principal = 'bob';
    others.push(await idOf(key));
    expect(new Set([id, ...others]).size).toBe(5);
});

verifies('events:webhook:ttl', async ({ transport }: TestArgs) => {
    const CAP = 600_000;
    const FLOOR = 60_000;
    const { events } = noteEvents({ ...webhookOptions(senderTo(echoing, [])), webhookTtlMs: CAP });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    // The granted TTL, bounded by the request's start and end.
    const grantOf = async (ttlMs: number | null) => {
        const sent = Date.now();
        const { refreshBefore } = await raw(client, 'events/subscribe', { name: NOTE, delivery: hook(), ttlMs });
        const answered = Date.now();
        expect(refreshBefore).toEqual(expect.any(String));
        const expiry = Date.parse(refreshBefore as string);
        return { min: expiry - answered, max: expiry - sent };
    };
    const within = (grant: { min: number; max: number }, ms: number) => grant.min <= ms && ms <= grant.max;

    expect(within(await grantOf(120_000), 120_000)).toBe(true);
    expect(within(await grantOf(1000), FLOOR)).toBe(true);
    expect(within(await grantOf(3_600_000), CAP)).toBe(true);
    // This server does not grant no-expiry, so ttlMs: null gets a finite refreshBefore.
    const unlimited = await grantOf(null);
    expect(unlimited.min).toBeLessThanOrEqual(CAP);
});

verifies('typescript:events:webhook:no-expiry-refused', async ({ transport }: TestArgs) => {
    for (const cap of [60_000, 3_600_000]) {
        const { events } = noteEvents({ ...webhookOptions(senderTo(echoing, [])), webhookTtlMs: cap });
        const client = newClient();
        await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

        // The first subscribe and a refresh alike.
        for (let attempt = 0; attempt < 2; attempt++) {
            const { refreshBefore } = await raw(client, 'events/subscribe', { name: NOTE, delivery: hook(), ttlMs: null });
            const answered = Date.now();
            expect(refreshBefore).toEqual(expect.any(String));
            const expiry = Date.parse(refreshBefore as string);
            expect(Number.isFinite(expiry)).toBe(true);
            // expiry − answered is a lower bound on the grant (the server read its clock before the answer arrived).
            expect(expiry).toBeGreaterThan(answered);
            expect(expiry - answered).toBeLessThanOrEqual(cap);
        }
    }
});

verifies('events:webhook:refresh', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const { events, note } = noteEvents(webhookOptions(senderTo(echoing, posts)));
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const first = await raw(client, 'events/subscribe', { name: NOTE, delivery: hook(SECRET), ttlMs: 60_000 });
    await pause(20);

    const refreshed = await raw(client, 'events/subscribe', { name: NOTE, delivery: hook(ROTATED), ttlMs: 60_000 });

    expect(refreshed.id).toBe(first.id);
    expect(Date.parse(refreshed.refreshBefore as string)).toBeGreaterThan(Date.parse(first.refreshBefore as string));
    await note.emit({ data: { text: 'dual' } });
    const delivery = await vi.waitFor(() => defined(eventPosts(posts)[0], 'the event POST'));
    const signatures = defined(delivery.headers.get('webhook-signature'), 'webhook-signature').split(' ');
    expect(signatures.toSorted()).toEqual([await signatureOf(SECRET, delivery), await signatureOf(ROTATED, delivery)].toSorted());
});

verifies('events:webhook:unsubscribe', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const { events, note } = noteEvents(webhookOptions(senderTo(echoing, posts)));
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    await raw(client, 'events/subscribe', { name: NOTE, arguments: { tag: 'a' }, delivery: hook() });
    const target = { name: NOTE, arguments: { tag: 'a' }, delivery: { url: HOOK_URL } };

    await expect(raw(client, 'events/unsubscribe', target)).resolves.toMatchObject({});
    await note.emit({ data: { text: 'after unsubscribe' } });
    await pause(50);
    expect(eventPosts(posts)).toEqual([]);

    const notFound = { code: -32_023, data: { kind: 'subscription' } };
    await expect(raw(client, 'events/unsubscribe', target)).rejects.toMatchObject(notFound);
    await expect(raw(client, 'events/unsubscribe', { ...target, arguments: { tag: 'never' } })).rejects.toMatchObject(notFound);
});

verifies('events:webhook:verification', async ({ transport }: TestArgs) => {
    // A check type with a backlog behind the cursor, so a subscribe with that cursor has events to replay at once.
    const ticket = {
        payloadSchema: NotePayload,
        check: (_ctx: unknown, _args: unknown, cursor: string | null) =>
            cursor === 'c0'
                ? { events: [{ eventId: 'backlog', data: { text: 'backlog' } }], cursor: 'c1' }
                : { events: [], cursor: cursor ?? 'c0' }
    };
    {
        // An endpoint that answers but does not echo the challenge.
        const posts: Post[] = [];
        const events = new EventsExtension(webhookOptions(senderTo(async () => Response.json({ challenge: 'wrong' }), posts)));
        events.registerEvent('ticket', ticket);
        const client = newClient();
        await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

        await expect(raw(client, 'events/subscribe', { name: 'ticket', delivery: hook(), cursor: 'c0' })).rejects.toMatchObject({
            code: -32_027,
            data: { reason: 'challenge_failed' }
        });
        await pause(50);
        expect(posts.map(post => post.json.type)).toEqual(['verification']);
    }
    {
        const posts: Post[] = [];
        const events = new EventsExtension(webhookOptions(senderTo(echoing, posts)));
        events.registerEvent('ticket', ticket);
        const client = newClient();
        await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

        await raw(client, 'events/subscribe', { name: 'ticket', delivery: hook(), cursor: 'c0' });

        await vi.waitFor(() => expect(posts.map(post => post.json.type ?? 'event')).toEqual(['verification', 'event']));
        expect(posts[1]?.json).toMatchObject({ data: { text: 'backlog' } });
    }
});

verifies('events:webhook:signature', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const { events, note } = noteEvents(webhookOptions(senderTo(echoing, posts)));
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const { id } = await raw(client, 'events/subscribe', { name: NOTE, delivery: hook() });
    await note.emit({ eventId: 'evt-1', data: { text: 'signed' } });

    await vi.waitFor(() => expect(eventPosts(posts)).toHaveLength(1));
    const now = Math.floor(Date.now() / 1000);
    // The verification challenge and the event delivery alike.
    for (const post of posts) {
        expect(post.headers.get('content-type')).toBe('application/json');
        expect(post.headers.get('webhook-id')).toMatch(/^[\w-]+$/);
        expect(Math.abs(Number(post.headers.get('webhook-timestamp')) - now)).toBeLessThanOrEqual(5);
        expect(post.headers.get('x-mcp-subscription-id')).toBe(id);
        expect(post.headers.get('webhook-signature')).toBe(await signatureOf(SECRET, post));
    }
    expect(eventPosts(posts)[0]?.json).toMatchObject({
        eventId: 'evt-1',
        name: NOTE,
        data: { text: 'signed' },
        cursor: expect.any(String)
    });
});

verifies('events:webhook:webhook-id', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    let refused = false;
    // The first event POST is refused with a 503, so it is retried after 5 s.
    const endpoint: Endpoint = async request => {
        const body = (await request.clone().json()) as { type?: string };
        if (body.type === undefined && !refused) {
            refused = true;
            return new Response(null, { status: 503 });
        }
        return echoing(request);
    };
    const { events, note } = noteEvents(webhookOptions(senderTo(endpoint, posts)));
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const a = await raw(client, 'events/subscribe', { name: NOTE, arguments: { tag: 'a' }, delivery: hook() });
    const b = await raw(client, 'events/subscribe', { name: NOTE, arguments: { tag: 'b' }, delivery: hook() });

    await note.emit({ eventId: 'evt-1', data: { text: 'one' } });
    await note.emit({ eventId: 'evt-2', data: { text: 'two' } });
    const forA = () => eventPosts(posts).filter(post => post.headers.get('x-mcp-subscription-id') === a.id);
    const forB = () => eventPosts(posts).filter(post => post.headers.get('x-mcp-subscription-id') === b.id);
    await vi.waitFor(() => expect(forA().length + forB().length).toBe(5), { timeout: 10_000 });

    const idOf = (post: Post | undefined) => defined(post, 'post').headers.get('webhook-id');
    const [refusedPost] = eventPosts(posts);
    const attempts = eventPosts(posts).filter(post => idOf(post) === idOf(refusedPost));
    expect(attempts.map(post => post.status)).toEqual([503, 200]);
    expect(attempts.map(post => post.json.eventId)).toEqual([refusedPost?.json.eventId, refusedPost?.json.eventId]);
    // One webhook-id per message: two events on two subscriptions are four messages.
    const messages = new Set(eventPosts(posts).map(post => idOf(post)));
    expect(messages.size).toBe(4);
    for (const post of eventPosts(posts)) expect(idOf(post)).not.toContain(String(post.json.eventId));
    for (const tag of ['a', 'b']) await raw(client, 'events/unsubscribe', { name: NOTE, arguments: { tag }, delivery: { url: HOOK_URL } });
});

verifies('events:webhook:final-statuses', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const answers: Record<string, number> = { gone: 410, 'too-large': 413, unavailable: 503 };
    // Each subscription's URL names the status its event POSTs get.
    const endpoint: Endpoint = async request => {
        const body = (await request.clone().json()) as { type?: string };
        const status = answers[new URL(request.url).pathname.slice(1)];
        return body.type === undefined && status !== undefined ? new Response(null, { status }) : echoing(request);
    };
    const { events, note } = noteEvents(webhookOptions(senderTo(endpoint, posts)));
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    for (const path of Object.keys(answers)) {
        await raw(client, 'events/subscribe', { name: NOTE, delivery: hook(SECRET, `https://hooks.example.com/${path}`) });
    }
    const attempts = (path: string) => eventPosts(posts).filter(post => post.url === `https://hooks.example.com/${path}`).length;

    await note.emit({ data: { text: 'refused' } });

    // The 503 is retried after 5 s; by then the 410 and 413 would have been too.
    await vi.waitFor(() => expect(attempts('unavailable')).toBe(2), { timeout: 10_000 });
    await pause(200);
    expect({ gone: attempts('gone'), tooLarge: attempts('too-large') }).toEqual({ gone: 1, tooLarge: 1 });
    for (const path of Object.keys(answers)) {
        await raw(client, 'events/unsubscribe', { name: NOTE, delivery: { url: `https://hooks.example.com/${path}` } });
    }
});

verifies('events:webhook:terminated', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const { events, note } = noteEvents(webhookOptions(senderTo(echoing, posts)));
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const { id } = await raw(client, 'events/subscribe', { name: NOTE, delivery: hook() });

    await note.terminate(new ServerEventsError('forbidden', 'Access revoked', { reason: 'revoked' }), { subscriptionId: id as string });

    const terminated = await vi.waitFor(() =>
        defined(
            posts.find(post => post.json.type === 'terminated'),
            'the terminated POST'
        )
    );
    expect(terminated.json).toEqual({
        type: 'terminated',
        error: { code: -32_024, message: 'Access revoked', data: { reason: 'revoked' } }
    });
    expect(terminated.headers.get('x-mcp-subscription-id')).toBe(id);
    expect(terminated.headers.get('webhook-signature')).toBe(await signatureOf(SECRET, terminated));
    // The subscription no longer exists.
    await expect(raw(client, 'events/unsubscribe', { name: NOTE, delivery: { url: HOOK_URL } })).rejects.toMatchObject({ code: -32_023 });
});

// ───────────────────────────────────────────────────────────────────────────────
// Streamable HTTP headers
// ───────────────────────────────────────────────────────────────────────────────

verifies('events:mcp-name', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const { client, clientEvents } = eventsClient({ ...FAST, webhook: { url: HOOK_URL } });
    const { events } = noteEvents(webhookOptions(senderTo(clientEvents.createWebhookHandler(), posts)));
    await using wired = await wire(transport, serving(events), client, EVENTS_WIRE);

    for (const delivery of ['poll', 'push', 'webhook'] as const) {
        const subscription = await clientEvents.subscribe({ name: NOTE, delivery });
        await subscription.cancel();
    }

    for (const method of ['events/poll', 'events/stream', 'events/subscribe', 'events/unsubscribe']) {
        const exchanges = exchangesFor(wired, method);
        expect(exchanges.length).toBeGreaterThan(0);
        for (const exchange of exchanges) expect(exchange.requestHeaders.get('mcp-name')).toBe(NOTE);
    }
    const listed = exchangesFor(wired, 'events/list');
    expect(listed.length).toBeGreaterThan(0);
    for (const exchange of listed) expect(exchange.requestHeaders.has('mcp-name')).toBe(false);
});

verifies('events:mcp-param', async ({ transport }: TestArgs) => {
    const events = new EventsExtension();
    events.registerEvent('incident', {
        emitOnly: true,
        inputSchema: z.object({ region: z.string().meta({ 'x-mcp-header': 'Region' }), severity: z.string().optional() }),
        payloadSchema: NotePayload
    });
    const { client, clientEvents } = eventsClient();
    await using wired = await wire(transport, serving(events), client, EVENTS_WIRE);
    const args = { region: 'us-west1', severity: 'P1' };

    const subscription = await clientEvents.subscribe({ name: 'incident', arguments: args, delivery: 'poll' });
    await subscription.cancel();
    const [polled] = exchangesFor(wired, 'events/poll');
    const headers = defined(polled, 'the events/poll exchange').requestHeaders;
    expect(headers.get('mcp-param-region')).toBe('us-west1');
    expect([...headers.keys()].filter(key => key.startsWith('mcp-param-'))).toEqual(['mcp-param-region']);

    const mismatch = await defined(wired.fetch, 'fetch')(defined(wired.url, 'url'), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...modernStandardHeaders('events/poll', 'incident'),
            'mcp-param-region': 'eu-west1'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'events/poll',
            params: { name: 'incident', arguments: args, cursor: null, _meta: modernEnvelopeMeta() }
        })
    });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: { code: number } }).error.code).toBe(-32_020);
});

// ───────────────────────────────────────────────────────────────────────────────
// Client
// ───────────────────────────────────────────────────────────────────────────────

verifies('events:client:gating', async ({ transport }: TestArgs) => {
    const { client, clientEvents } = eventsClient();
    // No EVENTS_WIRE: the sniffer itself rejects any events/* request the client might send.
    await using _ = await wire(transport, () => new McpServer({ name: 's', version: '0' }), client);
    const tap = tapWire(client);

    expect(clientEvents.supported).toBe(false);
    const unsupported = { code: SdkErrorCode.CapabilityNotSupported };
    await expect(clientEvents.list()).rejects.toBeInstanceOf(SdkError);
    await expect(clientEvents.list()).rejects.toMatchObject(unsupported);
    await expect(clientEvents.subscribe({ name: NOTE })).rejects.toMatchObject(unsupported);
    await pause(0);
    expect(tap.sent.filter(message => 'method' in message && message.method.startsWith('events/'))).toEqual([]);
});

verifies('events:client:mode-selection', async ({ transport }: TestArgs) => {
    const definitions = {
        all: {},
        'no-webhook': { webhook: false },
        'poll-only': { push: false, webhook: false }
    } as const;
    const modesFor = async (clientEvents: EventsClientExtension) => {
        const modes: Record<string, string> = {};
        for (const name of Object.keys(definitions)) {
            const subscription = await clientEvents.subscribe({ name });
            modes[name] = subscription.deliveryMode;
            await subscription.cancel();
        }
        return modes;
    };
    {
        const { client, clientEvents } = eventsClient({ ...FAST, webhook: { url: HOOK_URL } });
        const events = new EventsExtension(webhookOptions(senderTo(clientEvents.createWebhookHandler(), [])));
        for (const [name, delivery] of Object.entries(definitions))
            events.registerEvent(name, { emitOnly: true, payloadSchema: NotePayload, delivery });
        await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

        expect(await modesFor(clientEvents)).toEqual({ all: 'webhook', 'no-webhook': 'push', 'poll-only': 'poll' });
    }
    {
        // Without the webhook option the client cannot use webhook.
        const { client, clientEvents } = eventsClient();
        const events = new EventsExtension(webhookOptions(senderTo(echoing, [])));
        for (const [name, delivery] of Object.entries(definitions))
            events.registerEvent(name, { emitOnly: true, payloadSchema: NotePayload, delivery });
        await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

        expect(await modesFor(clientEvents)).toEqual({ all: 'push', 'no-webhook': 'push', 'poll-only': 'poll' });
    }
});

verifies('events:client:dedupe', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents();
    const { client, clientEvents } = eventsClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const first = await clientEvents.subscribe<Note>({ name: NOTE, arguments: { tag: 'first' }, delivery: 'push' });
    const second = await clientEvents.subscribe<Note>({ name: NOTE, arguments: { tag: 'second' }, delivery: 'push' });

    await note.emit({ eventId: 'evt-1', data: { text: 'one' } });
    await note.emit({ eventId: 'evt-1', data: { text: 'one again' } });
    await note.emit({ eventId: 'evt-2', data: { text: 'two' } });

    // The repeat is dropped on each subscription; the other subscription still gets evt-1.
    expect(await take(first, 2)).toEqual([{ text: 'one' }, { text: 'two' }]);
    expect(await take(second, 2)).toEqual([{ text: 'one' }, { text: 'two' }]);
    await first.cancel();
    await second.cancel();
});

// ───────────────────────────────────────────────────────────────────────────────
// TypeScript SDK surface
// ───────────────────────────────────────────────────────────────────────────────

verifies('typescript:events:extensions:rules', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents();
    expect(() => new McpServer({ name: 's', version: '0' }, { extensions: [events, new EventsExtension()] })).toThrow(
        'Extension "io.modelcontextprotocol/events" is listed more than once; pass each extension once'
    );

    // One instance serves every server constructed with it: one emit reaches a subscriber of each.
    const first = eventsClient();
    const second = eventsClient();
    await using _ = await wire(transport, serving(events), first.client, EVENTS_WIRE);
    {
        await using _ = await wire(transport, serving(events), second.client, EVENTS_WIRE);
        const subscriptions = [
            await first.clientEvents.subscribe<Note>({ name: NOTE, delivery: 'push' }),
            await second.clientEvents.subscribe<Note>({ name: NOTE, delivery: 'push' })
        ];
        await note.emit({ eventId: 'evt-1', data: { text: 'both' } });
        for (const subscription of subscriptions) {
            expect(await take(subscription)).toEqual([{ text: 'both' }]);
            await subscription.cancel();
        }
    }

    // An EventsClientExtension serves one client: a second client constructed with it fails.
    expect(() => new Client({ name: 'c2', version: '0' }, { extensions: [first.clientEvents] })).toThrow(
        "This EventsClientExtension is already in another client; pass a new one in each client's extensions option"
    );
});

verifies('typescript:events:definition:kinds', async ({ transport }: TestArgs) => {
    const events = new EventsExtension();
    // As plain JavaScript calls it, past the types that refuse these definitions.
    const register = events.registerEvent.bind(events) as unknown as (name: string, definition: Record<string, unknown>) => unknown;
    const check = () => ({ events: [], cursor: null });
    const kinds = /pass check\(\), or emitOnly: true/;

    expect(() => register('both', { emitOnly: true, check, payloadSchema: NotePayload })).toThrow(TypeError);
    expect(() => register('both', { emitOnly: true, check, payloadSchema: NotePayload })).toThrow(kinds);
    expect(() => register('neither', { payloadSchema: NotePayload })).toThrow(kinds);
    expect(() => register('filtered', { check, match: () => true, payloadSchema: NotePayload })).toThrow(kinds);
    events.registerEvent('pulled', { payloadSchema: NotePayload, check });
    events.registerEvent('pushed', { emitOnly: true, payloadSchema: NotePayload });
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

    const { events: listed } = (await raw(client, 'events/list')) as { events: Array<{ name: string }> };
    expect(listed.map(descriptor => descriptor.name)).toEqual(['pulled', 'pushed']);
});

verifies('typescript:events:errors', async ({ transport }: TestArgs) => {
    const { events, note } = noteEvents();
    const { client, clientEvents } = eventsClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);

    const unknown = await rejectionOf(clientEvents.subscribe({ name: 'missing', delivery: 'poll' }));
    expect(unknown).toBeInstanceOf(EventsError);
    expect(unknown).toMatchObject({ kind: 'notFound' });
    const invalid = await rejectionOf(clientEvents.subscribe({ name: NOTE, arguments: { tag: 5 }, delivery: 'poll' }));
    expect(invalid).toBeInstanceOf(EventsError);
    expect(invalid).toMatchObject({ kind: 'invalidParams' });

    const noMode = await rejectionOf(clientEvents.subscribe({ name: NOTE, delivery: 'webhook' }));
    expect(noMode).toBeInstanceOf(NoCompatibleDeliveryModeError);
    expect(noMode).toBeInstanceOf(SdkError);
    expect(noMode).toMatchObject({ eventName: NOTE, offered: ['poll', 'push'], usable: [] });

    // A subscription the server ends: the loop rejects with the kind.
    const subscription = await clientEvents.subscribe<Note>({ name: NOTE, delivery: 'push' });
    await note.terminate(new ServerEventsError('forbidden', 'Access revoked'));
    const ended = await rejectionOf(take(subscription));
    expect(ended).toBeInstanceOf(EventsError);
    expect(ended).toMatchObject({ kind: 'forbidden', message: 'Access revoked' });
});

verifies('typescript:events:store:replicas', async ({ transport }: TestArgs) => {
    const posts: Post[] = [];
    const { client, clientEvents } = eventsClient({ ...FAST, webhook: { url: HOOK_URL, secretProvider: () => SECRET } });
    const options = webhookOptions(senderTo(clientEvents.createWebhookHandler(), posts), {
        webhookStore: new InMemoryWebhookSubscriptionStore()
    });
    const a = noteEvents(options);
    const b = noteEvents(options);
    let replica = a;
    const makeServer = () => serving(replica.events)();
    await using wired = await wire(transport, makeServer, client, EVENTS_WIRE);
    const subscription = await clientEvents.subscribe<Note>({ name: NOTE });
    expect(subscription.deliveryMode).toBe('webhook');
    const id = defined(posts[0], 'the verification POST').headers.get('x-mcp-subscription-id');

    replica = b;
    // Refresh, delivery and unsubscribe on the second replica.
    await expect(raw(client, 'events/subscribe', { name: NOTE, delivery: hook() })).resolves.toMatchObject({ id });
    await b.note.emit({ data: { text: 'from b' } });
    expect(await take(subscription)).toEqual([{ text: 'from b' }]);
    expect(eventPosts(posts).map(post => post.headers.get('x-mcp-subscription-id'))).toEqual([id]);
    await subscription.cancel();
    expect(exchangesFor(wired, 'events/unsubscribe')).toHaveLength(1);

    await a.note.emit({ data: { text: 'after unsubscribe' } });
    await pause(50);
    expect(eventPosts(posts)).toHaveLength(1);
    expect(posts.filter(post => post.json.type === 'verification')).toHaveLength(1);
});

verifies('typescript:events:store:restart', async ({ transport }: TestArgs) => {
    {
        const posts: Post[] = [];
        const { client, clientEvents } = eventsClient({ ...FAST, webhook: { url: HOOK_URL } });
        const options = webhookOptions(senderTo(clientEvents.createWebhookHandler(), posts), {
            webhookStore: new InMemoryWebhookSubscriptionStore()
        });
        let server = noteEvents(options);
        const makeServer = () => serving(server.events)();
        await using wired = await wire(transport, makeServer, client, EVENTS_WIRE);
        const subscription = await clientEvents.subscribe<Note>({ name: NOTE });
        const requests = wired.httpLog?.length;

        // The process restarts: a new extension over the same store, nothing carried over in memory.
        server = noteEvents(options);
        await server.note.emit({ data: { text: 'after the restart' } });

        expect(await take(subscription)).toEqual([{ text: 'after the restart' }]);
        expect(wired.httpLog?.length).toBe(requests);
        expect(posts.map(post => post.json.type ?? 'event')).toEqual(['verification', 'event']);
        await subscription.cancel();
    }
    {
        // A check type: the rebuilt server runs its check loop from the client's next refresh.
        const realSetTimeout = globalThis.setTimeout;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const posts: Post[] = [];
            const { client, clientEvents } = eventsClient({ ...FAST, webhook: { url: HOOK_URL } });
            const options = webhookOptions(senderTo(clientEvents.createWebhookHandler(), posts), {
                webhookStore: new InMemoryWebhookSubscriptionStore(),
                checkIntervalMs: 1000
            });
            // The upstream outlives the process; a cursor counts its entries.
            const upstream: string[] = [];
            let current: EventsExtension | undefined;
            const build = (): void => {
                const events = new EventsExtension(options);
                events.registerEvent('ticket', {
                    payloadSchema: NotePayload,
                    check: (_ctx, _args, cursor) => {
                        // The process that was replaced reads nothing more.
                        if (events !== current) return new Promise<never>(() => {});
                        const from = cursor === null ? upstream.length : Number(cursor);
                        const page = upstream.slice(from).map((text, index) => ({ eventId: `t${from + index}`, data: { text } }));
                        return { events: page, cursor: String(upstream.length) };
                    }
                });
                current = events;
            };
            build();
            await using _ = await wire(transport, () => serving(current!)(), client, EVENTS_WIRE);
            const tap = tapWire(client);
            const subscribes = () => tap.sent.filter(message => 'method' in message && message.method === 'events/subscribe') as Frame[];
            const subscription = await clientEvents.subscribe<Note>({ name: 'ticket' });

            build();
            upstream.push('during the restart');
            let taken: Note[] | undefined;
            let failed: unknown;
            void take(subscription).then(
                data => (taken = data),
                (error: unknown) => (failed = error)
            );
            // Until the refresh, the rebuilt server runs no check loop for the stored subscription.
            await vi.advanceTimersByTimeAsync(44_000);
            expect({ taken, subscribes: subscribes().length }).toEqual({ taken: undefined, subscribes: 1 });
            // Then on in 100 ms steps, each with a moment of real time for the requests in between, up to 50 s of fake time.
            for (let at = 44_000; taken === undefined && failed === undefined && at < 50_000; at += 100) {
                await vi.advanceTimersByTimeAsync(100);
                await new Promise(resolve => realSetTimeout(resolve, 5));
            }

            expect(failed).toBeUndefined();
            expect(taken).toEqual([{ text: 'during the restart' }]);
            // The refresh carried the client's cursor, and the loop it started delivered from there.
            expect(subscribes().map(message => message.params['cursor'])).toEqual([null, '0']);
            expect(posts.map(post => post.json.type ?? 'event')).toEqual(['verification', 'event']);
            await subscription.cancel();
        } finally {
            vi.useRealTimers();
        }
    }
});

verifies('typescript:events:trusted-origins', async ({ transport }: TestArgs) => {
    const ORIGIN = 'http://127.0.0.1:9000';
    const posts: Post[] = [];
    const { events } = noteEvents(webhookOptions(senderTo(echoing, posts), { trustedOrigins: [ORIGIN] }));
    const client = newClient();
    await using _ = await wire(transport, serving(events), client, EVENTS_WIRE);
    const subscribe = (url: string) => raw(client, 'events/subscribe', { name: NOTE, delivery: hook(SECRET, url) });

    await expect(subscribe(`${ORIGIN}/hooks`)).resolves.toMatchObject({ id: expect.any(String) });
    expect(posts.map(post => [post.url, post.trusted])).toEqual([[`${ORIGIN}/hooks`, true]]);
    for (const url of ['http://127.0.0.1:9001/hooks', 'http://localhost:9000/hooks', 'http://127.0.0.2:9000/hooks']) {
        await expect(subscribe(url)).rejects.toMatchObject({ code: -32_602 });
    }
    await expect(subscribe(HOOK_URL)).resolves.toMatchObject({ id: expect.any(String) });
    expect(posts.at(-1)).toMatchObject({ url: HOOK_URL, trusted: false });
    // Only exact origins can be listed.
    expect(() => new EventsExtension({ trustedOrigins: [`${ORIGIN}/hooks`] })).toThrow(TypeError);
    expect(() => new EventsExtension({ trustedOrigins: ['127.0.0.1:9000'] })).toThrow(TypeError);
});

verifies('typescript:events:experimental:subpaths', async () => {
    const [server, client, serverEvents, clientEvents, node] = await Promise.all([
        import('@modelcontextprotocol/server'),
        import('@modelcontextprotocol/client'),
        import('@modelcontextprotocol/server/ext/events'),
        import('@modelcontextprotocol/client/ext/events'),
        import('@modelcontextprotocol/server/ext/events/node')
    ]);

    expect(Object.keys(serverEvents)).toEqual(
        expect.arrayContaining(['EventsExtension', 'InMemoryWebhookSubscriptionStore', 'EventsError'])
    );
    expect(Object.keys(clientEvents)).toEqual(
        expect.arrayContaining(['EventsClientExtension', 'NoCompatibleDeliveryModeError', 'EventsError'])
    );
    expect(Object.keys(node)).toEqual(['nodeWebhookSender']);
    const eventsApi = new Set([...Object.keys(serverEvents), ...Object.keys(clientEvents), ...Object.keys(node)]);
    expect(Object.keys(server).filter(name => eventsApi.has(name))).toEqual([]);
    expect(Object.keys(client).filter(name => eventsApi.has(name))).toEqual([]);
});
