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

/** Configure the spy to auto-respond to pings with a success result. */
function autoRespondPings(transport: MockTransport, sendSpy: ReturnType<typeof vi.spyOn>): void {
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
}

/** Count ping messages in spy call history. */
function countPings(sendSpy: ReturnType<typeof vi.spyOn>): number {
    return sendSpy.mock.calls.filter((call: unknown[]) => {
        const msg = call[0] as { method?: string };
        return msg.method === 'ping';
    }).length;
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

        expect(countPings(sendSpy)).toBe(0);
    });

    test('should send periodic pings when pingIntervalMs is set and startPeriodicPing is called', async () => {
        const protocol = createProtocol({ pingIntervalMs: 10_000 });
        const sendSpy = vi.spyOn(transport, 'send');

        await protocol.connect(transport);
        autoRespondPings(transport, sendSpy);

        // Start periodic ping (in real usage, Client.connect() calls this after init)
        protocol.testStartPeriodicPing();

        // No ping yet (first fires after one interval)
        expect(countPings(sendSpy)).toBe(0);

        // Advance past one interval
        await vi.advanceTimersByTimeAsync(10_000);
        expect(countPings(sendSpy)).toBe(1);

        // Advance past another interval
        await vi.advanceTimersByTimeAsync(10_000);
        expect(countPings(sendSpy)).toBe(2);
    });

    test('should stop periodic pings on close', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const sendSpy = vi.spyOn(transport, 'send');

        await protocol.connect(transport);
        autoRespondPings(transport, sendSpy);

        protocol.testStartPeriodicPing();

        // One ping fires
        await vi.advanceTimersByTimeAsync(5_000);
        expect(countPings(sendSpy)).toBe(1);

        // Close the connection
        await protocol.close();

        // Advance more time; no new pings should be sent
        sendSpy.mockClear();
        await vi.advanceTimersByTimeAsync(20_000);

        expect(countPings(sendSpy)).toBe(0);
    });

    test('should report ping errors via onerror without stopping the loop', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const errors: Error[] = [];
        protocol.onerror = error => {
            errors.push(error);
        };

        await protocol.connect(transport);

        // Respond with an error to simulate a failed ping
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

        // Second ping also fails, proving the loop was not stopped
        await vi.advanceTimersByTimeAsync(5_000);
        expect(errors).toHaveLength(2);
    });

    test('should not start duplicate timers if startPeriodicPing is called multiple times', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const sendSpy = vi.spyOn(transport, 'send');

        await protocol.connect(transport);
        autoRespondPings(transport, sendSpy);

        // Call startPeriodicPing multiple times
        protocol.testStartPeriodicPing();
        protocol.testStartPeriodicPing();
        protocol.testStartPeriodicPing();

        await vi.advanceTimersByTimeAsync(5_000);

        // Should only have one ping, not three
        expect(countPings(sendSpy)).toBe(1);
    });

    test('should stop periodic pings when transport closes unexpectedly', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const sendSpy = vi.spyOn(transport, 'send');

        await protocol.connect(transport);
        autoRespondPings(transport, sendSpy);

        protocol.testStartPeriodicPing();

        // One ping fires
        await vi.advanceTimersByTimeAsync(5_000);

        // Simulate transport closing unexpectedly
        transport.onclose?.();

        sendSpy.mockClear();
        await vi.advanceTimersByTimeAsync(20_000);

        expect(countPings(sendSpy)).toBe(0);
    });

    test('should not fire onerror when close() races with an in-flight ping', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const errors: Error[] = [];
        protocol.onerror = error => {
            errors.push(error);
        };

        await protocol.connect(transport);

        // Do NOT auto-respond: the ping will remain in-flight so close() races with it
        protocol.testStartPeriodicPing();

        // Advance to fire the first ping (it is now awaiting a response)
        await vi.advanceTimersByTimeAsync(5_000);

        // Close while the ping is in-flight; this should NOT produce an onerror
        await protocol.close();

        // Drain any pending microtasks
        await vi.advanceTimersByTimeAsync(0);

        expect(errors).toHaveLength(0);
    });

    test('pings are strictly sequential (no concurrent overlap)', async () => {
        const protocol = createProtocol({ pingIntervalMs: 5_000 });
        const sendSpy = vi.spyOn(transport, 'send');
        let inFlightPings = 0;
        let maxConcurrent = 0;

        await protocol.connect(transport);

        sendSpy.mockImplementation(async (message: JSONRPCMessage) => {
            const msg = message as { id?: number; method?: string };
            if (msg.method === 'ping' && msg.id !== undefined) {
                inFlightPings++;
                if (inFlightPings > maxConcurrent) {
                    maxConcurrent = inFlightPings;
                }
                // Simulate a slow response: resolve after a short delay
                setTimeout(() => {
                    inFlightPings--;
                    transport.onmessage?.({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {}
                    });
                }, 2_000);
            }
        });

        protocol.testStartPeriodicPing();

        // Advance enough for multiple ping cycles
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(5_000);
            // Let the delayed response resolve
            await vi.advanceTimersByTimeAsync(2_000);
        }

        // With setTimeout-based scheduling, pings are strictly sequential
        expect(maxConcurrent).toBe(1);
        // Verify pings were actually sent
        expect(countPings(sendSpy)).toBeGreaterThanOrEqual(3);
    });
});
