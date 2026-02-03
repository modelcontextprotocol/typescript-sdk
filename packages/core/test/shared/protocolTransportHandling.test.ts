import { beforeEach, describe, expect, test } from 'vitest';

import { Protocol } from '../../src/shared/protocol.js';
import type { Transport } from '../../src/shared/transport.js';
import type { EmptyResult, JSONRPCMessage, Notification, Request, Result } from '../../src/types/types.js';

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

describe('Protocol transport handling bug', () => {
    let protocol: Protocol<Request, Notification, Result>;
    let transportA: MockTransport;
    let transportB: MockTransport;

    beforeEach(() => {
        protocol = new (class extends Protocol<Request, Notification, Result> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected assertTaskHandlerCapability(): void {}
        })();

        transportA = new MockTransport('A');
        transportB = new MockTransport('B');
    });

    test('should send response to the correct transport when multiple clients are connected', async () => {
        // Set up a request handler that simulates processing time
        let resolveHandler: (value: EmptyResult) => void;
        const handlerPromise = new Promise<EmptyResult>(resolve => {
            resolveHandler = resolve;
        });

        protocol.setRequestHandler('ping', async () => handlerPromise);

        // Client A connects and sends a request
        await protocol.connect(transportA);
        transportA.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });

        // While A's request is being processed, client B connects
        // This overwrites the transport reference in the protocol
        await protocol.connect(transportB);
        transportB.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 2 });

        // Now complete A's request
        resolveHandler!({});

        // Wait for async operations to complete
        await new Promise(resolve => setTimeout(resolve, 10));

        // Check where the responses went
        console.log('Transport A received:', transportA.sentMessages);
        console.log('Transport B received:', transportB.sentMessages);

        // Transport A should receive response for request ID 1
        expect(transportA.sentMessages).toHaveLength(1);
        expect(transportA.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });

        // Transport B should receive response for request ID 2
        expect(transportB.sentMessages).toHaveLength(1);
        expect(transportB.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 2, result: {} });
    });

    test('demonstrates the timing issue with multiple rapid connections', async () => {
        const results: { transport: string; response: JSONRPCMessage[] }[] = [];

        // Set up handler with variable delay based on request id
        protocol.setRequestHandler('ping', async (_request, extra) => {
            const delay = extra.requestId === 1 ? 50 : 10;
            await new Promise(resolve => setTimeout(resolve, delay));
            return {};
        });

        // Rapid succession of connections and requests
        await protocol.connect(transportA);
        transportA.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });

        // Connect B while A is processing
        setTimeout(async () => {
            await protocol.connect(transportB);
            transportB.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 2 });
        }, 10);

        // Wait for all processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Collect results
        if (transportA.sentMessages.length > 0) {
            results.push({ transport: 'A', response: transportA.sentMessages });
        }
        if (transportB.sentMessages.length > 0) {
            results.push({ transport: 'B', response: transportB.sentMessages });
        }

        console.log('Timing test results:', results);

        expect(transportA.sentMessages).toHaveLength(1);
        expect(transportB.sentMessages).toHaveLength(1);
    });
});
