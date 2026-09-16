/**
 * `Protocol.overrideRequestHandler`: overrides compose around the registered
 * handler at dispatch time, may answer or throw themselves, apply to handlers
 * registered later, and can be removed.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import type { BaseContext } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';
import type { JSONRPCErrorResponse, JSONRPCMessage, JSONRPCResultResponse, Result } from '../../src/types/index';
import { ProtocolError, ProtocolErrorCode } from '../../src/types/index';
import { InMemoryTransport } from '../../src/util/inMemory';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 5));

async function harness() {
    const [peerTx, protocolTx] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    peerTx.onmessage = message => void sent.push(message);
    await peerTx.start();
    const protocol = new TestProtocol();
    await protocol.connect(protocolTx);
    let nextId = 0;
    const call = async (method: string, params: Record<string, unknown> = {}) => {
        const id = ++nextId;
        await peerTx.send({ jsonrpc: '2.0', id, method, params });
        await flush();
        const response = sent.find(message => 'id' in message && message.id === id);
        return response as JSONRPCResultResponse | JSONRPCErrorResponse;
    };
    return { protocol, call };
}

describe('Protocol.overrideRequestHandler', () => {
    it('wraps the registered handler; next reaches it and the override may transform the result', async () => {
        const { protocol, call } = await harness();
        protocol.setRequestHandler('acme/op', { params: z.looseObject({}) }, () => ({ value: 1 }) as Result);
        protocol.overrideRequestHandler('acme/op', async (request, ctx, next) => {
            const result = (await next(request, ctx)) as { value: number };
            return { value: result.value + 1, wrapped: true } as Result;
        });
        const response = await call('acme/op');
        expect((response as JSONRPCResultResponse).result).toEqual({ value: 2, wrapped: true });
    });

    it('may answer without calling next, and a thrown ProtocolError becomes the JSON-RPC error', async () => {
        const { protocol, call } = await harness();
        let handlerRan = false;
        protocol.setRequestHandler('acme/op', { params: z.looseObject({ deny: z.boolean().optional() }) }, () => {
            handlerRan = true;
            return {} as Result;
        });
        protocol.overrideRequestHandler('acme/op', (request, ctx, next) => {
            if ((request.params as { deny?: boolean }).deny) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'denied by override');
            }
            return next(request, ctx);
        });
        const denied = await call('acme/op', { deny: true });
        expect((denied as JSONRPCErrorResponse).error).toMatchObject({
            code: ProtocolErrorCode.InvalidParams,
            message: 'denied by override'
        });
        expect(handlerRan).toBe(false);
        await call('acme/op');
        expect(handlerRan).toBe(true);
    });

    it('applies to a handler registered after the override was installed', async () => {
        const { protocol, call } = await harness();
        const order: string[] = [];
        protocol.overrideRequestHandler('acme/late', async (request, ctx, next) => {
            order.push('override');
            return next(request, ctx);
        });
        protocol.setRequestHandler('acme/late', { params: z.looseObject({}) }, () => {
            order.push('handler');
            return {} as Result;
        });
        await call('acme/late');
        expect(order).toEqual(['override', 'handler']);
    });

    it('next throws MethodNotFound when nothing underlies the override', async () => {
        const { protocol, call } = await harness();
        protocol.overrideRequestHandler('acme/missing', (request, ctx, next) => next(request, ctx));
        const response = await call('acme/missing');
        expect((response as JSONRPCErrorResponse).error).toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
    });

    it('later overrides run outside earlier ones, and removal restores the handler', async () => {
        const { protocol, call } = await harness();
        const order: string[] = [];
        protocol.setRequestHandler('acme/op', { params: z.looseObject({}) }, () => {
            order.push('handler');
            return {} as Result;
        });
        const removeInner = protocol.overrideRequestHandler('acme/op', async (request, ctx, next) => {
            order.push('inner');
            return next(request, ctx);
        });
        protocol.overrideRequestHandler('acme/op', async (request, ctx, next) => {
            order.push('outer');
            return next(request, ctx);
        });
        await call('acme/op');
        expect(order).toEqual(['outer', 'inner', 'handler']);
        order.length = 0;
        removeInner();
        await call('acme/op');
        expect(order).toEqual(['outer', 'handler']);
    });
});
