/**
 * The protocol-layer classification consult (`Protocol._classifyInbound`):
 *
 * - B-2 pin: when the transport supplied an edge classification, the hook is
 *   NEVER consulted — the edge classification always wins.
 * - The base implementation returns `undefined`, so unclassified traffic on
 *   a default instance keeps today's dispatch path byte-identically.
 * - A hook classification populates the `MessageExtraInfo.classification`
 *   carrier and, on an UNBOUND instance (no negotiated protocol version),
 *   selects the wire era for that one message (per-message era on long-lived
 *   dual-era channels). On a BOUND instance it is validated exactly like an
 *   edge classification (mismatch ⇒ −32004 for requests, drop for
 *   notifications).
 * - Returning `'drop'` discards the message without writing any response.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol, setNegotiatedProtocolVersion } from '../../src/shared/protocol.js';
import type {
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    MessageClassification,
    MessageExtraInfo,
    Result
} from '../../src/types/index.js';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
    PROTOCOL_VERSION_META_KEY
} from '../../src/types/index.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';

const MODERN = '2026-07-28';

const modernEnvelope = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'hook-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

class HookedProtocol extends Protocol<BaseContext> {
    /** Messages the hook was consulted for (in order). */
    consulted: Array<JSONRPCRequest | JSONRPCNotification> = [];
    /** What the hook answers; `undefined` keeps the base behavior. */
    verdict: ((message: JSONRPCRequest | JSONRPCNotification) => MessageClassification | 'drop' | undefined) | undefined;
    /** The MessageExtraInfo handed to buildContext for the last dispatched request. */
    lastExtra: MessageExtraInfo | undefined;

    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): BaseContext {
        this.lastExtra = transportInfo;
        return ctx;
    }

    protected override _classifyInbound(message: JSONRPCRequest | JSONRPCNotification): MessageClassification | 'drop' | undefined {
        this.consulted.push(message);
        return this.verdict?.(message);
    }
}

class BaseProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 10));

async function wire<T extends Protocol<BaseContext>>(protocol: T) {
    const [peerTx, protocolTx] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    peerTx.onmessage = message => void sent.push(message);
    await peerTx.start();
    const errors: Error[] = [];
    protocol.onerror = error => void errors.push(error);
    await protocol.connect(protocolTx);
    return { peerTx, protocolTx, sent, errors };
}

describe('B-2: an edge classification always wins', () => {
    it('never consults the hook for a message that already carries a classification', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = () => ({ era: 'modern', revision: MODERN });
        const { protocolTx, sent } = await wire(protocol);

        protocolTx.onmessage?.(
            { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage,
            // The in-memory transport's onmessage declares the narrower
            // pre-classification extra type; the protocol layer reads the
            // full MessageExtraInfo (same cast as the era-gate suite).
            { classification: { era: 'legacy' } } as never
        );
        await flush();

        expect(protocol.consulted).toHaveLength(0);
        // The edge classification (legacy) matches the unbound instance era,
        // so the request proceeds to today's path: no handler ⇒ −32601.
        expect(sent).toHaveLength(1);
        expect((sent[0] as JSONRPCErrorResponse).error.code).toBe(-32_601);
        await protocol.close();
    });

    it('consults the hook when the transport did not classify', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = () => undefined;
        const { peerTx, sent } = await wire(protocol);

        await peerTx.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
        await flush();

        expect(protocol.consulted).toHaveLength(1);
        expect(protocol.consulted[0]).toMatchObject({ method: 'tools/list' });
        // `undefined` keeps today's path: no handler ⇒ −32601, no classification carrier.
        expect(sent).toHaveLength(1);
        expect((sent[0] as JSONRPCErrorResponse).error.code).toBe(-32_601);
        await protocol.close();
    });
});

