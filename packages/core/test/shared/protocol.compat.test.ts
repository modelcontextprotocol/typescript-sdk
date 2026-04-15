import { describe, expect, test } from 'vitest';

import type { BaseContext, ClientContext, LegacyContextFields, RequestHandlerExtra, ServerContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import type { Transport } from '../../src/shared/transport.js';
import type { JSONRPCMessage } from '../../src/types/index.js';

class TestProtocolImpl extends Protocol<ClientContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected assertTaskCapability(): void {}
    protected assertTaskHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext & LegacyContextFields): ClientContext {
        return ctx;
    }
}

class MockTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;

    async start(): Promise<void> {}
    async close(): Promise<void> {
        this.onclose?.();
    }
    async send(_message: JSONRPCMessage): Promise<void> {}
}

describe('v1-compat: flat ctx.* fields', () => {
    test('flat fields mirror nested v2 fields', async () => {
        const protocol = new TestProtocolImpl();
        const transport = new MockTransport();
        await protocol.connect(transport);

        let captured: ClientContext | undefined;
        const done = new Promise<void>(resolve => {
            protocol.setRequestHandler('ping', (_request, ctx) => {
                captured = ctx;
                resolve();
                return {};
            });
        });

        transport.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
        await done;

        expect(captured).toBeDefined();
        const ctx = captured!;

        expect(ctx.signal).toBe(ctx.mcpReq.signal);
        expect(ctx.requestId).toBe(ctx.mcpReq.id);
        expect(ctx._meta).toBe(ctx.mcpReq._meta);
        expect(ctx.authInfo).toBe(ctx.http?.authInfo);
        expect(ctx.sendNotification).toBe(ctx.mcpReq.notify);
        expect(ctx.sendRequest).toBeTypeOf('function');
        expect(ctx.taskStore).toBe(ctx.task?.store);
        expect(ctx.taskId).toBe(ctx.task?.id);
        expect(ctx.taskRequestedTtl).toBe(ctx.task?.requestedTtl);
    });

    test('RequestHandlerExtra<R, N> is a ServerContext alias (type-level)', () => {
        const check = (ctx: ServerContext): RequestHandlerExtra<unknown, unknown> => ctx;
        void check;
    });
});
