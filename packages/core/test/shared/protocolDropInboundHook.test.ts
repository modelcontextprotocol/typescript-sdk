/**
 * The protocol-layer drop consult (`Protocol._shouldDropInbound`):
 *
 * - B-2 pin: when the transport supplied an edge classification, the hook is
 *   NEVER consulted — the edge classification always wins.
 * - The base implementation returns `undefined`, so unclassified traffic on
 *   a default instance keeps today's dispatch path byte-identically.
 * - Returning `'drop'` discards the message without writing any response
 *   (requests are surfaced via `onerror`, notifications are silent). This is
 *   the seam the client uses to decline inbound requests on connections that
 *   negotiated a modern era. Era selection never happens here — era is
 *   instance state owned by the serving entry.
 */
import { describe, expect, it } from 'vitest';

import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import type {
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse
} from '../../src/types/index.js';
import { isJSONRPCResultResponse } from '../../src/types/index.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';

class HookedProtocol extends Protocol<BaseContext> {
    /** Messages the hook was consulted for (in order). */
    consulted: Array<JSONRPCRequest | JSONRPCNotification> = [];
    /** What the hook answers; `undefined` keeps the base behavior. */
    verdict: ((message: JSONRPCRequest | JSONRPCNotification) => 'drop' | undefined) | undefined;

    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }

    protected override _shouldDropInbound(message: JSONRPCRequest | JSONRPCNotification): 'drop' | undefined {
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
        protocol.verdict = () => 'drop';
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
        // `undefined` keeps today's path: no handler ⇒ −32601.
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

    it('an undefined verdict from an overriding hook also keeps the handler path unchanged', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = () => undefined;
        protocol.setRequestHandler('tools/list', () => ({ tools: [] }));
        const { peerTx, sent } = await wire(protocol);

        await peerTx.send({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} });
        await flush();

        expect(sent).toHaveLength(1);
        expect(isJSONRPCResultResponse(sent[0] as JSONRPCMessage)).toBe(true);
        expect((sent[0] as JSONRPCResultResponse).result).toEqual({ tools: [] });
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

    it('responses are never consulted: an inbound response keeps todays correlation path', async () => {
        const protocol = new HookedProtocol();
        protocol.verdict = () => 'drop';
        const { peerTx, sent } = await wire(protocol);

        // An unsolicited response does not reach the hook (it is not a request
        // or notification); it surfaces through the response-correlation path.
        await peerTx.send({ jsonrpc: '2.0', id: 99, result: {} });
        await flush();

        expect(protocol.consulted).toHaveLength(0);
        expect(sent).toHaveLength(0);
        await protocol.close();
    });
});
