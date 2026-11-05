/**
 * `Protocol.use`: middleware composes around the registered handler at
 * dispatch time, may answer or throw itself, applies to handlers registered
 * later, runs in registration order, and can be removed.
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

describe('Protocol.use (request middleware)', () => {
    it('wraps the registered handler; next reaches it and the middleware may transform the result', async () => {
        const { protocol, call } = await harness();
        protocol.setRequestHandler('acme/op', { params: z.looseObject({}) }, () => ({ value: 1 }) as Result);
        protocol.use('acme/op', async (request, ctx, next) => {
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
        protocol.use('acme/op', (request, ctx, next) => {
            if ((request.params as { deny?: boolean }).deny) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'denied by middleware');
            }
            return next(request, ctx);
        });
        const denied = await call('acme/op', { deny: true });
        expect((denied as JSONRPCErrorResponse).error).toMatchObject({
            code: ProtocolErrorCode.InvalidParams,
            message: 'denied by middleware'
        });
        expect(handlerRan).toBe(false);
        await call('acme/op');
        expect(handlerRan).toBe(true);
    });

    it('applies to a handler registered after the middleware was installed', async () => {
        const { protocol, call } = await harness();
        const order: string[] = [];
        protocol.use('acme/late', async (request, ctx, next) => {
            order.push('middleware');
            return next(request, ctx);
        });
        protocol.setRequestHandler('acme/late', { params: z.looseObject({}) }, () => {
            order.push('handler');
            return {} as Result;
        });
        await call('acme/late');
        expect(order).toEqual(['middleware', 'handler']);
    });

    it('keeps one registration order across methods and stamps _meta through next', async () => {
        const { protocol, call } = await harness();
        const order: string[] = [];
        for (const method of ['acme/a', 'acme/b']) {
            protocol.setRequestHandler(method, { params: z.looseObject({}) }, () => {
                order.push(`handler:${method}`);
                return { method } as Result;
            });
        }
        protocol.use('acme/a', async (request, ctx, next) => {
            order.push('a-1');
            const result = await next(request, ctx);
            return { ...result, _meta: { 'acme/stamped': true } } as Result;
        });
        protocol.use('acme/b', async (request, ctx, next) => {
            order.push('b-1');
            return next(request, ctx);
        });
        protocol.use('acme/a', async (request, ctx, next) => {
            order.push('a-2');
            return next(request, ctx);
        });
        const a = await call('acme/a');
        expect((a as JSONRPCResultResponse).result).toEqual({ method: 'acme/a', _meta: { 'acme/stamped': true } });
        expect(order).toEqual(['a-1', 'a-2', 'handler:acme/a']);
        order.length = 0;
        await call('acme/b');
        expect(order).toEqual(['b-1', 'handler:acme/b']);
    });

    it('next throws MethodNotFound when nothing underlies the middleware', async () => {
        const { protocol, call } = await harness();
        protocol.use('acme/missing', (request, ctx, next) => next(request, ctx));
        const response = await call('acme/missing');
        expect((response as JSONRPCErrorResponse).error).toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
    });

    it('runs in registration order (first registered outermost), and removal restores the handler', async () => {
        const { protocol, call } = await harness();
        const order: string[] = [];
        protocol.setRequestHandler('acme/op', { params: z.looseObject({}) }, () => {
            order.push('handler');
            return {} as Result;
        });
        const removeFirst = protocol.use('acme/op', async (request, ctx, next) => {
            order.push('first');
            return next(request, ctx);
        });
        protocol.use('acme/op', async (request, ctx, next) => {
            order.push('second');
            return next(request, ctx);
        });
        await call('acme/op');
        expect(order).toEqual(['first', 'second', 'handler']);
        order.length = 0;
        removeFirst();
        await call('acme/op');
        expect(order).toEqual(['second', 'handler']);
    });
});
