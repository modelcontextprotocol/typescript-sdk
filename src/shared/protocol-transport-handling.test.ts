import { describe, expect, test, beforeEach } from '@jest/globals';
import { Protocol } from './protocol.js';
import { Transport } from './transport.js';
import { Request, Notification, Result, JSONRPCMessage } from '../types.js';
import { z } from 'zod';

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
        })();

        transportA = new MockTransport('A');
        transportB = new MockTransport('B');
    });

    test('should send response to the correct transport when multiple clients are connected', async () => {
        // Set up a request handler that simulates processing time
        let resolveHandler: (value: Result) => void;
        const handlerPromise = new Promise<Result>(resolve => {
            resolveHandler = resolve;
        });

        const TestRequestSchema = z.object({
            method: z.literal('test/method'),
            params: z
                .object({
                    from: z.string()
                })
                .optional()
        });

        protocol.setRequestHandler(TestRequestSchema, async request => {
            console.log(`Processing request from ${request.params?.from}`);
            return handlerPromise;
        });

        // Client A connects and sends a request
        await protocol.connect(transportA);

        const requestFromA = {
            jsonrpc: '2.0' as const,
            method: 'test/method',
            params: { from: 'clientA' },
            id: 1
        };

        // Simulate client A sending a request
        transportA.onmessage?.(requestFromA);

        // While A's request is being processed, client B connects
        // This overwrites the transport reference in the protocol
        await protocol.connect(transportB);

        const requestFromB = {
            jsonrpc: '2.0' as const,
            method: 'test/method',
            params: { from: 'clientB' },
            id: 2
        };

        // Client B sends its own request
        transportB.onmessage?.(requestFromB);

        // Now complete A's request
        resolveHandler!({ data: 'responseForA' } as Result);

        // Wait for async operations to complete
        await new Promise(resolve => setTimeout(resolve, 10));

        // Check where the responses went
        console.log('Transport A received:', transportA.sentMessages);
        console.log('Transport B received:', transportB.sentMessages);

        // FIXED: Each transport now receives its own response

        // Transport A should receive response for request ID 1
        expect(transportA.sentMessages.length).toBe(1);
        expect(transportA.sentMessages[0]).toMatchObject({
            jsonrpc: '2.0',
            id: 1,
            result: { data: 'responseForA' }
        });

        // Transport B should only receive its own response (when implemented)
        expect(transportB.sentMessages.length).toBe(1);
        expect(transportB.sentMessages[0]).toMatchObject({
            jsonrpc: '2.0',
            id: 2,
            result: { data: 'responseForA' } // Same handler result in this test
        });
    });

    test('demonstrates the timing issue with multiple rapid connections', async () => {
        const delays: number[] = [];
        const results: { transport: string; response: JSONRPCMessage[] }[] = [];

        const DelayedRequestSchema = z.object({
            method: z.literal('test/delayed'),
            params: z
                .object({
                    delay: z.number(),
                    client: z.string()
                })
                .optional()
        });

        // Set up handler with variable delay
        protocol.setRequestHandler(DelayedRequestSchema, async (request, extra) => {
            const delay = request.params?.delay || 0;
            delays.push(delay);

            await new Promise(resolve => setTimeout(resolve, delay));

            return {
                processedBy: `handler-${extra.requestId}`,
                delay: delay
            } as Result;
        });

        // Rapid succession of connections and requests
        await protocol.connect(transportA);
        transportA.onmessage?.({
            jsonrpc: '2.0' as const,
            method: 'test/delayed',
            params: { delay: 50, client: 'A' },
            id: 1
        });

        // Connect B while A is processing
        setTimeout(async () => {
            await protocol.connect(transportB);
            transportB.onmessage?.({
                jsonrpc: '2.0' as const,
                method: 'test/delayed',
                params: { delay: 10, client: 'B' },
                id: 2
            });
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

        // FIXED: Each transport receives its own responses
        expect(transportA.sentMessages.length).toBe(1);
        expect(transportB.sentMessages.length).toBe(1);
    });
});
