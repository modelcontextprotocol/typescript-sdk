import { vi } from 'vitest';
import * as z from 'zod/v4';
import type { BaseContext } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';
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
async function fixture() {
    const protocol = new TestProtocol();
    const transport: Transport = {
        start: async () => {},
        close: async () => {},
        send: vi.fn(async () => {})
    };
    await protocol.connect(transport);
    const receive = (message: JSONRPCMessage, extra?: MessageExtraInfo) => transport.onmessage!(message, extra);
    return { protocol, transport, receive };
}
const request = { jsonrpc: '2.0' as const, id: 1, method: 'test/work', params: {} };

test('completion waits for handler, response send and controller cleanup', async () => {
    const { protocol, transport, receive } = await fixture();
    const handler = deferred();
    const write = deferred();
    const complete = vi.fn();
    protocol.setRequestHandler('test/work', { params: z.object({}), result: z.object({}) }, async () => {
        await handler.promise;
        return {};
    });
    transport.send = vi.fn(() => write.promise);
    receive(request, { onMessageProcessed: complete });
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    handler.resolve();
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledOnce());
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

test('notification completion waits for its asynchronous handler', async () => {
    const { protocol, receive } = await fixture();
    const handler = deferred();
    const complete = vi.fn();
    protocol.setNotificationHandler('test/notification', { params: z.object({}) }, () => handler.promise);
    receive({ jsonrpc: '2.0', method: 'test/notification', params: {} }, { onMessageProcessed: complete });
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    handler.resolve();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
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

test('inbound response completion joins asynchronous SDK result validation', async () => {
    const f = await fixture();
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
    held.resolve();
    expect(await result).toEqual({ value: 'accepted' });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
});
