/**
 * createMcpHandler — entry-handled `subscriptions/listen` router.
 *
 * Covers ack-first (the acknowledged notification is the first frame),
 * subscription-id stamping (the listen request's JSON-RPC id verbatim),
 * per-stream filtering (un-requested types provably never delivered),
 * notify sugar, capacity guard, capability-narrowed honored filter, and
 * teardown.
 */
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import { createMcpHandler } from '../../src/server/createMcpHandler';
import { McpServer } from '../../src/server/mcp';
import type { ServerEventBus } from '../../src/server/serverEventBus';

const MODERN_REVISION = '2026-07-28';
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'listen-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

function listenRequest(id: string | number, filter: Record<string, unknown>, sessionId?: string): Request {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN_REVISION,
        'mcp-method': 'subscriptions/listen'
    };
    if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'subscriptions/listen',
            params: { _meta: ENVELOPE, notifications: filter }
        })
    });
}

/** Read N SSE `event: message` payloads from a streaming response, then cancel. */
async function readMessages(response: Response, n: number): Promise<unknown[]> {
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const messages: unknown[] = [];
    while (messages.length < n) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) messages.push(JSON.parse(dataLine.slice(6)));
        }
    }
    await reader.cancel();
    return messages;
}

function trivialFactory(): () => McpServer {
    // Declare every listChanged / subscribe bit so the tests below see the
    // requested filter honored as-is (the entry now narrows the ack against
    // the per-serve instance's declared capabilities).
    return () =>
        new McpServer(
            { name: 'listen-test-server', version: '1.0.0' },
            {
                capabilities: {
                    tools: { listChanged: true },
                    prompts: { listChanged: true },
                    resources: { listChanged: true, subscribe: true }
                }
            }
        );
}

