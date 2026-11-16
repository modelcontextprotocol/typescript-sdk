import { afterEach, describe, expect, test, vi } from 'vitest';

import type { BaseContext } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';
import type { Transport, TransportSendOptions } from '../../src/shared/transport';
import type { JSONRPCMessage } from '../../src/types/index';
import {
    JSONRPCErrorResponseSchema,
    JSONRPCNotificationSchema,
    JSONRPCRequestSchema,
    JSONRPCResultResponseSchema
} from '../../src/types/index';

class TestProtocolImpl extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

class MockTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;

    async start(): Promise<void> {}
    async close(): Promise<void> {}
    async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}
}

describe('inbound message classification', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('a request is classified without running the response schemas', async () => {
        const transport = new MockTransport();
        const protocol = new TestProtocolImpl();
        await protocol.connect(transport);

        protocol.setRequestHandler('ping', async () => ({}));

        const resultSpy = vi.spyOn(JSONRPCResultResponseSchema, 'safeParse');
        const errorSpy = vi.spyOn(JSONRPCErrorResponseSchema, 'safeParse');
        const requestSpy = vi.spyOn(JSONRPCRequestSchema, 'safeParse');
        const notificationSpy = vi.spyOn(JSONRPCNotificationSchema, 'safeParse');

        transport.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });

        // The transport already parsed the message as a request. Re-running the
        // response schemas only adds full zod walks on every inbound message.
        expect(resultSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(notificationSpy).not.toHaveBeenCalled();
    });

    test('a notification is classified without running the request or response schemas', async () => {
        const transport = new MockTransport();
        const protocol = new TestProtocolImpl();
        await protocol.connect(transport);

        const resultSpy = vi.spyOn(JSONRPCResultResponseSchema, 'safeParse');
        const errorSpy = vi.spyOn(JSONRPCErrorResponseSchema, 'safeParse');
        const requestSpy = vi.spyOn(JSONRPCRequestSchema, 'safeParse');

        transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' });

        expect(resultSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(requestSpy).not.toHaveBeenCalled();
    });
});