describe("base implementation (no override) keeps today's dispatch", () => {
    it('serves unclassified legacy traffic identically: handler runs, result is not stamped with 2026 wire fields', async () => {
        const protocol = new BaseProtocol();
        protocol.setRequestHandler('tools/list', () => ({ tools: [] }));
        const { peerTx, sent } = await wire(protocol);

        await peerTx.send({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
        await flush();

        expect(sent).toHaveLength(1);
        const response = sent[0] as JSONRPCResultResponse;
        expect(isJSONRPCResultResponse(response)).toBe(true);
        expect(response.result).toEqual({ tools: [] });
        expect(JSON.stringify(response)).not.toContain('resultType');
        await protocol.close();
    });
});

describe('per-message era on an unbound instance (long-lived dual-era channels)', () => {
    it('a hook classification of modern serves the message on the 2026 era: envelope honored, result stamped', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = message => (message.method === 'initialize' ? { era: 'legacy' } : { era: 'modern', revision: MODERN });
        protocol.setRequestHandler('tools/list', () => ({ tools: [] }));
        const { peerTx, sent } = await wire(protocol);

        await peerTx.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernEnvelope } });
        await flush();

        expect(sent).toHaveLength(1);
        const response = sent[0] as JSONRPCResultResponse;
        expect(isJSONRPCResultResponse(response)).toBe(true);
        expect((response.result as { resultType?: string }).resultType).toBe('complete');
        // The carrier was populated and reached the handler context.
        expect(protocol.lastExtra?.classification).toEqual({ era: 'modern', revision: MODERN });
        await protocol.close();
    });

    it('a hook classification of legacy answers a 2026-only spec method with a plain −32601 (era gate by registry absence)', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = () => ({ era: 'legacy' });
        // Even an installed handler cannot shadow the era gate.
        protocol.setRequestHandler('server/discover', { params: z.looseObject({}) }, () => ({}) as Result);
        const { peerTx, sent } = await wire(protocol);

        await peerTx.send({ jsonrpc: '2.0', id: 3, method: 'server/discover', params: {} });
        await flush();

        expect(sent).toHaveLength(1);
        const response = sent[0] as JSONRPCErrorResponse;
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        expect(response.error).toEqual({ code: -32_601, message: 'Method not found' });
        await protocol.close();
    });
});

describe('hook classification on a BOUND instance is validated like an edge classification', () => {
    it('a legacy-classified request on a modern-bound instance answers −32004 with the supported list', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = () => ({ era: 'legacy' });
        const { peerTx, sent } = await wire(protocol);
        setNegotiatedProtocolVersion(protocol, MODERN);

        await peerTx.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
        await flush();

        expect(sent).toHaveLength(1);
        const error = (sent[0] as JSONRPCErrorResponse).error as { code: number; data?: { supported?: string[] } };
        expect(error.code).toBe(-32_004);
        expect(Array.isArray(error.data?.supported)).toBe(true);
        await protocol.close();
    });

    it('a legacy-classified notification on a modern-bound instance is dropped (no handler invocation, no response)', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = () => ({ era: 'legacy' });
        let invoked = 0;
        protocol.fallbackNotificationHandler = async () => {
            invoked += 1;
        };
        const { peerTx, sent, errors } = await wire(protocol);
        setNegotiatedProtocolVersion(protocol, MODERN);

        await peerTx.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await flush();

        expect(invoked).toBe(0);
        expect(sent).toHaveLength(0);
        expect(errors.length).toBeGreaterThan(0);
        await protocol.close();
    });
});

describe("'drop' verdict", () => {
    it('discards an inbound request without writing any response and surfaces it via onerror', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = () => 'drop';
        protocol.setRequestHandler('tools/list', () => ({ tools: [] }));
        const { peerTx, sent, errors } = await wire(protocol);

        await peerTx.send({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
        await flush();

        expect(sent).toHaveLength(0);
        expect(errors.some(error => error.message.includes('Dropped inbound request'))).toBe(true);
        await protocol.close();
    });

    it('discards an inbound notification without dispatching it', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = () => 'drop';
        let invoked = 0;
        protocol.fallbackNotificationHandler = async () => {
            invoked += 1;
        };
        const { peerTx, sent } = await wire(protocol);

        await peerTx.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await flush();

        expect(invoked).toBe(0);
        expect(sent).toHaveLength(0);
        await protocol.close();
    });
});
