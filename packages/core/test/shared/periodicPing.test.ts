import { vi, beforeEach, afterEach, describe, test, expect } from 'vitest';

import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import type { Transport, TransportSendOptions } from '../../src/shared/transport.js';
import type { JSONRPCMessage } from '../../src/types/types.js';

class MockTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;

    async start(): Promise<void> {}
    async close(): Promise<void> {
        this.onclose?.();
    }
    async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}
}

function createProtocol(options?: { pingIntervalMs?: number }) {
    return new (class extends Protocol<BaseContext> {
        protected assertCapabilityForMethod(): void {}
        protected assertNotificationCapability(): void {}
        protected assertRequestHandlerCapability(): void {}
        protected assertTaskCapability(): void {}
        protected buildContext(ctx: BaseContext): BaseContext {
            return ctx;
        }
        protected assertTaskHandlerCapability(): void {}
        // Expose protected methods for testing
        public testStartPeriodicPing(): void {
            this.startPeriodicPing();
        }
        public testStopPeriodicPing(): void {
            this.stopPeriodicPing();
        }
    })(options);
}

describe('Periodic Ping', () => {
    let transport: MockTransport;

    beforeEach(() => {
        vi.useFakeTimers();
        transport = new MockTransport();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('should not send periodic pings when pingIntervalMs is not set', async () => {
        const protocol = createProtocol();
        const sendSpy = vi.spyOn(transport, 'send');

        await protocol.connect(transport);

        // Advance time well past any reasonable interval
        await vi.advanceTimersByTimeAsync(120_000);

        // No ping requests should have been sent (only no messages at all)
        const pingMessages = sendSpy.mock.calls.filter(call => {
            const msg = call[0] as { method?: string };
            return msg.method === 'ping';
        });
        expect(pingMessages).toHaveLength(0);
    });

    test('should send periodic pings when pingIntervalMs is set and startPeriodicPing is called', async () => {
        const protocol = createProtocol({ pingIntervalMs: 10_000 });
        const sendSpy = vi.spyOn(transport, 'send');

        await protocol.connect(transport);

        // Respond to each ping with a success result
        sendSpy.mockImplementation(async (message: JSONRPCMessage) => {
            const msg = message as { id?: number; method?: string };
            if (msg.method === 'ping' && msg.id !== undefined) {
                // Simulate the server responding with a pong
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {}
                });
            }
        });

        // Start periodic ping (in real usage, Client.connect() calls this after init)
        protocol.testStartPeriodicPing();

        // No ping yet (first fires after one interval)
        const pingsBeforeAdvance = sendSpy.mock.calls.filter(call => {
            const msg = call[0] as { method?: string };
            return msg.method === 'ping';
        });
        expect(pingsBeforeAdvance).toHaveLength(0);

        // Advance past one interval
        await vi.advanceTimersByTimeAsync(10_000);

        const pingsAfterOne = sendSpy.mock.calls.filter(call => {
            const msg = call[0] as { method?: string };
            return msg.method === 'ping';
        });
        expect(pingsAfterOne).toHaveLength(1);

        // Advance past another interval
        await vi.advanceTimersByTimeAsync(10_000);

        const pingsAfterTwo = sendSpy.mock.calls.filter(call => {
            const msg = call[0] as { method?: string };
            return msg.method === 'ping';
        });
        expect(pingsAfterTwo).toHaveLength(2);
    });

    test('should stop periodic pings on close', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const sendSpy = vi.spyOn(transport, 'send');

        await protocol.connect(transport);

        sendSpy.mockImplementation(async (message: JSONRPCMessage) => {
            const msg = message as { id?: number; method?: string };
            if (msg.method === 'ping' && msg.id !== undefined) {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {}
                });
            }
        });

        protocol.testStartPeriodicPing();

        // One ping fires
        await vi.advanceTimersByTimeAsync(5_000);
        const pingsBeforeClose = sendSpy.mock.calls.filter(call => {
            const msg = call[0] as { method?: string };
            return msg.method === 'ping';
        });
        expect(pingsBeforeClose).toHaveLength(1);

        // Close the connection
        await protocol.close();

        // Advance more time; no new pings should be sent
        sendSpy.mockClear();
        await vi.advanceTimersByTimeAsync(20_000);

        const pingsAfterClose = sendSpy.mock.calls.filter(call => {
            const msg = call[0] as { method?: string };
            return msg.method === 'ping';
        });
        expect(pingsAfterClose).toHaveLength(0);
    });

    test('should report ping errors via onerror without stopping the timer', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const errors: Error[] = [];
        protocol.onerror = error => {
            errors.push(error);
        };

        await protocol.connect(transport);

        // Make send reject to simulate a failed ping
        const sendSpy = vi.spyOn(transport, 'send');
        sendSpy.mockImplementation(async (message: JSONRPCMessage) => {
            const msg = message as { id?: number; method?: string };
            if (msg.method === 'ping' && msg.id !== undefined) {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: {
                        code: -32000,
                        message: 'Server error'
                    }
                });
            }
        });

        protocol.testStartPeriodicPing();

        // First ping fails
        await vi.advanceTimersByTimeAsync(5_000);
        expect(errors).toHaveLength(1);

        // Second ping also fails, proving the timer was not stopped
        await vi.advanceTimersByTimeAsync(5_000);
        expect(errors).toHaveLength(2);
    });

    test('should not start duplicate timers if startPeriodicPing is called multiple times', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const sendSpy = vi.spyOn(transport, 'send');

        await protocol.connect(transport);

        sendSpy.mockImplementation(async (message: JSONRPCMessage) => {
            const msg = message as { id?: number; method?: string };
            if (msg.method === 'ping' && msg.id !== undefined) {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {}
                });
            }
        });

        // Call startPeriodicPing multiple times
        protocol.testStartPeriodicPing();
        protocol.testStartPeriodicPing();
        protocol.testStartPeriodicPing();

        await vi.advanceTimersByTimeAsync(5_000);

        // Should only have one ping, not three
        const pings = sendSpy.mock.calls.filter(call => {
            const msg = call[0] as { method?: string };
            return msg.method === 'ping';
        });
        expect(pings).toHaveLength(1);
    });

    test('should stop periodic pings when transport closes unexpectedly', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const sendSpy = vi.spyOn(transport, 'send');

        await protocol.connect(transport);

        sendSpy.mockImplementation(async (message: JSONRPCMessage) => {
            const msg = message as { id?: number; method?: string };
            if (msg.method === 'ping' && msg.id !== undefined) {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {}
                });
            }
        });

        protocol.testStartPeriodicPing();

        // One ping fires
        await vi.advanceTimersByTimeAsync(5_000);

        // Simulate transport closing unexpectedly
        transport.onclose?.();

        sendSpy.mockClear();
        await vi.advanceTimersByTimeAsync(20_000);

        const pingsAfterTransportClose = sendSpy.mock.calls.filter(call => {
            const msg = call[0] as { method?: string };
            return msg.method === 'ping';
        });
        expect(pingsAfterTransportClose).toHaveLength(0);
    });
});
