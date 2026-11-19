/**
 * Wire behaviour of the Events extension (SEP-3415) over Streamable HTTP:
 * raw JSON-RPC and headers through `createMcpHandler`, and what a real
 * `EventsClientExtension` sends. This suite is the contract for the version
 * built on the extensions mechanism (#2820 / SEP-3371): it must pass
 * unchanged against it.
 */
import { Client, isJsonContentType, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { EventsClientExtension } from '@modelcontextprotocol/client/ext/events';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { EmitOnlyEventHandle } from '@modelcontextprotocol/server/ext/events';
import { EventsError, EventsExtension } from '@modelcontextprotocol/server/ext/events';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

const MODERN = '2026-07-28';
const EXTENSION = 'io.modelcontextprotocol/events';
const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const ENVELOPE = {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'wire-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': { extensions: { [EXTENSION]: {} } }
};
// A 2026-07-28 result carries the server's identity in `_meta`.
const RESULT_META = { [SERVER_INFO]: { name: 'events-wire', version: '1.0.0' } };
const NAME = 'incident.created';
const HOOK_URL = 'https://hooks.example.com/mcp';
const SECRET = `whsec_${btoa('s'.repeat(32))}`;
const ARGUMENTS = { region: 'us-west1', severity: 'high' };
const EVENTS_METHODS = ['events/list', 'events/poll', 'events/stream', 'events/subscribe', 'events/unsubscribe'];
const NAMED_METHODS = EVENTS_METHODS.slice(1);

interface Served {
    readonly handler: McpHttpHandler;
    readonly incident: EmitOnlyEventHandle<{ title: string }>;
}

interface Reply {
    readonly status: number;
    readonly body: { id?: unknown; result?: Record<string, unknown>; error?: { code: number; data?: Record<string, unknown> } };
}

// One emit-only event type whose `region` argument has an `x-mcp-header`; webhook delivery is on, and the sender answers verification challenges itself.
function served(): Served {
    const events = new EventsExtension({
        webhookTtlMs: 60_000,
        webhookSender: async ({ body }) => {
            const { type, challenge } = JSON.parse(body) as { type?: string; challenge?: string };
            return { status: 200, body: type === 'verification' ? JSON.stringify({ challenge }) : '' };
        },
        getPrincipal: () => 'alice'
    });
    const incident = events.registerEvent(NAME, {
        emitOnly: true,
        inputSchema: z.object({ region: z.string().meta({ 'x-mcp-header': 'Region' }), severity: z.string().optional() }),
        payloadSchema: z.object({ title: z.string() })
    });
    const handler = createMcpHandler(() => new McpServer({ name: 'events-wire', version: '1.0.0' }, { extensions: [events] }));
    return { handler, incident };
}

let nextId = 1;

// A 2026-07-28 request with the envelope, Mcp-Method and, for a method that names an event type, Mcp-Name; `headers` adds to them.
function post(
    handler: McpHttpHandler,
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string> = {}
): { id: string; response: Promise<Response> } {
    const id = `wire-${nextId++}`;
    const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MODERN,
            'mcp-method': method,
            ...(NAMED_METHODS.includes(method) && { 'mcp-name': params.name as string }),
            ...headers
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: ENVELOPE } })
    });
    return { id, response: handler.fetch(request) };
}

async function reply(response: Promise<Response>): Promise<Reply> {
    const answer = await response;
    expect(answer.headers.get('content-type')).toContain('application/json');
    return { status: answer.status, body: (await answer.json()) as Reply['body'] };
}

// The JSON-RPC messages of an SSE response, as its `data:` frames arrive.
async function* frames(response: Response): AsyncGenerator<Record<string, unknown>> {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += value;
            let end: number;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
                const data = buffer
                    .slice(0, end)
                    .split('\n')
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).trimStart())
                    .join('\n');
                buffer = buffer.slice(end + 2);
                if (data !== '') yield JSON.parse(data) as Record<string, unknown>;
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}

async function nextFrame(stream: AsyncGenerator<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const { done, value } = await stream.next();
    if (done === true) throw new Error('the stream ended');
    return value;
}

const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
    for (const closable of open.splice(0).toReversed()) await closable.close();
});

function track(server: Served): Served {
    open.push(server.handler);
    return server;
}

