import { AsyncLocalStorage } from 'node:async_hooks';

import { vi } from 'vitest';
import * as z from 'zod/v4';
import type { BaseContext } from '../../src/shared/protocol';
import type { OperationScope } from '../../src/shared/instrumentation';
import { Protocol, setProtocolInstrumentation } from '../../src/shared/protocol';
import type { Transport } from '../../src/shared/transport';
import type { JSONRPCMessage, MessageExtraInfo } from '../../src/types/index';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => {
        resolve = r;
    });
    return { promise, resolve };
}
async function fixture(instrumented = false) {
    const protocol = new TestProtocol();
    const trace = new AsyncLocalStorage<boolean>();
    const spanEnd = vi.fn();
    if (instrumented) {
        const scope: OperationScope = { run: fn => trace.run(true, fn), end: spanEnd };
        setProtocolInstrumentation(protocol, { receive: () => scope, send: () => scope });
    }
    const transport: Transport = {
        start: async () => {},
        close: async () => transport.onclose?.(),
        send: vi.fn(async () => {})
    };
    await protocol.connect(transport);
    const receive = (message: JSONRPCMessage, extra?: MessageExtraInfo) => transport.onmessage!(message, extra);
    return { protocol, transport, receive, trace, spanEnd };
}
const request = { jsonrpc: '2.0' as const, id: 1, method: 'test/work', params: {} };

test.each([false, true])('completion waits for handler, response send and controller cleanup (instrumented: %s)', async instrumented => {
    const { protocol, transport, receive, trace, spanEnd } = await fixture(instrumented);
    const handler = deferred();
    const write = deferred();
    const complete = vi.fn();
    protocol.setRequestHandler('test/work', { params: z.object({}), result: z.object({}) }, async () => {
        await handler.promise;
        expect(trace.getStore()).toBe(instrumented ? true : undefined);
        return {};
    });
    transport.send = vi.fn(() => write.promise);
    receive(request, { onMessageProcessed: complete });
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    handler.resolve();
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledOnce());
    if (instrumented) expect(spanEnd).toHaveBeenCalledExactlyOnceWith({ type: 'result', result: {} });
    expect(complete).not.toHaveBeenCalled();
    write.resolve();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
});

test('cancellation and close do not settle an unfinished handler', async () => {
    const { protocol, transport, receive } = await fixture();
    const handler = deferred();
    const complete = vi.fn();
    protocol.setRequestHandler('test/work', { params: z.object({}), result: z.object({}) }, async () => {
        await handler.promise;
        return {};
    });
    receive(request, { onMessageProcessed: complete });
    await Promise.resolve();
    await Promise.resolve();
    receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    await protocol.close();
    expect(complete).not.toHaveBeenCalled();
    handler.resolve();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(transport.send).not.toHaveBeenCalled();
});

test.each(['unknown', 'handler-error', 'write-error'])('completion covers %s failure', async kind => {
    const { protocol, transport, receive } = await fixture();
    const complete = vi.fn();
    if (kind !== 'unknown')
        protocol.setRequestHandler('test/work', { params: z.object({}), result: z.object({}) }, () => {
            if (kind === 'handler-error') throw new Error('failure');
            return {};
        });
    if (kind === 'write-error') {
        protocol.onerror = () => {};
        transport.send = vi.fn(async () => {
            throw new Error('closed');
        });
    }
    receive(request, { onMessageProcessed: complete });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
});

test.each([false, true])('notification completion waits for its asynchronous handler (instrumented: %s)', async instrumented => {
    const { protocol, receive, spanEnd } = await fixture(instrumented);
    const handler = deferred();
    const complete = vi.fn();
    protocol.setNotificationHandler('test/notification', { params: z.object({}) }, () => handler.promise);
    receive({ jsonrpc: '2.0', method: 'test/notification', params: {} }, { onMessageProcessed: complete });
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    expect(spanEnd).not.toHaveBeenCalled();
    handler.resolve();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    if (instrumented) expect(spanEnd).toHaveBeenCalledExactlyOnceWith({ type: 'delivered' });
});

test('callback failures are reported once after processing', async () => {
    const { protocol, receive } = await fixture();
    const error = new Error('observer');
    const report = vi.fn();
    protocol.onerror = report;
    receive(request, {
        onMessageProcessed: () => {
            throw error;
        }
    });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(error));
    expect(report).toHaveBeenCalledOnce();
});

test.each([false, true])('inbound response completion joins asynchronous SDK result validation (instrumented: %s)', async instrumented => {
    const f = await fixture(instrumented);
    const held = deferred();
    const entered = deferred();
    const complete = vi.fn();
    const schema = z.object({ value: z.string() }).superRefine(async () => {
        entered.resolve();
        await held.promise;
    });
    const result = f.protocol.request({ method: 'test/work' }, schema);
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce());
    const outbound = vi.mocked(f.transport.send).mock.calls[0]![0];
    if (!('id' in outbound) || outbound.id === undefined) throw new Error('expected outbound request');
    f.receive({ jsonrpc: '2.0', id: outbound.id, result: { value: 'accepted' } }, { onMessageProcessed: complete });
    await entered.promise;
    expect(complete).not.toHaveBeenCalled();
    expect(f.spanEnd).not.toHaveBeenCalled();
    held.resolve();
    expect(await result).toEqual({ value: 'accepted' });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    if (instrumented) expect(f.spanEnd).toHaveBeenCalledExactlyOnceWith({ type: 'result', result: { value: 'accepted' } });
});

test.each(['cancelled', 'closed'] as const)('an instrumented %s request stays admitted until its handler settles', async outcome => {
    const { protocol, transport, receive, spanEnd } = await fixture(true);
    const entered = deferred();
    const handler = deferred();
    const complete = vi.fn();
    protocol.setRequestHandler('test/work', { params: z.object({}), result: z.object({}) }, async () => {
        entered.resolve();
        await handler.promise;
        return {};
    });
    receive(request, { onMessageProcessed: complete });
    await entered.promise;
    if (outcome === 'cancelled') {
        receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: request.id } });
    } else {
        await protocol.close();
    }
    await vi.waitFor(() => expect(spanEnd).toHaveBeenCalledWith({ type: outcome }));
    expect(complete).not.toHaveBeenCalled();
    handler.resolve();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(transport.send).not.toHaveBeenCalled();
});

test('completion can immediately reuse a request ID without retaining the previous controller', async () => {
    const { protocol, transport, receive } = await fixture(true);
    const entered = deferred();
    const handler = deferred();
    const signals: AbortSignal[] = [];
    const secondComplete = vi.fn();
    protocol.setRequestHandler('test/work', { params: z.object({}), result: z.object({}) }, async (_params, ctx) => {
        signals.push(ctx.mcpReq.signal);
        if (signals.length === 2) {
            entered.resolve();
            await handler.promise;
        }
        return {};
    });
    const firstComplete = vi.fn(() => receive(request, { onMessageProcessed: secondComplete }));
    receive(request, { onMessageProcessed: firstComplete });
    await entered.promise;
    expect(firstComplete).toHaveBeenCalledOnce();
    expect(secondComplete).not.toHaveBeenCalled();
    expect(signals).toHaveLength(2);
    await protocol.close();
    expect(signals[0]!.aborted).toBe(false);
    expect(signals[1]!.aborted).toBe(true);
    expect(secondComplete).not.toHaveBeenCalled();
    handler.resolve();
    await vi.waitFor(() => expect(secondComplete).toHaveBeenCalledOnce());
    expect(firstComplete).toHaveBeenCalledOnce();
    expect(transport.send).toHaveBeenCalledOnce();
});
