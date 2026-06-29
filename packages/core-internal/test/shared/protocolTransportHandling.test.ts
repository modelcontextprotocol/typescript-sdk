import { beforeEach, describe, expect, test } from 'vitest';

import type { BaseContext } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';
import type { Transport } from '../../src/shared/transport';
import type { EmptyResult, JSONRPCMessage } from '../../src/types/index';

// Mock Transport class
class MockTransport implements Transport {
    id: string;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;
    sentMessages: JSONRPCMessage[] = [];

    constructor(id: string) {
        this.id = id;
    }

    async start(): Promise<void> {}

    async close(): Promise<void> {
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.sentMessages.push(message);
    }
}

function createProtocol(): Protocol<BaseContext> {
    return new (class extends Protocol<BaseContext> {
        protected assertCapabilityForMethod(): void {}
        protected assertNotificationCapability(): void {}
        protected assertRequestHandlerCapability(): void {}
        protected buildContext(ctx: BaseContext): BaseContext {
            return ctx;
        }
    })();
}

describe('Protocol transport handling', () => {
    let transportA: MockTransport;
    let transportB: MockTransport;

    beforeEach(() => {
        transportA = new MockTransport('A');
        transportB = new MockTransport('B');
    });

    test('should send response to the correct transport when using separate protocol instances', async () => {
        const protocolA = createProtocol();
        const protocolB = createProtocol();

        // Each protocol gets its own resolver so we can verify responses route correctly
        let resolveA: (value: EmptyResult) => void;
        let resolveB: (value: EmptyResult) => void;
        let handlerAEnteredResolve: () => void;
        let handlerBEnteredResolve: () => void;
        const handlerAEntered = new Promise<void>(resolve => {
            handlerAEnteredResolve = resolve;
        });
        const handlerBEntered = new Promise<void>(resolve => {
            handlerBEnteredResolve = resolve;
        });

        protocolA.setRequestHandler('ping', async () => {
            return new Promise<EmptyResult>(resolve => {
                resolveA = resolve;
                handlerAEnteredResolve();
            });
        });

        protocolB.setRequestHandler('ping', async () => {
            return new Promise<EmptyResult>(resolve => {
                resolveB = resolve;
                handlerBEnteredResolve();
            });
        });

        // Client A connects and sends a request
        await protocolA.connect(transportA);
        transportA.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });

        // Client B connects to a separate protocol instance
        await protocolB.connect(transportB);
        transportB.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 2 });

        // Wait for both handlers to be invoked so resolvers are captured
        await handlerAEntered;
        await handlerBEntered;

        // Resolve each handler
        resolveA!({});
        resolveB!({});

        // Wait for response delivery (transport.send is async)
        await new Promise(resolve => setTimeout(resolve, 10));

        // Each transport receives its own response
        expect(transportA.sentMessages).toHaveLength(1);
        expect(transportA.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });

        expect(transportB.sentMessages).toHaveLength(1);
        expect(transportB.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 2, result: {} });
    });

    test('demonstrates isolation with separate protocol instances for rapid connections', async () => {
        const protocolA = createProtocol();
        const protocolB = createProtocol();

        // Set up handler with variable delay based on request id on each protocol
        for (const protocol of [protocolA, protocolB]) {
            protocol.setRequestHandler('ping', async (_request, ctx) => {
                const delay = ctx.mcpReq.id === 1 ? 50 : 10;
                await new Promise(resolve => setTimeout(resolve, delay));
                return {};
            });
        }

        // Connect and send requests
        await protocolA.connect(transportA);
        transportA.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });

        // Connect B while A is processing
        setTimeout(async () => {
            await protocolB.connect(transportB);
            transportB.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 2 });
        }, 10);

        // Wait for all processing
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(transportA.sentMessages).toHaveLength(1);
        expect(transportA.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });
        expect(transportB.sentMessages).toHaveLength(1);
        expect(transportB.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 2, result: {} });
    });
});