describe('createMcpHandler — subscriptions/listen', () => {
    it('serves listen at the entry, consulting the factory only for its declared capabilities', async () => {
        let factoryCalls = 0;
        let connectCalls = 0;
        let closeCalls = 0;
        const handler = createMcpHandler(
            () => {
                factoryCalls++;
                const s = new McpServer({ name: 's', version: '1' });
                const { connect, close } = s;
                s.connect = tx => {
                    connectCalls++;
                    return connect.call(s, tx);
                };
                s.close = () => {
                    closeCalls++;
                    return close.call(s);
                };
                return s;
            },
            { keepAliveMs: 0 }
        );
        const response = await handler.fetch(listenRequest(1, { toolsListChanged: true }));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
        const [ack] = await readMessages(response, 1);
        // The factory is consulted exactly once (capabilities probe only); the
        // instance is never connected and is closed immediately after the
        // capabilities read so a factory-allocated resource cannot leak.
        expect(factoryCalls).toBe(1);
        expect(connectCalls).toBe(0);
        expect(closeCalls).toBe(1);
        expect((ack as { method: string }).method).toBe('notifications/subscriptions/acknowledged');
        await handler.close();
    });

    it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY])('disables invalid keepAliveMs %s', async keepAliveMs => {
        vi.useFakeTimers();
        try {
            const handler = createMcpHandler(trivialFactory(), { keepAliveMs });
            const response = await handler.fetch(listenRequest(1, { toolsListChanged: true }));
            const reader = response.body!.getReader();
            await reader.read();
            expect(vi.getTimerCount()).toBe(0);
            await reader.cancel();
            await handler.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it('cleans up when a custom bus unsubscribe throws', async () => {
        vi.useFakeTimers();
        try {
            const onerror = vi.fn();
            const bus: ServerEventBus = {
                publish() {},
                subscribe: () => () => {
                    throw new Error('unsubscribe failed');
                }
            };
            const handler = createMcpHandler(trivialFactory(), { bus, keepAliveMs: 1_000, onerror });
            const response = await handler.fetch(listenRequest(1, { toolsListChanged: true }));
            const reader = response.body!.getReader();
            await reader.read();
            await reader.cancel();
            expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'unsubscribe failed' }));
            expect(vi.getTimerCount()).toBe(0);
            await handler.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it('ack is the first frame, stamped with the listen id verbatim, carrying the honored subset', async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0 });
        const response = await handler.fetch(listenRequest('sub-42', { toolsListChanged: true, promptsListChanged: false }));
        const [ack] = await readMessages(response, 1);
        expect(ack).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: 'sub-42' }, notifications: { toolsListChanged: true } }
        });
        await handler.close();
    });

    it('delivers only opted-in change types, each stamped with the subscription id', async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0 });
        const response = await handler.fetch(listenRequest(7, { toolsListChanged: true, resourceSubscriptions: ['file:///a'] }));
        // Publish before reading: a stream that did NOT opt in to prompts must
        // never see the prompts notification (provably-never-delivered).
        handler.notify.promptsChanged();
        handler.notify.toolsChanged();
        handler.notify.resourceUpdated('file:///b');
        handler.notify.resourceUpdated('file:///a');
        const messages = (await readMessages(response, 3)) as { method: string; params: Record<string, unknown> }[];
        expect(messages.map(m => m.method)).toEqual([
            'notifications/subscriptions/acknowledged',
            'notifications/tools/list_changed',
            'notifications/resources/updated'
        ]);
        expect(messages[2]!.params).toEqual({ _meta: { [SUBSCRIPTION_ID_META_KEY]: 7 }, uri: 'file:///a' });
        for (const m of messages) {
            expect((m.params['_meta'] as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY]).toBe(7);
        }
        await handler.close();
    });

    it("refuses pre-ack with -32603 'Subscription limit reached' when at capacity", async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0, maxSubscriptions: 1 });
        const first = await handler.fetch(listenRequest(1, { toolsListChanged: true }));
        expect(first.headers.get('Content-Type')).toBe('text/event-stream');
        const second = await handler.fetch(listenRequest(2, { toolsListChanged: true }));
        expect(second.headers.get('Content-Type')).toContain('application/json');
        const body = (await second.json()) as { error: { code: number; message: string }; id: unknown };
        expect(body.error.code).toBe(-32_603);
        expect(body.error.message).toBe('Subscription limit reached');
        expect(body.id).toBe(2);
        await first.body!.cancel();
        await handler.close();
    });

    it('enforces maxSubscriptionsPerSession per resolved session key, independently of other sessions', async () => {
        // Per-session cap: two sessions, cap of 1 each. Each session's second
        // listen is refused with -32603; the other session is unaffected. The
        // test resolver reads from the mcp-session-id header for shape, which
        // is the deployment's trust choice. The SDK itself does not consult
        // request headers.
        const handler = createMcpHandler(trivialFactory(), {
            keepAliveMs: 0,
            maxSubscriptions: 1024,
            maxSubscriptionsPerSession: 1,
            getSessionId: (_opts, req) => req.headers.get('mcp-session-id') ?? undefined
        });
        const sessionA = 'session-a';
        const sessionB = 'session-b';

        const aFirst = await handler.fetch(listenRequest(1, { toolsListChanged: true }, sessionA));
        expect(aFirst.headers.get('Content-Type')).toBe('text/event-stream');

        const aSecond = await handler.fetch(listenRequest(2, { toolsListChanged: true }, sessionA));
        expect(aSecond.headers.get('Content-Type')).toContain('application/json');
        const aBody = (await aSecond.json()) as { error: { code: number; message: string }; id: unknown };
        expect(aBody.error.code).toBe(-32_603);
        expect(aBody.error.message).toBe('Subscription limit reached');
        expect(aBody.id).toBe(2);

        // Session B still has capacity even though session A is full.
        const bFirst = await handler.fetch(listenRequest(3, { toolsListChanged: true }, sessionB));
        expect(bFirst.headers.get('Content-Type')).toBe('text/event-stream');

        // Session B now also at its cap.
        const bSecond = await handler.fetch(listenRequest(4, { toolsListChanged: true }, sessionB));
        const bBody = (await bSecond.json()) as { error: { code: number; message: string }; id: unknown };
        expect(bBody.error.code).toBe(-32_603);
        expect(bBody.id).toBe(4);

        await aFirst.body!.cancel();
        await bFirst.body!.cancel();
        await handler.close();
    });

    it('handler-wide maxSubscriptions still fires across sessions even when per-session cap has room', async () => {
        // Three sessions, each well under a generous per-session cap, but the
        // handler-wide cap of 2 fires on the third open regardless of session.
        const handler = createMcpHandler(trivialFactory(), {
            keepAliveMs: 0,
            maxSubscriptions: 2,
            maxSubscriptionsPerSession: 10,
            getSessionId: (_opts, req) => req.headers.get('mcp-session-id') ?? undefined
        });

        const one = await handler.fetch(listenRequest(1, { toolsListChanged: true }, 'session-a'));
        expect(one.headers.get('Content-Type')).toBe('text/event-stream');
        const two = await handler.fetch(listenRequest(2, { toolsListChanged: true }, 'session-b'));
        expect(two.headers.get('Content-Type')).toBe('text/event-stream');

        const three = await handler.fetch(listenRequest(3, { toolsListChanged: true }, 'session-c'));
        expect(three.headers.get('Content-Type')).toContain('application/json');
        const body = (await three.json()) as { error: { code: number; message: string }; id: unknown };
        expect(body.error.code).toBe(-32_603);
        expect(body.error.message).toBe('Subscription limit reached');
        expect(body.id).toBe(3);

        await one.body!.cancel();
        await two.body!.cancel();
        await handler.close();
    });

    it('throws TypeError at construction when maxSubscriptionsPerSession is set without getSessionId', () => {
        // Fail-closed configuration: per-session attribution has no safe
        // default source. The entry refuses to construct a handler that would
        // appear to enforce per-session isolation without a trusted resolver.
        expect(() => createMcpHandler(trivialFactory(), { maxSubscriptionsPerSession: 1 })).toThrow(TypeError);
    });

    it('refuses pre-ack with -32603 when getSessionId returns undefined for a configured per-session cap', async () => {
        // Fail-closed runtime contract: the resolver signaled it cannot
        // attribute this listen (no trusted identity available), so the SDK
        // refuses rather than silently applying only the handler-wide cap and
        // misreporting the guarantee.
        const handler = createMcpHandler(trivialFactory(), {
            keepAliveMs: 0,
            maxSubscriptionsPerSession: 1,
            getSessionId: () => undefined
        });
        const response = await handler.fetch(listenRequest(1, { toolsListChanged: true }, 'session-a'));
        expect(response.headers.get('Content-Type')).toContain('application/json');
        const body = (await response.json()) as { error: { code: number; message: string }; id: unknown };
        expect(body.error.code).toBe(-32_603);
        expect(body.error.message).toBe('Subscription limit reached');
        expect(body.id).toBe(1);
        await handler.close();
    });

    it('releases a per-session slot when the client cancels the listen stream', async () => {
        // Slot accounting on cancel: the client drops the SSE stream, teardown
        // decrements both the handler-wide and per-session buckets, and a
        // subsequent listen on the same session is accepted.
        const handler = createMcpHandler(trivialFactory(), {
            keepAliveMs: 0,
            maxSubscriptionsPerSession: 1,
            getSessionId: (_opts, req) => req.headers.get('mcp-session-id') ?? undefined
        });

        const first = await handler.fetch(listenRequest(1, { toolsListChanged: true }, 'session-a'));
        expect(first.headers.get('Content-Type')).toBe('text/event-stream');
        await first.body!.cancel();

        const second = await handler.fetch(listenRequest(2, { toolsListChanged: true }, 'session-a'));
        expect(second.headers.get('Content-Type')).toBe('text/event-stream');
        await second.body!.cancel();
        await handler.close();
    });

    it('does not consume a per-session slot for a listen whose honored filter narrows to empty', async () => {
        // Empty-honored listen (server declares no capabilities): the stream
        // acks and immediately completes, never adding the teardown to the
        // open set. A subsequent listen on the same session must still be
        // accepted under a cap of 1.
        const bareFactory = () => new McpServer({ name: 'listen-test-server', version: '1.0.0' }, { capabilities: {} });
        const handler = createMcpHandler(bareFactory, {
            keepAliveMs: 0,
            maxSubscriptionsPerSession: 1,
            getSessionId: (_opts, req) => req.headers.get('mcp-session-id') ?? undefined
        });

        const emptyListen = await handler.fetch(listenRequest(1, { toolsListChanged: true }, 'session-a'));
        // Drain to the server-side graceful close so the auto-completion runs.
        await emptyListen.text();

        const second = await handler.fetch(listenRequest(2, { toolsListChanged: true }, 'session-a'));
        expect(second.headers.get('Content-Type')).toBe('text/event-stream');
        await second.body!.cancel();
        await handler.close();
    });

    it('ignores getSessionId when maxSubscriptionsPerSession is unset, even if it would throw', async () => {
        // The resolver is documented as ignored without the per-session cap.
        // Verify it is not invoked, so a user-supplied throw cannot turn a
        // legitimate listen into a 500 when the cap is off.
        const getSessionId = vi.fn(() => {
            throw new Error('resolver should not be called when maxSubscriptionsPerSession is unset');
        });
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0, getSessionId });
        const response = await handler.fetch(listenRequest(1, { toolsListChanged: true }, 'session-a'));
        expect(response.headers.get('Content-Type')).toBe('text/event-stream');
        expect(getSessionId).not.toHaveBeenCalled();
        await response.body!.cancel();
        await handler.close();
    });

    it("rejects with -32602 when params.notifications is absent (spec marks 'notifications' REQUIRED)", async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0 });
        const response = await handler.fetch(
            new Request('http://localhost/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-protocol-version': MODERN_REVISION,
                    'mcp-method': 'subscriptions/listen'
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'subscriptions/listen', params: { _meta: ENVELOPE } })
            })
        );
        expect(response.headers.get('Content-Type')).toContain('application/json');
        const body = (await response.json()) as { error: { code: number; message: string }; id: unknown };
        expect(body.error.code).toBe(-32_602);
        expect(body.error.message).toContain("'notifications' is required");
        expect(body.id).toBe(9);
        await handler.close();
    });

    it('handler.close() emits the empty subscriptions/listen result, then closes the stream (graceful-close signal)', async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0 });
        const response = await handler.fetch(listenRequest(1, { toolsListChanged: true }));
        const reader = response.body!.getReader();
        // First frame is the ack.
        await reader.read();
        await handler.close();
        // Graceful-close termination: the SubscriptionsListenResult is the
        // final SSE frame, then the stream ends.
        let resultFrame: unknown;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = new TextDecoder().decode(value);
            const dataLine = text.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) {
                const message = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
                if ('result' in message) resultFrame = message;
            }
        }
        expect(resultFrame).toEqual({
            jsonrpc: '2.0',
            id: 1,
            result: {
                resultType: 'complete',
                _meta: {
                    'io.modelcontextprotocol/subscriptionId': 1,
                    // #3002: the close result carries the serving instance's
                    // identity like every other result (SubscriptionsListenResultMetaObject
                    // extends ResultMetaObject).
                    'io.modelcontextprotocol/serverInfo': { name: 'listen-test-server', version: '1.0.0' }
                }
            }
        });
    });

    it('acks and closes when capabilities honor nothing, instead of holding the stream', async () => {
        // A server declaring no listChanged and no resources.subscribe honors
        // nothing, so the stream can never carry a notification: every
        // listenFilterAccepts({}, event) is false. It should end, not idle.
        const bareFactory = () => new McpServer({ name: 'listen-test-server', version: '1.0.0' }, { capabilities: {} });
        const handler = createMcpHandler(bareFactory, { keepAliveMs: 0 });
        const response = await handler.fetch(
            listenRequest(7, { toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['file:///a'] })
        );

        // Reading the body to its end only resolves when the server ends the stream itself.
        const body = await response.text();
        const messages = body
            .split('\n\n')
            .filter(frame => frame.length > 0)
            .map(frame => JSON.parse(frame.slice(frame.indexOf('data: ') + 'data: '.length)) as unknown);

        expect(messages).toEqual([
            {
                jsonrpc: '2.0',
                method: 'notifications/subscriptions/acknowledged',
                params: { notifications: {}, _meta: { [SUBSCRIPTION_ID_META_KEY]: 7 } }
            },
            {
                jsonrpc: '2.0',
                id: 7,
                result: {
                    resultType: 'complete',
                    _meta: {
                        [SUBSCRIPTION_ID_META_KEY]: 7,
                        'io.modelcontextprotocol/serverInfo': { name: 'listen-test-server', version: '1.0.0' }
                    }
                }
            }
        ]);
    });

    it('still holds the stream when at least one type is honored', async () => {
        // The narrowing must not close a stream that can still deliver: tools
        // is honored here, resources is not.
        const partialFactory = () =>
            new McpServer({ name: 'listen-test-server', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
        const handler = createMcpHandler(partialFactory, { keepAliveMs: 0 });
        const response = await handler.fetch(listenRequest(8, { toolsListChanged: true, resourcesListChanged: true }));

        const [ack] = await readMessages(response, 1);
        expect(ack).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: { notifications: { toolsListChanged: true }, _meta: { [SUBSCRIPTION_ID_META_KEY]: 8 } }
        });
        await handler.close();
    });

    it('legacy-classified listen never reaches the entry listen router (no ack delivered)', async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0 });
        // No envelope claim → classified legacy → dispatched through the
        // stateless fallback's Server, where `subscriptions/listen` is not in
        // the 2025 registry → −32601 in-band (the legacy transport may stream
        // it as a single SSE frame).
        const response = await handler.fetch(
            new Request('http://localhost/mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'subscriptions/listen',
                    params: { notifications: { toolsListChanged: true } }
                })
            })
        );
        const text = await response.text();
        expect(text).not.toContain('notifications/subscriptions/acknowledged');
        expect(text).toContain('-32601');
        await handler.close();
    });
});
