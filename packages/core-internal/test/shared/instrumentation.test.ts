import { AsyncLocalStorage } from 'node:async_hooks';

import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import type {
    BaseContext,
    InboundOperation,
    JSONRPCMessage,
    OperationOutcome,
    OutboundOperation,
    ProtocolInstrumentation
} from '../../src/exports/public/index';
import { isJSONRPCRequest, ProtocolError, ProtocolErrorCode, TRACEPARENT_META_KEY } from '../../src/exports/public/index';
import type { ProtocolOptions } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';
import { InMemoryTransport } from '../../src/util/inMemory';

class TestProtocol extends Protocol<BaseContext> {
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
}

type Sent = { direction: 'send'; operation: OutboundOperation; outcomes: OperationOutcome[] };
type Received = { direction: 'receive'; operation: InboundOperation; outcomes: OperationOutcome[] };
type Recorded = Sent | Received;

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const INJECTED = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

/** Records every scope, injects `INJECTED`, and runs work inside `als` so tests can see the active scope. */
function recorder(als = new AsyncLocalStorage<string>()) {
    const scopes: Recorded[] = [];
    const instrumentation: ProtocolInstrumentation = {
        send(operation) {
            const entry: Sent = { direction: 'send', operation, outcomes: [] };
            scopes.push(entry);
            operation.carrier[TRACEPARENT_META_KEY] = INJECTED;
            return { run: fn => als.run(`send ${operation.method}`, fn), end: outcome => entry.outcomes.push(outcome) };
        },
        receive(operation) {
            const entry: Received = { direction: 'receive', operation, outcomes: [] };
            scopes.push(entry);
            return { run: fn => als.run(`receive ${operation.method}`, fn), end: outcome => entry.outcomes.push(outcome) };
        }
    };
    function find(direction: 'send', method: string): Sent | undefined;
    function find(direction: 'receive', method: string): Received | undefined;
    function find(direction: Recorded['direction'], method: string): Recorded | undefined {
        return scopes.find(s => s.direction === direction && s.operation.method === method);
    }
    return { scopes, instrumentation, als, find };
}

