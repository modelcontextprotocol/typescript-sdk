import { beforeEach, describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { Protocol } from '../../src/shared/protocol.js';
import type { Transport } from '../../src/shared/transport.js';
import type { JSONRPCMessage, Notification, Request, Result } from '../../src/types/types.js';

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

function createProtocol(): Protocol<Request, Notification, Result> {
    return new (class extends Protocol<Request, Notification, Result> {
        protected assertCapabilityForMethod(): void {}
        protected assertNotificationCapability(): void {}
        protected assertRequestHandlerCapability(): void {}
        protected assertTaskCapability(): void {}
        protected assertTaskHandlerCapability(): void {}
    })();
}

describe('Protocol transport handling', () => {
    let protocol: Protocol<Request, Notification, Result>;
    let transportA: MockTransport;
    let transportB: MockTransport;

    beforeEach(() => {
        protocol = createProtocol();
        transportA = new MockTransport('A');
        transportB = new MockTransport('B');
    });

    test('should throw error when connecting to an already connected protocol', async () => {
        // Connect first transport
        await protocol.connect(transportA);

        // Attempting to connect second transport should throw
        await expect(protocol.connect(transportB)).rejects.toThrow('Protocol is already connected to a transport');
    });

    test('should allow reconnection after close()', async () => {
        // Connect first transport
        await protocol.connect(transportA);

        // Close the connection
        await protocol.close();

        // Now connecting second transport should work
        await expect(protocol.connect(transportB)).resolves.not.toThrow();
    });

    test('should send response to the correct transport with separate protocol instances', async () => {
        // Create separate protocol instances for concurrent connections
        const protocolA = createProtocol();
        const protocolB = createProtocol();

        // Set up a request handler that simulates processing time
        let resolveHandlerA: (value: Result) => void;
        const handlerPromiseA = new Promise<Result>(resolve => {
            resolveHandlerA = resolve;
        });

        let resolveHandlerB: (value: Result) => void;
        const handlerPromiseB = new Promise<Result>(resolve => {
            resolveHandlerB = resolve;
        });

        const TestRequestSchema = z.object({
            method: z.literal('test/method'),
            params: z
                .object({
                    from: z.string()
                })
                .optional()
        });

        protocolA.setRequestHandler(TestRequestSchema, async request => {
            console.log(`Processing request from ${request.params?.from}`);
            return handlerPromiseA;
        });

        protocolB.setRequestHandler(TestRequestSchema, async request => {
            console.log(`Processing request from ${request.params?.from}`);
            return handlerPromiseB;
        });

        // Client A connects and sends a request
        await protocolA.connect(transportA);

        const requestFromA = {
            jsonrpc: '2.0' as const,
            method: 'test/method',
            params: { from: 'clientA' },
            id: 1
        };

        // Simulate client A sending a request
        transportA.onmessage?.(requestFromA);

        // Client B connects to its own protocol instance
        await protocolB.connect(transportB);

        const requestFromB = {
            jsonrpc: '2.0' as const,
            method: 'test/method',
            params: { from: 'clientB' },
            id: 2
        };

        // Client B sends its own request
        transportB.onmessage?.(requestFromB);

        // Complete both requests
        resolveHandlerA!({ data: 'responseForA' } as Result);
        resolveHandlerB!({ data: 'responseForB' } as Result);

        // Wait for async operations to complete
        await new Promise(resolve => setTimeout(resolve, 10));

        // Check where the responses went
        console.log('Transport A received:', transportA.sentMessages);
        console.log('Transport B received:', transportB.sentMessages);

        // Each transport receives its own response
        expect(transportA.sentMessages.length).toBe(1);
        expect(transportA.sentMessages[0]).toMatchObject({
            jsonrpc: '2.0',
            id: 1,
            result: { data: 'responseForA' }
        });

        expect(transportB.sentMessages.length).toBe(1);
        expect(transportB.sentMessages[0]).toMatchObject({
            jsonrpc: '2.0',
            id: 2,
            result: { data: 'responseForB' }
        });
    });

    test('demonstrates proper handling with separate protocol instances', async () => {
        // Create separate protocol instances for concurrent connections
        const protocolA = createProtocol();
        const protocolB = createProtocol();

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

        // Set up handlers with variable delay on both protocols
        const setupHandler = (proto: Protocol<Request, Notification, Result>) => {
            proto.setRequestHandler(DelayedRequestSchema, async (request, extra) => {
                const delay = request.params?.delay || 0;
                delays.push(delay);

                await new Promise(resolve => setTimeout(resolve, delay));

                return {
                    processedBy: `handler-${extra.requestId}`,
                    delay: delay
                } as Result;
            });
        };

        setupHandler(protocolA);
        setupHandler(protocolB);

        // Connect A and send request
        await protocolA.connect(transportA);
        transportA.onmessage?.({
            jsonrpc: '2.0' as const,
            method: 'test/delayed',
            params: { delay: 50, client: 'A' },
            id: 1
        });

        // Connect B (separate instance) while A is processing
        await protocolB.connect(transportB);
        transportB.onmessage?.({
            jsonrpc: '2.0' as const,
            method: 'test/delayed',
            params: { delay: 10, client: 'B' },
            id: 2
        });

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

        // Each transport receives its own responses
        expect(transportA.sentMessages.length).toBe(1);
        expect(transportB.sentMessages.length).toBe(1);
    });
});
