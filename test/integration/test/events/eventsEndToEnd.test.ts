/**
 * Events (SEP-3415) end to end, through public import paths only: a real
 * `Client` with `EventsClientExtension` against a real `McpServer` with
 * `EventsExtension`, over HTTP (`createMcpHandler`, `fetch` wired to the
 * handler), stdio (a child process) and in memory (`serveStdio` over an
 * `InMemoryTransport`), in every delivery mode. Webhook, replica and restart
 * cases run over HTTP.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import path from 'node:path';

import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import {
    Client,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
    SdkError,
    SdkErrorCode,
    StreamableHTTPClientTransport,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/client';
import type { EventsClientOptions, EventSubscription } from '@modelcontextprotocol/client/ext/events';
import { EVENTS_EXTENSION_ID, EventsClientExtension, EventsError } from '@modelcontextprotocol/client/ext/events';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { AuthInfo, CreateMcpHandlerOptions, McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { EventsOptions, WebhookSender } from '@modelcontextprotocol/server/ext/events';
import {
    EventsError as ServerEventsError,
    EventsExtension,
    InMemoryWebhookSubscriptionStore
} from '@modelcontextprotocol/server/ext/events';
import { nodeWebhookSender } from '@modelcontextprotocol/server/ext/events/node';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type { EventsFixture, HookEntry } from '../__fixtures__/eventsStdioServer';
import { BUFFERED_NOTES, eventsFixture, HEARTBEAT_MS, NOTE, TICKET } from '../__fixtures__/eventsStdioServer';

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
const FIXTURES_DIR = path.resolve(__dirname, '../__fixtures__');
const Loose = z.looseObject({});
const HOOK_URL = 'https://hooks.example.com/mcp/events';
const ALICE: AuthInfo = { token: 'alice-token', clientId: 'events-host', scopes: [], extra: { sub: 'alice' } };
const SECRET = `whsec_${btoa('a'.repeat(32))}`;
const ROTATED = `whsec_${btoa('b'.repeat(32))}`;
// The client polls as often as the fixture's nextPollMs (50 ms) asks.
const CLIENT_OPTIONS: EventsClientOptions = { pollIntervalFloorMs: 20 };

type Arm = 'http' | 'stdio' | 'inMemory';
type Note = { tag: string; text: string };

interface Connection {
    readonly client: Client;
    readonly events: EventsClientExtension;
    // Every message the client's transport received and sent after connecting.
    readonly received: JSONRPCMessage[];
    readonly sent: JSONRPCMessage[];
    close(): Promise<void>;
}

interface HttpConnection extends Connection {
    // Each HTTP request, by the handler that served it and its Mcp-Method header.
    readonly requests: Array<{ handler: McpHttpHandler; method: string | null }>;
    // Ends every open events/stream response, as a dropped connection does.
    dropStreams(): void;
}

function clientFor(revision: string, events: EventsClientExtension): Client {
    return new Client(
        { name: 'events-host', version: '1.0.0' },
        revision === MODERN ? { versionNegotiation: { mode: { pin: MODERN } }, extensions: [events] } : { extensions: [events] }
    );
}

// Records what the client's transport receives and sends from now on.
function tap(client: Client): Pick<Connection, 'received' | 'sent'> {
    const transport = client.transport!;
    const received: JSONRPCMessage[] = [];
    const sent: JSONRPCMessage[] = [];
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
        received.push(message);
        onmessage?.(message, extra);
    };
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
        sent.push(message);
        return send(message, options);
    };
    return { received, sent };
}

function handlerFor(fixture: EventsFixture, options?: CreateMcpHandlerOptions): McpHttpHandler {
    return createMcpHandler(() => fixture.server('events-http'), options);
}

// The response with a body the test can end, as a dropped connection ends it; the server sees the cancel.
function droppable(response: Response, drops: Set<() => void>): Response {
    const reader = response.body!.getReader();
    let ended = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            drops.add(() => {
                if (ended) return;
                ended = true;
                void reader.cancel();
                controller.close();
            });
        },
        async pull(controller) {
            const { done, value } = await reader.read();
            if (ended) return;
            if (done) {
                ended = true;
                controller.close();
            } else {
                controller.enqueue(value);
            }
        },
        cancel(reason) {
            ended = true;
            return reader.cancel(reason);
        }
    });
    return new Response(body, { status: response.status, headers: response.headers });
}

// `serve` picks the handler for each request, so a test can move the client between servers.
async function overHttp(
    serve: () => McpHttpHandler,
    options: { revision?: string; events?: EventsClientExtension; authInfo?: AuthInfo } = {}
): Promise<HttpConnection> {
    const events = options.events ?? new EventsClientExtension(CLIENT_OPTIONS);
    const client = clientFor(options.revision ?? MODERN, events);
    const requests: HttpConnection['requests'] = [];
    const drops = new Set<() => void>();
    const fetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const request = new Request(url, init);
        const handler = serve();
        const method = request.headers.get('mcp-method');
        requests.push({ handler, method });
        const response = await handler.fetch(request, options.authInfo === undefined ? undefined : { authInfo: options.authInfo });
        return method === 'events/stream' && response.body !== null ? droppable(response, drops) : response;
    };
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch }));
    return {
        client,
        events,
        ...tap(client),
        requests,
        dropStreams: () => {
            for (const drop of drops) drop();
            drops.clear();
        },
        close: () => client.close()
    };
}

async function overStdio(revision: string): Promise<Connection> {
    const events = new EventsClientExtension(CLIENT_OPTIONS);
    const client = clientFor(revision, events);
    await client.connect(
        new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'eventsStdioServer.ts'], cwd: FIXTURES_DIR })
    );
    return { client, events, ...tap(client), close: () => client.close() };
}

async function overMemory(revision: string): Promise<Connection> {
    const { server } = eventsFixture();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => server('events-in-memory'), { transport: serverTransport });
    const events = new EventsClientExtension(CLIENT_OPTIONS);
    const client = clientFor(revision, events);
    await client.connect(clientTransport);
    return {
        client,
        events,
        ...tap(client),
        close: async () => {
            await client.close();
            await handle.close();
        }
    };
}

async function connect(arm: Arm, revision: string): Promise<Connection> {
    if (arm === 'stdio') return overStdio(revision);
    if (arm === 'inMemory') return overMemory(revision);
    const handler = handlerFor(eventsFixture());
    const connection = await overHttp(() => handler, { revision });
    return {
        ...connection,
        close: async () => {
            await connection.close();
            await handler.close();
        }
    };
}

// The fixture's tools, which drive the server the same way in every arm.
function driver(client: Client) {
    const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError === true) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
        return result;
    };
    return {
        emit: (tag: string, ...texts: string[]) => call('emit', { tag, texts }),
        append: (tag: string, ...titles: string[]) => call('append', { tag, titles }),
        terminate: (name: string, tag: string, mode: 'poll' | 'push') => call('terminate', { name, tag, mode }),
        hooks: async (tag: string): Promise<HookEntry[]> => {
            const result = await call('hooks', { tag });
            const [content] = result.content as Array<{ text: string }>;
            return JSON.parse(content!.text) as HookEntry[];
        }
    };
}

// The next `count` events, leaving the subscription open.
async function next<T>(subscription: EventSubscription<T>, count = 1): Promise<T[]> {
    const iterator = subscription[Symbol.asyncIterator]();
    const data: T[] = [];
    while (data.length < count) {
        const result = await iterator.next();
        if (result.done === true) throw new Error('the subscription ended');
        data.push(result.value.data);
    }
    return data;
}

function texts(notes: Note[]): string[] {
    return notes.map(note => note.text);
}

function isEventsFrame(message: JSONRPCMessage): message is JSONRPCMessage & { method: string; params: Record<string, unknown> } {
    return 'method' in message && !('id' in message) && message.method.startsWith('notifications/events/');
}

function streamIdOf(frame: { params: Record<string, unknown> }): unknown {
    return (frame.params._meta as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY];
}

function raw(client: Client, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return client.request({ method, ...(params !== undefined && { params }) }, Loose);
}

// A fresh stdio child takes about a second over its first requests, more on a loaded machine.
describe.each([['http'], ['stdio'], ['inMemory']] as const)('events over %s on 2026-07-28', { timeout: 15_000 }, arm => {
    let connection: Connection;
    let server: ReturnType<typeof driver>;

    const subscribe = (
        name: string,
        tag: string,
        delivery: 'poll' | 'push',
        more: { cursor?: string | null; onGap?: (cursor: string | null) => void } = {}
    ) => connection.events.subscribe<Note>({ name, arguments: { tag }, delivery, ...more });

    beforeAll(async () => {
        connection = await connect(arm, MODERN);
        server = driver(connection.client);
    }, 30_000);

    afterAll(async () => {
        await connection.close();
    });

    describe('poll', () => {
        it('polls again at once while the server reports hasMore', async () => {
            await server.append('drain', 'a', 'b', 'c', 'd', 'e');
            const subscription = await connection.events.subscribe<{ title: string }>({
                name: TICKET,
                arguments: { tag: 'drain' },
                delivery: 'poll',
                cursor: '0'
            });
            // Every page asks for nextPollMs 60 000: only hasMore brings the later pages within the test timeout.
            const tickets = await next(subscription, 5);
            expect(tickets.map(ticket => ticket.title)).toEqual(['a', 'b', 'c', 'd', 'e']);
            await subscription.cancel();
        });

        it('reports truncated through onGap after the buffer evicted its cursor, and goes on from the oldest note kept', async () => {
            const first = await subscribe(NOTE, 'evicted', 'poll');
            const cursor = first.cursor;
            await first.cancel();
            await server.emit('evicted', 'n1', 'n2', 'n3', 'n4');
            const gaps: Array<string | null> = [];
            const subscription = await subscribe(NOTE, 'evicted', 'poll', { cursor, onGap: gap => void gaps.push(gap) });
            expect(texts(await next(subscription, BUFFERED_NOTES))).toEqual(['n2', 'n3', 'n4']);
            expect(gaps).toEqual([expect.any(String)]);
            await subscription.cancel();
        });

        it('resumes from a persisted cursor with what was emitted while it was away', async () => {
            const first = await subscribe(NOTE, 'resume', 'poll');
            await server.emit('resume', 'seen');
            const iterator = first[Symbol.asyncIterator]();
            const seen = await iterator.next();
            expect(seen.value?.data.text).toBe('seen');
            // Asking for the next event finishes with 'seen', so the cursor moves past it.
            const pending = iterator.next();
            const persisted = first.cursor;
            await first.cancel();
            await pending;

            await server.emit('resume', 'while away');
            const resumed = await subscribe(NOTE, 'resume', 'poll', { cursor: persisted });
            expect(texts(await next(resumed))).toEqual(['while away']);
            await resumed.cancel();
        });
    });

    describe('push', () => {
        it('confirms the stream with the granted heartbeat, then sends heartbeats while it is quiet', async () => {
            const mark = connection.received.length;
            const subscription = await subscribe(NOTE, 'heartbeat', 'push');
            const frames = () => connection.received.slice(mark).filter(message => isEventsFrame(message));
            await vi.waitFor(() => expect(frames().map(frame => frame.method)).toContain('notifications/events/heartbeat'), {
                timeout: 5000
            });
            const [active, ...rest] = frames();
            expect(active).toMatchObject({
                method: 'notifications/events/active',
                params: { truncated: false, heartbeatMs: HEARTBEAT_MS }
            });
            for (const frame of rest) {
                expect(frame).toMatchObject({ method: 'notifications/events/heartbeat', params: { cursor: active!.params.cursor } });
                expect(streamIdOf(frame)).toBe(streamIdOf(active!));
            }
            await subscription.cancel();
        });

        it('reports a gap through onGap and replays the notes the buffer kept', async () => {
            const first = await subscribe(NOTE, 'gap', 'push');
            const cursor = first.cursor;
            await first.cancel();
            await server.emit('gap', 'n1', 'n2', 'n3', 'n4');
            const gaps: Array<string | null> = [];
            const subscription = await subscribe(NOTE, 'gap', 'push', { cursor, onGap: gap => void gaps.push(gap) });
            expect(texts(await next(subscription, BUFFERED_NOTES))).toEqual(['n2', 'n3', 'n4']);
            expect(gaps).toEqual([expect.any(String)]);
            await subscription.cancel();
        });

        it('ends the server stream on cancel(), which calls onUnsubscribe', async () => {
            const subscription = await subscribe(NOTE, 'cancel', 'push');
            const [opened] = await server.hooks('cancel');
            expect(opened).toMatchObject({ hook: 'subscribe', mode: 'push' });
            await subscription.cancel();
            await vi.waitFor(async () => expect(await server.hooks('cancel')).toEqual([opened, { ...opened, hook: 'unsubscribe' }]));
        });

        // Without an HTTP request stream to abort, the client cancels with a notification.
        if (arm !== 'http') {
            it('cancels with notifications/cancelled, and the server stops without answering the stream', async () => {
                const mark = connection.sent.length;
                const subscription = await subscribe(NOTE, 'cancelled', 'push');
                const stream = connection.sent.slice(mark).find(message => 'method' in message && message.method === 'events/stream');
                expect(stream).toMatchObject({ id: expect.any(String) });
                const id = (stream as { id: string }).id;
                await subscription.cancel();
                expect(connection.sent).toContainEqual(
                    expect.objectContaining({ method: 'notifications/cancelled', params: expect.objectContaining({ requestId: id }) })
                );
                await vi.waitFor(async () => {
                    const entries = await server.hooks('cancelled');
                    expect(entries.map(entry => entry.hook)).toEqual(['subscribe', 'unsubscribe']);
                });
                // One more round trip: an answer to the stream would have been written before this one's.
                await server.hooks('cancelled');
                expect(connection.received.filter(message => 'id' in message && message.id === id)).toEqual([]);
            });
        }

        if (arm === 'http') {
            it('reconnects from its cursor after the server-side stream drops', async () => {
                const subscription = await subscribe(NOTE, 'drop', 'push');
                await server.emit('drop', 'before');
                expect(texts(await next(subscription))).toEqual(['before']);
                const [opened] = await server.hooks('drop');
                (connection as HttpConnection).dropStreams();
                // The server releases the dropped stream, and the client opens a new one.
                await vi.waitFor(
                    async () => {
                        const entries = await server.hooks('drop');
                        expect(entries).toContainEqual({ ...opened, hook: 'unsubscribe' });
                        expect(entries.filter(entry => entry.hook === 'subscribe')).toHaveLength(2);
                    },
                    { timeout: 5000 }
                );
                await server.emit('drop', 'after');
                expect(texts(await next(subscription))).toEqual(['after']);
                await subscription.cancel();
            });

            it("delivers under responseMode: 'json', where a subscription picks push by default", async () => {
                const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
                const handler = handlerFor(eventsFixture(), { responseMode: 'json' });
                expect(warn).toHaveBeenCalledWith(expect.stringContaining('events/stream'));
                warn.mockRestore();
                const json = await overHttp(() => handler);
                try {
                    const subscription = await json.events.subscribe<Note>({ name: NOTE, arguments: { tag: 'json' } });
                    expect(subscription.deliveryMode).toBe('push');
                    await driver(json.client).emit('json', 'streamed');
                    expect(texts(await next(subscription))).toEqual(['streamed']);
                    await subscription.cancel();
                } finally {
                    await json.close();
                    await handler.close();
                }
            });
        }
    });

    describe('termination', () => {
        it.each(['poll', 'push'] as const)('ends a %s subscription with the error handle.terminate gives', async mode => {
            const tag = `terminate-${mode}`;
            const subscription = await subscribe(NOTE, tag, mode);
            await server.terminate(NOTE, tag, mode);
            const ended = next(subscription);
            await expect(ended).rejects.toBeInstanceOf(EventsError);
            await expect(ended).rejects.toMatchObject({ kind: 'forbidden', message: 'Access revoked' });
            const entries = await server.hooks(tag);
            expect(entries.map(entry => entry.hook)).toEqual(['subscribe', 'unsubscribe']);
        });
    });
});

describe.each([['http'], ['stdio'], ['inMemory']] as const)('events over %s on 2025-11-25', arm => {
    let connection: Connection;

    beforeAll(async () => {
        connection = await connect(arm, LEGACY);
    }, 30_000);

    afterAll(async () => {
        await connection.close();
    });

    it('advertises nothing, refuses events.list(), and answers a raw events/list with -32601', async () => {
        expect(connection.client.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION_ID]).toBeUndefined();
        expect(connection.events.supported).toBe(false);
        const listed = connection.events.list();
        await expect(listed).rejects.toBeInstanceOf(SdkError);
        await expect(listed).rejects.toMatchObject({ code: SdkErrorCode.CapabilityNotSupported });
        await expect(raw(connection.client, 'events/list')).rejects.toMatchObject({ code: -32_601 });
    });

    // stdio and in memory pin the session to the era `initialize` opened; over HTTP each request is classified by its own envelope.
    if (arm !== 'http') {
        it('refuses events/* that claim 2026-07-28 in _meta on a session opened with initialize', async () => {
            const envelope = {
                [PROTOCOL_VERSION_META_KEY]: MODERN,
                [CLIENT_INFO_META_KEY]: { name: 'events-host', version: '1.0.0' },
                [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [EVENTS_EXTENSION_ID]: {} } }
            };
            // Method not found, or the Protocol layer's unsupported-protocol-version error.
            const codeOf = (request: Promise<unknown>) =>
                request.then(
                    () => 'served',
                    (error: { code?: unknown }) => error.code
                );
            expect([-32_601, -32_022]).toContain(await codeOf(raw(connection.client, 'events/list', { _meta: envelope })));
            expect([-32_601, -32_022]).toContain(
                await codeOf(
                    raw(connection.client, 'events/poll', { name: NOTE, arguments: { tag: 'spoofed' }, cursor: null, _meta: envelope })
                )
            );
        });
    }
});

// One webhook POST, as the server's sender handed it over and the receiver answered it.
interface Post {
    readonly headers: Readonly<Record<string, string>>;
    readonly raw: string;
    readonly body: Record<string, unknown>;
    // Set once the receiver has answered, which is after it handed an event to the subscription.
    status?: number;
    answer?: string;
}

// A webhookSender that hands each POST to the client's receiver as a Request (no network), recording it as it is sent; `refuse` answers some 503 instead.
function inProcessSender(
    receive: (request: Request) => Promise<Response>,
    posts: Post[],
    refuse: (body: Record<string, unknown>) => boolean = () => false
): WebhookSender {
    return async ({ url, headers, body }) => {
        const post: Post = { headers, raw: body, body: JSON.parse(body) as Record<string, unknown> };
        posts.push(post);
        if (refuse(post.body)) {
            Object.assign(post, { status: 503, answer: '' });
            return { status: 503, body: '' };
        }
        const response = await receive(new Request(url, { method: 'POST', headers, body }));
        Object.assign(post, { status: response.status, answer: await response.text() });
        return { status: post.status!, body: post.answer! };
    };
}

// `post` once the receiver's answer is recorded.
function answered(post: Post | undefined): Promise<Post> {
    return vi.waitFor(() => {
        expect(post?.status).toBeDefined();
        return post!;
    });
}

// The receiver's handler served over node:http on 127.0.0.1; resolves with its origin.
async function listenLoopback(receive: () => (request: Request) => Promise<Response>): Promise<{ origin: string; server: HttpServer }> {
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = Object.entries(req.headers).flatMap(([key, value]) =>
            typeof value === 'string' ? [[key, value] as [string, string]] : []
        );
        const response = await receive()(
            new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) })
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
    });
    const url = await listenOnRandomPort(server);
    return { origin: url.origin, server };
}

// The Standard Webhooks signature of `post` under `secret`: v1, base64 HMAC-SHA256 of `id.timestamp.body`.
async function signatureOf(secret: string, post: Post): Promise<string> {
    const keyBytes = Uint8Array.from(atob(secret.slice('whsec_'.length)), char => char.codePointAt(0)!);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = `${post.headers['webhook-id']}.${post.headers['webhook-timestamp']}.${post.raw}`;
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)));
    return `v1,${btoa(String.fromCodePoint(...mac))}`;
}

const getPrincipal: EventsOptions['getPrincipal'] = ctx => (ctx.http?.authInfo?.extra?.sub as string | undefined) ?? null;

function eventPosts(posts: Post[], subscriptionId: string): Post[] {
    return posts.filter(post => post.headers['X-MCP-Subscription-Id'] === subscriptionId && post.body.type === undefined);
}

describe('maxAgeMs over http', () => {
    it('keeps the floor subscribe() set on every page of a check replay', async () => {
        const old = new Date(Date.now() - 600_000).toISOString();
        // One upstream entry per page; `stale` is older than the floor and sits on the second page.
        const upstream = [
            { eventId: 'fresh-1', data: { n: 1 } },
            { eventId: 'stale', timestamp: old, data: { n: 2 } },
            { eventId: 'fresh-3', data: { n: 3 } }
        ];
        const events = new EventsExtension();
        events.registerEvent('paged', {
            payloadSchema: z.object({ n: z.number() }),
            check: (_ctx, _args, cursor) => {
                const from = cursor === null ? upstream.length : Number(cursor);
                const to = Math.min(upstream.length, from + 1);
                return { events: upstream.slice(from, to), cursor: String(to), hasMore: to < upstream.length, nextPollMs: 60_000 };
            }
        });
        const handler = createMcpHandler(() => new McpServer({ name: 'paged', version: '1.0.0' }, { extensions: [events] }));
        const connection = await overHttp(() => handler);
        try {
            const gaps: Array<string | null> = [];
            const subscription = await connection.events.subscribe<{ n: number }>({
                name: 'paged',
                delivery: 'poll',
                cursor: '0',
                maxAgeMs: 300_000,
                onGap: gap => void gaps.push(gap)
            });
            expect(await next(subscription, 2)).toEqual([{ n: 1 }, { n: 3 }]);
            expect(gaps).toEqual(['2']);
            await subscription.cancel();
        } finally {
            await connection.close();
            await handler.close();
        }
    });
});

describe('push backpressure over http', () => {
    it('resumes a large check backlog by push a page at a time, holding about 1 000 events for a loop that does not read', async () => {
        const upstream = Array.from({ length: 3000 }, (_, n) => ({ eventId: `u${n}`, data: { n } }));
        const pageSizes: Array<number | undefined> = [];
        const events = new EventsExtension();
        events.registerEvent('backlog', {
            payloadSchema: z.object({ n: z.number() }),
            check: (ctx, _args, cursor) => {
                pageSizes.push(ctx.maxEvents);
                const from = cursor === null ? upstream.length : Number(cursor);
                const to = Math.min(upstream.length, from + (ctx.maxEvents ?? upstream.length));
                return { events: upstream.slice(from, to), cursor: String(to), hasMore: to < upstream.length };
            }
        });
        const handler = createMcpHandler(() => new McpServer({ name: 'backlog', version: '1.0.0' }, { extensions: [events] }));
        const connection = await overHttp(() => handler);
        const delivered = () =>
            connection.received.filter(message => isEventsFrame(message) && message.method === 'notifications/events/event').length;
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        try {
            const subscription = await connection.events.subscribe<{ n: number }>({ name: 'backlog', delivery: 'push', cursor: '0' });
            // The loop does not read: the client stops taking events at about 1 000 and closes its stream.
            await vi.waitFor(() => expect(delivered()).toBeGreaterThanOrEqual(1000), { timeout: 5000 });
            await wait(300);
            const held = delivered();
            expect(held).toBeLessThan(1500);
            await wait(300);
            expect(delivered()).toBe(held);

            // Then the loop gets every event once, in order, and the stream reopened once per half of the queue it drained.
            const data = await next(subscription, 3000);
            expect(data.map(item => item.n)).toEqual(upstream.map(item => item.data.n));
            expect(new Set(pageSizes)).toEqual(new Set([100]));
            expect(connection.requests.filter(request => request.method === 'events/stream').length).toBeLessThanOrEqual(7);
            await subscription.cancel();
        } finally {
            await connection.close();
            await handler.close();
        }
    });
});

describe('webhook delivery over http', () => {
    // A client set up for webhook delivery to HOOK_URL, the server webhook-enabled with an in-process sender to its receiver.
    async function webhookPair(options: { ttlMs?: number; secret?: string; refuse?: (body: Record<string, unknown>) => boolean } = {}) {
        const events = new EventsClientExtension({
            ...CLIENT_OPTIONS,
            webhook: { url: HOOK_URL, ...(options.secret !== undefined && { secretProvider: () => options.secret! }) }
        });
        const posts: Post[] = [];
        const store = new InMemoryWebhookSubscriptionStore();
        const fixture = eventsFixture({
            webhookTtlMs: options.ttlMs ?? 60_000,
            webhookSender: inProcessSender(events.createWebhookHandler(), posts, options.refuse),
            webhookStore: store,
            getPrincipal
        });
        const handler = handlerFor(fixture);
        const connection = await overHttp(() => handler, { events, authInfo: ALICE });
        return {
            ...connection,
            posts,
            store,
            fixture,
            close: async () => {
                await connection.close();
                await handler.close();
            }
        };
    }

    const emit = (fixture: EventsFixture, tag: string, text: string) => fixture.note.emit({ data: { tag, text } });

    it('verifies the endpoint, delivers signed events, refreshes and unsubscribes', async () => {
        // A 2 s grant: the client refreshes after 1.5 s.
        const pair = await webhookPair({ ttlMs: 2000, secret: SECRET });
        try {
            const subscription = await pair.events.subscribe<Note>({ name: NOTE, arguments: { tag: 'hook' } });
            expect(subscription.deliveryMode).toBe('webhook');
            const [{ subscriptionId }] = pair.fixture.log as [HookEntry];
            // The subscribe answered after the receiver echoed the challenge.
            expect(pair.posts).toHaveLength(1);
            const [verification] = pair.posts as [Post];
            expect(verification).toMatchObject({ body: { type: 'verification', challenge: expect.any(String) }, status: 200 });
            expect(JSON.parse(verification.answer!)).toEqual({ challenge: verification.body.challenge });

            await emit(pair.fixture, 'hook', 'signed');
            expect(texts(await next(subscription))).toEqual(['signed']);
            const delivery = await answered(eventPosts(pair.posts, subscriptionId)[0]);
            expect(delivery).toMatchObject({ status: 200, body: { name: NOTE, data: { tag: 'hook', text: 'signed' } } });
            expect(delivery.headers).toMatchObject({
                'Content-Type': 'application/json',
                'webhook-id': expect.stringMatching(/^[\w-]+$/),
                'webhook-timestamp': expect.stringMatching(/^\d+$/)
            });
            expect(delivery.headers['webhook-signature']).toBe(await signatureOf(SECRET, delivery));

            // The refresh answer carries the delivery status this process holds.
            await vi.waitFor(
                () =>
                    expect(subscription.deliveryStatus).toMatchObject({
                        active: true,
                        lastError: null,
                        lastDeliveryAt: expect.any(String)
                    }),
                { timeout: 5000 }
            );
            expect(pair.requests.filter(request => request.method === 'events/subscribe').length).toBeGreaterThan(1);

            await subscription.cancel();
            expect(pair.requests.at(-1)?.method).toBe('events/unsubscribe');
            expect(await pair.store.get(subscriptionId)).toBeUndefined();
            expect(pair.fixture.log.map(entry => entry.hook)).toEqual(['subscribe', 'unsubscribe']);
        } finally {
            await pair.close();
        }
    });

    it('subscribes a client set up for webhook by push when it connects without a principal, as webhook is not listed to it', async () => {
        const events = new EventsClientExtension({ ...CLIENT_OPTIONS, webhook: { url: HOOK_URL } });
        const posts: Post[] = [];
        const fixture = eventsFixture({
            webhookTtlMs: 60_000,
            webhookSender: inProcessSender(events.createWebhookHandler(), posts),
            getPrincipal
        });
        const handler = handlerFor(fixture);
        const connection = await overHttp(() => handler, { events });
        try {
            const listed = await events.list();
            expect(listed.events.find(type => type.name === NOTE)?.delivery).toEqual(['poll', 'push']);
            const subscription = await events.subscribe<Note>({ name: NOTE, arguments: { tag: 'anonymous' } });
            expect(subscription.deliveryMode).toBe('push');
            await emit(fixture, 'anonymous', 'pushed');
            expect(texts(await next(subscription))).toEqual(['pushed']);
            expect(posts).toEqual([]);
            await subscription.cancel();
        } finally {
            await connection.close();
            await handler.close();
        }
    });

    it('retries a delivery the receiver refused, under the same webhook-id', async () => {
        let refused = false;
        const pair = await webhookPair({
            refuse: body => {
                if (refused || body.type !== undefined) return false;
                refused = true;
                return true;
            }
        });
        try {
            const subscription = await pair.events.subscribe<Note>({ name: NOTE, arguments: { tag: 'retry' } });
            await emit(pair.fixture, 'retry', 'retried');
            // The engine's first retry waits 5 s.
            expect(texts(await next(subscription))).toEqual(['retried']);
            const attempts = eventPosts(pair.posts, pair.fixture.log[0]!.subscriptionId);
            await answered(attempts[1]);
            expect(attempts.map(post => post.status)).toEqual([503, 200]);
            expect(attempts[1]!.headers['webhook-id']).toBe(attempts[0]!.headers['webhook-id']);
            await subscription.cancel();
        } finally {
            await pair.close();
        }
    }, 15_000);

    it('ends a webhook subscription with the error handle.terminate gives', async () => {
        const pair = await webhookPair();
        try {
            const subscription = await pair.events.subscribe<Note>({ name: NOTE, arguments: { tag: 'terminate-webhook' } });
            const [{ subscriptionId }] = pair.fixture.log as [HookEntry];
            await pair.fixture.note.terminate(new ServerEventsError('forbidden', 'Access revoked'), { subscriptionId });
            const ended = next(subscription);
            await expect(ended).rejects.toBeInstanceOf(EventsError);
            await expect(ended).rejects.toMatchObject({ kind: 'forbidden', message: 'Access revoked' });
            expect(pair.posts.at(-1)).toMatchObject({ body: { type: 'terminated', error: { message: 'Access revoked' } } });
            expect(pair.fixture.log.map(entry => entry.hook)).toEqual(['subscribe', 'unsubscribe']);
        } finally {
            await pair.close();
        }
    });

    it('delivers an emit end to end through nodeWebhookSender to a receiver on loopback', async () => {
        let receive: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
        const { origin, server } = await listenLoopback(() => receive);
        const events = new EventsClientExtension({ ...CLIENT_OPTIONS, webhook: { url: `${origin}/hooks` } });
        receive = events.createWebhookHandler();
        const fixture = eventsFixture({ webhookTtlMs: 60_000, webhookSender: nodeWebhookSender(), trustedOrigins: [origin], getPrincipal });
        const handler = handlerFor(fixture);
        const connection = await overHttp(() => handler, { events, authInfo: ALICE });
        try {
            const subscription = await events.subscribe<Note>({ name: NOTE, arguments: { tag: 'loopback' } });
            await emit(fixture, 'loopback', 'over the wire');
            expect(texts(await next(subscription))).toEqual(['over the wire']);
            await subscription.cancel();
        } finally {
            await connection.close();
            await handler.close();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('serves one subscription from two replicas sharing a store: refresh, rotation, emit and unsubscribe on the second', async () => {
        // One secret per subscription, as the client requires: SECRET for the one under test, another for the witness.
        const secrets = [SECRET, `whsec_${btoa('c'.repeat(32))}`];
        const events = new EventsClientExtension({ ...CLIENT_OPTIONS, webhook: { url: HOOK_URL, secretProvider: () => secrets.shift()! } });
        const posts: Post[] = [];
        const store = new InMemoryWebhookSubscriptionStore();
        // A 2 s grant: the client refreshes after 1.5 s.
        const options = {
            webhookTtlMs: 2000,
            webhookSender: inProcessSender(events.createWebhookHandler(), posts),
            webhookStore: store,
            getPrincipal
        };
        const first = eventsFixture(options);
        const second = eventsFixture(options);
        const firstHandler = handlerFor(first);
        const secondHandler = handlerFor(second);
        let target = firstHandler;
        const connection = await overHttp(() => target, { events, authInfo: ALICE });
        try {
            const subscription = await events.subscribe<Note>({ name: NOTE, arguments: { tag: 'replicas' } });
            // A second subscription served by the first replica, whose delivery shows the first has handled every emit before it.
            const witness = await events.subscribe<Note>({ name: NOTE, arguments: { tag: 'witness' } });
            const { subscriptionId } = first.log.find(entry => entry.tag === 'replicas')!;

            target = secondHandler;
            await vi.waitFor(() => expect(connection.requests).toContainEqual({ handler: secondHandler, method: 'events/subscribe' }), {
                timeout: 5000
            });
            const rotated = await raw(connection.client, 'events/subscribe', {
                name: NOTE,
                arguments: { tag: 'replicas' },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: ROTATED }
            });
            expect(rotated).toMatchObject({ id: subscriptionId });
            const record = await store.get(subscriptionId);
            // The client's own refreshes rotate back to its secret: either way both are in the record.
            expect([record?.secret, record?.previousSecret?.secret].toSorted()).toEqual([SECRET, ROTATED].toSorted());

            await emit(second, 'replicas', 'from the second');
            expect(texts(await next(subscription))).toEqual(['from the second']);
            const [delivery] = eventPosts(posts, subscriptionId) as [Post];
            const signatures = delivery.headers['webhook-signature']!.split(' ');
            expect(signatures).toHaveLength(2);
            expect(signatures).toEqual(expect.arrayContaining([await signatureOf(SECRET, delivery), await signatureOf(ROTATED, delivery)]));

            await subscription.cancel();
            expect(connection.requests.at(-1)).toEqual({ handler: secondHandler, method: 'events/unsubscribe' });
            const delivered = posts.length;
            await emit(first, 'replicas', 'after unsubscribe');
            await emit(first, 'witness', 'after unsubscribe');
            expect(texts(await next(witness))).toEqual(['after unsubscribe']);
            expect(eventPosts(posts.slice(delivered), subscriptionId)).toEqual([]);
            await witness.cancel();
        } finally {
            await connection.close();
            await firstHandler.close();
            await secondHandler.close();
        }
    });

    it('keeps delivering to a stored subscription after a restart, without a resubscribe', async () => {
        const events = new EventsClientExtension({ ...CLIENT_OPTIONS, webhook: { url: HOOK_URL } });
        const posts: Post[] = [];
        const store = new InMemoryWebhookSubscriptionStore();
        const options = {
            webhookTtlMs: 60_000,
            webhookSender: inProcessSender(events.createWebhookHandler(), posts),
            webhookStore: store,
            getPrincipal
        };
        const before = handlerFor(eventsFixture(options));
        let target = before;
        const connection = await overHttp(() => target, { events, authInfo: ALICE });
        try {
            const subscription = await events.subscribe<Note>({ name: NOTE, arguments: { tag: 'restart' } });
            await before.close();

            const restarted = eventsFixture(options);
            target = handlerFor(restarted);
            const requests = connection.requests.length;
            const delivered = posts.length;
            await emit(restarted, 'restart', 'after the restart');
            expect(texts(await next(subscription))).toEqual(['after the restart']);
            expect(connection.requests.slice(requests)).toEqual([]);
            expect(posts.slice(delivered).map(post => post.body.type ?? 'event')).toEqual(['event']);
            await subscription.cancel();
            expect(restarted.log).toEqual([expect.objectContaining({ hook: 'unsubscribe', tag: 'restart' })]);
        } finally {
            await connection.close();
            await target.close();
        }
    });
});
