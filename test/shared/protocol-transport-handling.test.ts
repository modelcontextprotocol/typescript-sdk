import { describe, expect, test, beforeEach } from 'vitest';
import { Protocol } from '../../src/shared/protocol.js';
import { Transport } from '../../src/shared/transport.js';
import { Request, Notification, Result, JSONRPCMessage } from '../../src/types.js';
import * as z from 'zod/v4';

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
        let resolveA: (value: Result) => void;
        let resolveB: (value: Result) => void;
        let handlerAEnteredResolve: () => void;
        let handlerBEnteredResolve: () => void;
        const handlerAEntered = new Promise<void>(resolve => {
            handlerAEnteredResolve = resolve;
        });
        const handlerBEntered = new Promise<void>(resolve => {
            handlerBEnteredResolve = resolve;
        });

        const TestRequestSchema = z.object({
            method: z.literal('test/method'),
            params: z
                .object({
                    from: z.string()
                })
                .optional()
        });

        protocolA.setRequestHandler(TestRequestSchema, async () => {
            return new Promise<Result>(resolve => {
                resolveA = resolve;
                handlerAEnteredResolve();
            });
        });

        protocolB.setRequestHandler(TestRequestSchema, async () => {
            return new Promise<Result>(resolve => {
                resolveB = resolve;
                handlerBEnteredResolve();
            });
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

        // Client B connects to a separate protocol instance
        await protocolB.connect(transportB);

        const requestFromB = {
            jsonrpc: '2.0' as const,
            method: 'test/method',
            params: { from: 'clientB' },
            id: 2
        };

        // Client B sends its own request
        transportB.onmessage?.(requestFromB);

        // Wait for both handlers to be invoked so resolvers are captured
        await handlerAEntered;
        await handlerBEntered;

        // Resolve each handler with distinct data
        resolveA!({ data: 'responseForA' } as Result);
        resolveB!({ data: 'responseForB' } as Result);

        // Wait for response delivery (transport.send is async)
        await new Promise(resolve => setTimeout(resolve, 10));

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

    test('demonstrates isolation with separate protocol instances for rapid connections', async () => {
        const protocolA = createProtocol();
        const protocolB = createProtocol();

        const DelayedRequestSchema = z.object({
            method: z.literal('test/delayed'),
            params: z
                .object({
                    delay: z.number(),
                    client: z.string()
                })
                .optional()
        });

        // Set up handler with variable delay on each protocol
        for (const protocol of [protocolA, protocolB]) {
            protocol.setRequestHandler(DelayedRequestSchema, async (request, extra) => {
                const delay = request.params?.delay || 0;
                await new Promise(resolve => setTimeout(resolve, delay));
                return {
                    processedBy: `handler-${extra.requestId}`,
                    delay: delay
                } as Result;
            });
        }

        // Connect and send requests
        await protocolA.connect(transportA);
        transportA.onmessage?.({
            jsonrpc: '2.0' as const,
            method: 'test/delayed',
            params: { delay: 50, client: 'A' },
            id: 1
        });

        // Connect B while A is processing
        setTimeout(async () => {
            await protocolB.connect(transportB);
            transportB.onmessage?.({
                jsonrpc: '2.0' as const,
                method: 'test/delayed',
                params: { delay: 10, client: 'B' },
                id: 2
            });
        }, 10);

        // Wait for all processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Each transport receives its own responses
        expect(transportA.sentMessages.length).toBe(1);
        expect(transportB.sentMessages.length).toBe(1);
    });

    test('connect guard throws when calling connect() twice without closing', async () => {
        const protocol = createProtocol();

        await protocol.connect(transportA);

        await expect(protocol.connect(transportB)).rejects.toThrow(
            'Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.'
        );
    });

    test('connect succeeds after calling close() first', async () => {
        const protocol = createProtocol();

        await protocol.connect(transportA);
        await protocol.close();

        // Should succeed without error
        await expect(protocol.connect(transportB)).resolves.toBeUndefined();
    });

    test('close() aborts in-flight request handlers', async () => {
        const protocol = createProtocol();

        const SlowRequestSchema = z.object({
            method: z.literal('test/slow')
        });

        let capturedSignal: AbortSignal | undefined;
        let capturedSendNotification: ((notification: Notification) => Promise<void>) | undefined;
        let resolveHandler: () => void;
        const handlerBlocking = new Promise<void>(resolve => {
            resolveHandler = resolve;
        });

        protocol.setRequestHandler(SlowRequestSchema, async (_request, extra) => {
            capturedSignal = extra.signal;
            capturedSendNotification = extra.sendNotification;
            // Block the handler until we release it
            await handlerBlocking;
            return {} as Result;
        });

        await protocol.connect(transportA);

        // Send a request to trigger the handler
        transportA.onmessage?.({
            jsonrpc: '2.0' as const,
            method: 'test/slow',
            id: 1
        });

        // Wait for the handler to start and capture the signal
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal!.aborted).toBe(false);

        // Close the protocol while the handler is still in-flight
        await protocol.close();

        // The signal should now be aborted
        expect(capturedSignal!.aborted).toBe(true);

        // sendNotification should be a no-op after close (no error thrown)
        await expect(capturedSendNotification!({ method: 'notifications/test' } as Notification)).resolves.toBeUndefined();

        // No notification should have been sent to the transport
        const notifications = transportA.sentMessages.filter((m: JSONRPCMessage) => 'method' in m && m.method === 'notifications/test');
        expect(notifications).toHaveLength(0);

        // Release the handler so the promise chain completes
        resolveHandler!();
    });
});