describe('events wire behaviour', () => {
    it('declares the extension with an empty settings object', async () => {
        const { handler } = track(served());
        const { status, body } = await reply(post(handler, 'server/discover', {}).response);
        expect(status).toBe(200);
        expect((body.result?.capabilities as { extensions?: Record<string, unknown> }).extensions?.[EXTENSION]).toEqual({});
    });

    it.each(NAMED_METHODS)('rejects a mismatched Mcp-Param-Region on %s with 400 and -32020', async method => {
        const { handler } = track(served());
        const params = {
            name: NAME,
            arguments: ARGUMENTS,
            ...(method === 'events/subscribe' && { delivery: { mode: 'webhook', url: HOOK_URL, secret: SECRET } }),
            ...(method === 'events/unsubscribe' && { delivery: { url: HOOK_URL } })
        };
        const { status, body } = await reply(post(handler, method, params, { 'mcp-param-region': 'eu-west1' }).response);
        expect(status).toBe(400);
        expect(body.error).toMatchObject({ code: -32_020 });
    });

    it('accepts a correctly headered events/subscribe on a webhook-enabled server', async () => {
        const { handler } = track(served());
        const delivery = { mode: 'webhook', url: HOOK_URL, secret: SECRET };
        const { status, body } = await reply(
            post(handler, 'events/subscribe', { name: NAME, arguments: ARGUMENTS, delivery }, { 'mcp-param-region': 'us-west1' }).response
        );
        expect(status).toBe(200);
        expect(body.result).toEqual({
            id: expect.stringMatching(/^[\w-]+$/),
            refreshBefore: expect.any(String),
            cursor: expect.any(String),
            truncated: false,
            resultType: 'complete',
            _meta: RESULT_META
        });
    });

    it('opens events/stream with notifications/events/active, and ends it with the empty result when the server terminates it', async () => {
        const { handler, incident } = track(served());
        const { id, response } = post(
            handler,
            'events/stream',
            { name: NAME, arguments: ARGUMENTS, cursor: null },
            { 'mcp-param-region': 'us-west1' }
        );
        const answer = await response;
        expect(answer.status).toBe(200);
        expect(answer.headers.get('content-type')).toContain('text/event-stream');
        const stream = frames(answer);
        const tagged = { _meta: { [SUBSCRIPTION_ID]: id } };

        expect(await nextFrame(stream)).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/events/active',
            params: { cursor: expect.any(String), truncated: false, heartbeatMs: 30_000, ...tagged }
        });

        await incident.emit({ eventId: 'inc-1', data: { title: 'Disk full' } });
        expect(await nextFrame(stream)).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/events/event',
            params: {
                eventId: 'inc-1',
                name: NAME,
                timestamp: expect.any(String),
                data: { title: 'Disk full' },
                cursor: expect.any(String),
                ...tagged
            }
        });

        await incident.terminate(new EventsError('forbidden', 'Access revoked'));
        expect(await nextFrame(stream)).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/events/terminated',
            params: { error: { code: -32_024, message: 'Access revoked' }, ...tagged }
        });
        expect(await nextFrame(stream)).toEqual({
            jsonrpc: '2.0',
            id,
            result: { resultType: 'complete', _meta: { ...RESULT_META, [SUBSCRIPTION_ID]: id } }
        });
        const end = await stream.next();
        expect(end.done).toBe(true);
    });
});

describe('what a client sends', () => {
    // Every HTTP exchange a client made: list, then a poll, a push and a webhook subscription, each cancelled.
    const exchanges: Array<{ headers: Headers; body: { method?: string }; result?: Record<string, unknown> }> = [];

    beforeAll(async () => {
        const server = served();
        const events = new EventsClientExtension({ webhook: { url: HOOK_URL } });
        const client = new Client(
            { name: 'wire-client', version: '1.0.0' },
            { versionNegotiation: { mode: { pin: MODERN } }, extensions: [events] }
        );
        const fetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
            const request = new Request(url, init);
            const response = await server.handler.fetch(request);
            const body = JSON.parse(init?.body as string) as { method?: string };
            const json = isJsonContentType(response.headers.get('content-type'));
            const answer = json ? ((await response.clone().json()) as { result?: Record<string, unknown> }) : undefined;
            const result = answer?.result;
            exchanges.push({ headers: request.headers, body, ...(result !== undefined && { result }) });
            return response;
        };
        await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch }));
        await events.list();
        for (const delivery of ['poll', 'push', 'webhook'] as const) {
            const subscription = await events.subscribe({ name: NAME, arguments: ARGUMENTS, delivery });
            await subscription.cancel();
        }
        await client.close();
        await server.handler.close();
    });

    const sent = (method: string) => exchanges.filter(exchange => exchange.body.method === method);

    it('sends Mcp-Method on every events/* request, and Mcp-Name with the event name on those that name one', () => {
        for (const method of EVENTS_METHODS) {
            expect(sent(method).length).toBeGreaterThan(0);
            for (const { headers } of sent(method)) {
                expect(headers.get('mcp-method')).toBe(method);
                expect(headers.get('mcp-name')).toBe(method === 'events/list' ? null : NAME);
            }
        }
    });

    it('mirrors the annotated region argument as Mcp-Param-Region, and nothing else', () => {
        for (const method of NAMED_METHODS) {
            for (const { headers } of sent(method)) {
                expect(headers.get('mcp-param-region')).toBe('us-west1');
                expect([...headers.keys()].filter(key => key.startsWith('mcp-param-'))).toEqual(['mcp-param-region']);
            }
        }
    });

    it('never sends subscriptions/listen', () => {
        expect(exchanges.map(exchange => exchange.body.method)).not.toContain('subscriptions/listen');
        expect(exchanges.map(exchange => exchange.headers.get('mcp-method'))).not.toContain('subscriptions/listen');
    });

    it("gets resultType 'complete' on every events/* result", () => {
        // events/stream results are pinned above: the client ends its streams, so no result is sent to it.
        for (const method of ['events/list', 'events/poll', 'events/subscribe', 'events/unsubscribe']) {
            const results = sent(method).map(exchange => exchange.result);
            expect(results.length).toBeGreaterThan(0);
            for (const result of results) expect(result).toMatchObject({ resultType: 'complete' });
        }
    });
});
