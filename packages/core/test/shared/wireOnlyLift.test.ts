/**
 * Envelope lift, two-sided: wire-only material is hidden from handlers AND
 * reaches the protocol layer un-deleted.
 *
 * Hide set: the reserved `io.modelcontextprotocol/*` envelope `_meta` keys
 * and the multi-round-trip retry fields (`inputResponses`/`requestState`).
 * Under 2026-era traffic, handler params must be byte-equal to the 2025-era
 * shape of the same call; the envelope is readable via `ctx.mcpReq.envelope`
 * and the retry fields via `ctx.mcpReq.inputResponses`/`.requestState`.
 * 2025-era traffic passes through untouched (same reference — no cloning on
 * the hot path).
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import * as z from 'zod/v4';

import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';
import type { JSONRPCMessage, JSONRPCRequest, RequestMetaEnvelope, Result } from '../../src/types/index.js';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    LOG_LEVEL_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    RELATED_TASK_META_KEY
} from '../../src/types/index.js';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_INFO_META_KEY]: { name: 'modern-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} },
    [LOG_LEVEL_META_KEY]: 'info'
};

interface Wired {
    receiver: TestProtocol;
    peer: InMemoryTransport;
    responses: JSONRPCMessage[];
}

async function wireReceiver(setup: (receiver: TestProtocol) => void): Promise<Wired> {
    const [peer, receiverTx] = InMemoryTransport.createLinkedPair();
    const receiver = new TestProtocol();
    setup(receiver);
    await receiver.connect(receiverTx);
    const responses: JSONRPCMessage[] = [];
    peer.onmessage = message => void responses.push(message);
    await peer.start();
    return { receiver, peer, responses };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

describe('envelope lift on inbound requests', () => {
    test('handler params are byte-equal to the 2025 shape; envelope readable via ctx', async () => {
        let seenRequest: unknown;
        let seenCtx: BaseContext | undefined;
        const { peer } = await wireReceiver(receiver => {
            receiver.setRequestHandler('tools/call', (request, ctx) => {
                seenRequest = request;
                seenCtx = ctx;
                return { content: [] };
            });
        });

        // A modern request: envelope keys ride _meta next to 2025-legal
        // material (progressToken, related-task).
        await peer.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'echo',
                arguments: { text: 'hi' },
                _meta: { ...ENVELOPE, progressToken: 7, [RELATED_TASK_META_KEY]: { taskId: 't-1' } }
            }
        } as JSONRPCMessage);
        await flush();

        // Byte-equal to the 2025-era shape of the same call (the spec-method
        // handler receives the schema-parsed {method, params} form).
        expect(seenRequest).toEqual({
            method: 'tools/call',
            params: {
                name: 'echo',
                arguments: { text: 'hi' },
                _meta: { progressToken: 7, [RELATED_TASK_META_KEY]: { taskId: 't-1' } }
            }
        });
        // ctx._meta mirrors the lifted _meta…
        expect(seenCtx?.mcpReq._meta).toEqual({ progressToken: 7, [RELATED_TASK_META_KEY]: { taskId: 't-1' } });
        // …and the envelope is surfaced verbatim, un-deleted.
        expect(seenCtx?.mcpReq.envelope).toEqual(ENVELOPE);
    });

    test('a partial envelope (a subset of the reserved keys) surfaces as received and types as Partial', async () => {
        // A one-revision-old peer may legally send only some reserved keys
        // (e.g. just the log-level opt-in). The lift surfaces whatever was
        // present, and the ctx slot's type says so: every member is optional.
        let seenCtx: BaseContext | undefined;
        const { peer } = await wireReceiver(receiver => {
            receiver.setRequestHandler('tools/call', (_request, ctx) => {
                seenCtx = ctx;
                return { content: [] };
            });
        });

        await peer.send({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'echo', arguments: {}, _meta: { [LOG_LEVEL_META_KEY]: 'debug' } }
        } as JSONRPCMessage);
        await flush();

        expect(seenCtx?.mcpReq.envelope).toEqual({ [LOG_LEVEL_META_KEY]: 'debug' });
        // The slot is Partial<RequestMetaEnvelope>: a key the request did not
        // carry reads as possibly-undefined — there is no claim that the
        // required envelope members exist (requiredness is enforced per
        // request at dispatch time, not by the lift).
        expectTypeOf<NonNullable<BaseContext['mcpReq']['envelope']>>().toEqualTypeOf<Partial<RequestMetaEnvelope>>();
        expectTypeOf(seenCtx!.mcpReq.envelope![PROTOCOL_VERSION_META_KEY]).toEqualTypeOf<string | undefined>();
        expect(seenCtx?.mcpReq.envelope?.[PROTOCOL_VERSION_META_KEY]).toBeUndefined();
    });

    test('a _meta that holds only envelope keys disappears entirely (exact 2025 shape)', async () => {
        let seenRequest: unknown;
        const { peer } = await wireReceiver(receiver => {
            receiver.setRequestHandler('tools/call', request => {
                seenRequest = request;
                return { content: [] };
            });
        });

        await peer.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'echo', arguments: {}, _meta: { ...ENVELOPE } }
        } as JSONRPCMessage);
        await flush();

        expect(seenRequest).toEqual({
            method: 'tools/call',
            params: { name: 'echo', arguments: {} }
        });
    });

    test('retry fields are hidden from handler params and reach ctx un-deleted', async () => {
        let seenRequest: unknown;
        let seenCtx: BaseContext | undefined;
        const { peer } = await wireReceiver(receiver => {
            receiver.setRequestHandler('tools/call', (request, ctx) => {
                seenRequest = request;
                seenCtx = ctx;
                return { content: [] };
            });
        });

        const inputResponses = { 'req-1': { action: 'accept', content: { name: 'octocat' } } };
        await peer.send({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'echo', arguments: {}, inputResponses, requestState: 'opaque-state-token' }
        } as JSONRPCMessage);
        await flush();

        expect(seenRequest).toEqual({
            method: 'tools/call',
            params: { name: 'echo', arguments: {} }
        });
        expect(seenCtx?.mcpReq.inputResponses).toEqual(inputResponses);
        expect(seenCtx?.mcpReq.requestState).toBe('opaque-state-token');
    });

    test('the custom-method (3-arg) path also surfaces the envelope via ctx', async () => {
        let seenParams: unknown;
        let seenCtx: BaseContext | undefined;
        const { peer, responses } = await wireReceiver(receiver => {
            receiver.setRequestHandler('acme/search', { params: z.object({ query: z.string() }) }, (params, ctx) => {
                seenParams = params;
                seenCtx = ctx;
                return { hits: [] };
            });
        });

        await peer.send({
            jsonrpc: '2.0',
            id: 4,
            method: 'acme/search',
            params: { query: 'mcp', _meta: { ...ENVELOPE } }
        } as JSONRPCMessage);
        await flush();

        expect(seenParams).toEqual({ query: 'mcp' });
        expect(seenCtx?.mcpReq.envelope).toEqual(ENVELOPE);
        expect(responses).toHaveLength(1);
    });

    test('the fallback request handler receives the lifted request too', async () => {
        let seenRequest: JSONRPCRequest | undefined;
        const { peer } = await wireReceiver(receiver => {
            receiver.fallbackRequestHandler = request => {
                seenRequest = request;
                return Promise.resolve({} as Result);
            };
        });

        await peer.send({
            jsonrpc: '2.0',
            id: 5,
            method: 'vendor/anything',
            params: { value: 1, _meta: { ...ENVELOPE }, requestState: 's' }
        } as JSONRPCMessage);
        await flush();

        expect(seenRequest?.params).toEqual({ value: 1 });
    });

    test('2025-era requests pass through untouched (same reference, no ctx slots)', async () => {
        let seenRequest: JSONRPCRequest | undefined;
        let seenCtx: BaseContext | undefined;
        const { peer } = await wireReceiver(receiver => {
            receiver.fallbackRequestHandler = (request, ctx) => {
                seenRequest = request;
                seenCtx = ctx;
                return Promise.resolve({} as Result);
            };
        });

        const legacy = {
            jsonrpc: '2.0',
            id: 6,
            method: 'vendor/legacy',
            params: { value: 2, _meta: { progressToken: 9 } }
        } as JSONRPCMessage;
        await peer.send(legacy);
        await flush();

        // Identity preserved: the lift allocates nothing for clean traffic.
        expect(seenRequest).toBe(legacy);
        expect(seenCtx?.mcpReq.envelope).toBeUndefined();
        expect(seenCtx?.mcpReq.inputResponses).toBeUndefined();
        expect(seenCtx?.mcpReq.requestState).toBeUndefined();
    });
});

describe('envelope lift on inbound notifications', () => {
    test('notification handlers never see the reserved envelope keys', async () => {
        let seenParams: unknown;
        let seenNotification: unknown;
        const { peer } = await wireReceiver(receiver => {
            receiver.setNotificationHandler('vendor/changed', { params: z.object({ value: z.number() }) }, (params, notification) => {
                seenParams = params;
                seenNotification = notification;
            });
        });

        await peer.send({
            jsonrpc: '2.0',
            method: 'vendor/changed',
            params: { value: 42, _meta: { ...ENVELOPE, progressToken: 1 } }
        } as JSONRPCMessage);
        await flush();

        expect(seenParams).toEqual({ value: 42 });
        // The raw notification handed to the handler is the lifted one:
        // _meta retains only non-reserved material.
        expect((seenNotification as { params?: { _meta?: unknown } }).params?._meta).toEqual({ progressToken: 1 });
    });

    test('the fallback notification handler receives the lifted notification', async () => {
        let seen: unknown;
        const { peer } = await wireReceiver(receiver => {
            receiver.fallbackNotificationHandler = notification => {
                seen = notification;
                return Promise.resolve();
            };
        });

        await peer.send({
            jsonrpc: '2.0',
            method: 'vendor/ping',
            params: { _meta: { ...ENVELOPE } }
        } as JSONRPCMessage);
        await flush();

        expect((seen as { params?: unknown }).params).toEqual({});
    });
});