async function pair(options?: { a?: ProtocolOptions; b?: ProtocolOptions }) {
    const [ta, tb] = InMemoryTransport.createLinkedPair();
    const a = new TestProtocol(options?.a);
    const b = new TestProtocol(options?.b);
    await a.connect(ta);
    await b.connect(tb);
    return { a, b, ta, tb };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const Ok = z.object({ ok: z.boolean() });

describe('ProtocolOptions.instrumentation', () => {
    it('leaves outbound messages untouched when no instrumentation is configured', async () => {
        const [ta, tb] = InMemoryTransport.createLinkedPair();
        const sent: JSONRPCMessage[] = [];
        tb.onmessage = message => {
            sent.push(message);
            if (isJSONRPCRequest(message)) void tb.send({ jsonrpc: '2.0', id: message.id, result: { ok: true } });
        };
        await tb.start();
        const a = new TestProtocol();
        await a.connect(ta);

        await a.request({ method: 'acme/echo', params: { v: 1 } }, Ok);
        await a.notification({ method: 'acme/event', params: { v: 2 } });

        expect(sent).toEqual([
            { jsonrpc: '2.0', id: 0, method: 'acme/echo', params: { v: 1 } },
            { jsonrpc: '2.0', method: 'acme/event', params: { v: 2 } }
        ]);
    });

    it('observes a request on both sides and carries the injected trace context to the peer', async () => {
        const client = recorder();
        const server = recorder(client.als);
        const { a, b } = await pair({ a: { instrumentation: client.instrumentation }, b: { instrumentation: server.instrumentation } });
        let activeInHandler: string | undefined;
        let metaInHandler: unknown;
        b.setRequestHandler('acme/echo', { params: z.object({ v: z.number() }) }, async (_params, ctx) => {
            await tick();
            activeInHandler = server.als.getStore();
            metaInHandler = ctx.mcpReq._meta;
            return { ok: true };
        });

        await a.request({ method: 'acme/echo', params: { v: 1 } }, Ok);

        const sent = client.find('send', 'acme/echo')!;
        expect(sent.operation).toMatchObject({ method: 'acme/echo', id: 0, params: { v: 1 } });
        expect(sent.outcomes).toEqual([{ type: 'result', result: { ok: true } }]);

        const received = server.find('receive', 'acme/echo')!;
        expect(received.operation).toMatchObject({ method: 'acme/echo', id: 0, handled: true, meta: { traceparent: INJECTED } });
        expect(received.outcomes).toEqual([{ type: 'result', result: { ok: true } }]);
        expect(metaInHandler).toEqual({ traceparent: INJECTED });
        expect(activeInHandler).toBe('receive acme/echo');
    });

    it('prefills the carrier with caller-supplied trace context without mutating the caller params', async () => {
        const client = recorder();
        const { a, b } = await pair({ a: { instrumentation: client.instrumentation } });
        let metaInHandler: unknown;
        b.setRequestHandler('acme/echo', { params: z.object({}) }, (_params, ctx) => {
            metaInHandler = ctx.mcpReq._meta;
            return { ok: true };
        });
        const params = { _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT, other: 'kept' } };
        let prefilled: Record<string, string> | undefined;
        const original = client.instrumentation.send!;
        client.instrumentation.send = operation => {
            prefilled = { ...operation.carrier };
            return original(operation);
        };

        await a.request({ method: 'acme/echo', params }, Ok);

        expect(prefilled).toEqual({ traceparent: TRACEPARENT });
        expect(metaInHandler).toEqual({ traceparent: INJECTED, other: 'kept' });
        expect(params._meta.traceparent).toBe(TRACEPARENT);
    });

    it('runs the transport send in the outbound scope', async () => {
        const client = recorder();
        const { a, b, ta } = await pair({ a: { instrumentation: client.instrumentation } });
        b.setRequestHandler('acme/echo', { params: z.object({}) }, () => ({ ok: true }));
        const activeAtSend: (string | undefined)[] = [];
        const send = ta.send.bind(ta);
        ta.send = (message, options) => {
            activeAtSend.push(client.als.getStore());
            return send(message, options);
        };

        await a.request({ method: 'acme/echo', params: {} }, Ok);
        await a.notification({ method: 'acme/event' });

        expect(activeAtSend).toEqual(['send acme/echo', 'send acme/event']);
    });

    it('ends both sides with the JSON-RPC error a handler throws', async () => {
        const client = recorder();
        const server = recorder();
        const { a, b } = await pair({ a: { instrumentation: client.instrumentation }, b: { instrumentation: server.instrumentation } });
        const thrown = new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad input');
        b.setRequestHandler('acme/fail', { params: z.object({}) }, () => {
            throw thrown;
        });

        await expect(a.request({ method: 'acme/fail', params: {} }, Ok)).rejects.toThrow('bad input');

        expect(server.find('receive', 'acme/fail')!.outcomes).toEqual([
            { type: 'error', error: { code: ProtocolErrorCode.InvalidParams, message: 'bad input' }, cause: thrown }
        ]);
        expect(client.find('send', 'acme/fail')!.outcomes).toMatchObject([
            { type: 'error', error: { code: ProtocolErrorCode.InvalidParams, message: 'bad input' } }
        ]);
    });

    it('reports an unhandled method with handled: false and a method-not-found error', async () => {
        const server = recorder();
        const { a } = await pair({ b: { instrumentation: server.instrumentation } });

        await expect(a.request({ method: 'acme/missing', params: {} }, Ok)).rejects.toThrow();

        const received = server.find('receive', 'acme/missing')!;
        expect(received.operation.handled).toBe(false);
        expect(received.outcomes).toEqual([
            { type: 'error', error: { code: ProtocolErrorCode.MethodNotFound, message: 'Method not found' } }
        ]);
    });

    it('ends a timed-out request with timeout and observes the cancellation notification', async () => {
        const client = recorder();
        const server = recorder();
        const { a, b } = await pair({ a: { instrumentation: client.instrumentation }, b: { instrumentation: server.instrumentation } });
        b.setRequestHandler(
            'acme/slow',
            { params: z.object({}) },
            (_params, ctx) =>
                new Promise<{ ok: boolean }>(resolve => ctx.mcpReq.signal.addEventListener('abort', () => resolve({ ok: true })))
        );

        await expect(a.request({ method: 'acme/slow', params: {} }, Ok, { timeout: 10 })).rejects.toThrow();
        await tick();

        expect(client.find('send', 'acme/slow')!.outcomes).toEqual([{ type: 'timeout' }]);
        expect(client.find('send', 'notifications/cancelled')!.outcomes).toEqual([{ type: 'delivered' }]);
        expect(server.find('receive', 'acme/slow')!.outcomes).toEqual([{ type: 'cancelled' }]);
    });

    it('ends a request aborted by the caller with cancelled', async () => {
        const client = recorder();
        const { a, b } = await pair({ a: { instrumentation: client.instrumentation } });
        b.setRequestHandler('acme/slow', { params: z.object({}) }, () => new Promise<never>(() => {}));
        const controller = new AbortController();

        const pending = a.request({ method: 'acme/slow', params: {} }, Ok, { signal: controller.signal });
        controller.abort('changed my mind');
        await expect(pending).rejects.toThrow();

        expect(client.find('send', 'acme/slow')!.outcomes).toEqual([{ type: 'cancelled' }]);
    });

    it('ends in-flight operations on both sides with closed when the connection drops', async () => {
        const client = recorder();
        const server = recorder();
        const { a, b } = await pair({ a: { instrumentation: client.instrumentation }, b: { instrumentation: server.instrumentation } });
        let started!: () => void;
        const handlerStarted = new Promise<void>(resolve => (started = resolve));
        b.setRequestHandler('acme/slow', { params: z.object({}) }, () => {
            started();
            return new Promise<never>(() => {});
        });

        const pending = a.request({ method: 'acme/slow', params: {} }, Ok);
        await handlerStarted;
        await a.close();
        await expect(pending).rejects.toThrow('Connection closed');

        expect(client.find('send', 'acme/slow')!.outcomes).toEqual([{ type: 'closed' }]);
        expect(server.find('receive', 'acme/slow')!.outcomes).toEqual([{ type: 'closed' }]);
    });

    it('ends a result that fails validation with failed', async () => {
        const client = recorder();
        const { a, b } = await pair({ a: { instrumentation: client.instrumentation } });
        b.setRequestHandler('acme/echo', { params: z.object({}) }, () => ({ ok: 'not a boolean' }));

        await expect(a.request({ method: 'acme/echo', params: {} }, Ok)).rejects.toThrow('Invalid result');

        expect(client.find('send', 'acme/echo')!.outcomes).toMatchObject([{ type: 'failed' }]);
    });

    it('ends a failed send with failed', async () => {
        const client = recorder();
        const { a, ta } = await pair({ a: { instrumentation: client.instrumentation } });
        const failure = new Error('socket gone');
        ta.send = () => Promise.reject(failure);

        await expect(a.request({ method: 'acme/echo', params: {} }, Ok)).rejects.toBe(failure);
        await expect(a.notification({ method: 'acme/event' })).rejects.toBe(failure);

        expect(client.find('send', 'acme/echo')!.outcomes).toEqual([{ type: 'failed', error: failure }]);
        expect(client.find('send', 'acme/event')!.outcomes).toEqual([{ type: 'failed', error: failure }]);
    });

    it('observes notifications on both sides, including a handler that throws', async () => {
        const client = recorder();
        const server = recorder();
        const { a, b } = await pair({ a: { instrumentation: client.instrumentation }, b: { instrumentation: server.instrumentation } });
        const errors: Error[] = [];
        b.onerror = error => errors.push(error);
        let activeInHandler: string | undefined;
        b.setNotificationHandler('acme/event', { params: z.object({}) }, () => {
            activeInHandler = server.als.getStore();
        });
        const thrown = new Error('handler broke');
        b.setNotificationHandler('acme/broken', { params: z.object({}) }, () => {
            throw thrown;
        });

        await a.notification({ method: 'acme/event', params: {} });
        await a.notification({ method: 'acme/broken', params: {} });
        await tick();

        expect(client.find('send', 'acme/event')!.outcomes).toEqual([{ type: 'delivered' }]);
        const received = server.find('receive', 'acme/event')!;
        expect(received.operation).toMatchObject({ method: 'acme/event', handled: true, meta: { traceparent: INJECTED } });
        expect(received.operation.id).toBeUndefined();
        expect(received.outcomes).toEqual([{ type: 'delivered' }]);
        expect(activeInHandler).toBe('receive acme/event');
        expect(server.find('receive', 'acme/broken')!.outcomes).toEqual([{ type: 'failed', error: thrown }]);
        expect(errors.map(e => e.message)).toEqual(['Uncaught error in notification handler: Error: handler broke']);
    });

    it('never lets a throwing instrumentation change the outcome', async () => {
        const errors: Error[] = [];
        const { a, b } = await pair({
            a: {
                instrumentation: {
                    send: () => {
                        throw new Error('send hook broke');
                    }
                }
            },
            b: {
                instrumentation: {
                    receive: () => ({
                        run: () => {
                            throw new Error('run broke');
                        },
                        end: () => {
                            throw new Error('end broke');
                        }
                    })
                }
            }
        });
        a.onerror = error => errors.push(error);
        b.onerror = error => errors.push(error);
        let calls = 0;
        b.setRequestHandler('acme/echo', { params: z.object({}) }, () => {
            calls++;
            return { ok: true };
        });

        await expect(a.request({ method: 'acme/echo', params: {} }, Ok)).resolves.toEqual({ ok: true });

        expect(calls).toBe(1);
        expect(errors.map(e => e.message)).toEqual([
            'Instrumentation failed: send hook broke',
            'Instrumentation failed: run broke',
            'Instrumentation failed: end broke'
        ]);
    });

    it('runs the work itself when scope.run never calls it', async () => {
        const errors: Error[] = [];
        const { a, b } = await pair({ b: { instrumentation: { receive: () => ({ run: () => undefined as never, end: () => {} }) } } });
        b.onerror = error => errors.push(error);
        let calls = 0;
        b.setRequestHandler('acme/echo', { params: z.object({}) }, () => {
            calls++;
            return { ok: true };
        });

        await expect(a.request({ method: 'acme/echo', params: {} }, Ok)).resolves.toEqual({ ok: true });

        expect(calls).toBe(1);
        expect(errors.map(e => e.message)).toEqual(['Instrumentation failed: scope.run() did not call fn']);
    });
});
