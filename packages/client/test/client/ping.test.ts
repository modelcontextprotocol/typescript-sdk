import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { Client } from '../../src/client/client.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/core';

// Mock Transport class
class MockTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;
    sessionId?: string;

    async start(): Promise<void> {}
    async close(): Promise<void> {
        this.onclose?.();
    }
    async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}
}

// Helper interface to access private members for testing
interface TestClient {
    _pingConfig: { enabled: boolean; intervalMs: number };
    _pingInterval?: ReturnType<typeof setInterval>;
}

describe('Client periodic ping', () => {
    let transport: MockTransport;
    let client: Client;
    let pingCalls: number;

    beforeEach(() => {
        transport = new MockTransport();
        pingCalls = 0;

        // Override ping method to track calls
        client = new Client(
            { name: 'test-client', version: '1.0.0' },
            {
                ping: {
                    enabled: true,
                    intervalMs: 100
                }
            }
        );

        // Mock the internal _requestWithSchema to track ping calls
        const originalRequest = (client as unknown as { _requestWithSchema: (...args: unknown[]) => Promise<unknown> })._requestWithSchema;
        (client as unknown as { _requestWithSchema: (...args: unknown[]) => Promise<unknown> })._requestWithSchema = async (...args: unknown[]) => {
            const request = args[0] as { method: string };
            if (request?.method === 'ping') {
                pingCalls++;
                return {};
            }
            return originalRequest.apply(client, args);
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should not start periodic ping when disabled', async () => {
        const disabledClient = new Client(
            { name: 'test-client', version: '1.0.0' },
            {
                ping: {
                    enabled: false,
                    intervalMs: 100
                }
            }
        );

        await disabledClient.connect(transport);

        // Wait longer than the ping interval
        await new Promise(resolve => setTimeout(resolve, 150));

        // Ping should not have been called
        expect(pingCalls).toBe(0);

        await disabledClient.close();
    });

    it('should start periodic ping when enabled', async () => {
        await client.connect(transport);

        // Wait for at least one ping interval
        await new Promise(resolve => setTimeout(resolve, 150));

        // Ping should have been called at least once
        expect(pingCalls).toBeGreaterThan(0);

        await client.close();
    });

    it('should stop periodic ping on close', async () => {
        await client.connect(transport);

        // Wait for a ping
        await new Promise(resolve => setTimeout(resolve, 150));
        const callCountAfterFirst = pingCalls;

        // Close the client
        await client.close();

        // Wait longer than ping interval
        await new Promise(resolve => setTimeout(resolve, 200));

        // No additional pings should have been made
        expect(pingCalls).toBe(callCountAfterFirst);
    });

    it('should use custom interval', async () => {
        const customIntervalClient = new Client(
            { name: 'test-client', version: '1.0.0' },
            {
                ping: {
                    enabled: true,
                    intervalMs: 200
                }
            }
        );

        let customPingCalls = 0;
        const originalRequest = (customIntervalClient as unknown as { _requestWithSchema: (...args: unknown[]) => Promise<unknown> })._requestWithSchema;
        (customIntervalClient as unknown as { _requestWithSchema: (...args: unknown[]) => Promise<unknown> })._requestWithSchema = async (...args: unknown[]) => {
            const request = args[0] as { method: string };
            if (request?.method === 'ping') {
                customPingCalls++;
                return {};
            }
            return originalRequest.apply(customIntervalClient, args);
        };

        await customIntervalClient.connect(transport);

        // Wait 100ms (less than interval)
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(customPingCalls).toBe(0);

        // Wait another 150ms (total 250ms, more than 200ms interval)
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(customPingCalls).toBeGreaterThan(0);

        await customIntervalClient.close();
    });

    it('should handle ping errors gracefully', async () => {
        const errors: Error[] = [];
        client.onerror = (error: Error) => {
            errors.push(error);
        };

        // Mock ping to fail
        const originalRequest = (client as unknown as { _requestWithSchema: (...args: unknown[]) => Promise<unknown> })._requestWithSchema;
        (client as unknown as { _requestWithSchema: (...args: unknown[]) => Promise<unknown> })._requestWithSchema = async (...args: unknown[]) => {
            const request = args[0] as { method: string };
            if (request?.method === 'ping') {
                throw new Error('Ping failed');
            }
            return originalRequest.apply(client, args);
        };

        await client.connect(transport);

        // Wait for ping to fail
        await new Promise(resolve => setTimeout(resolve, 150));

        // Should have recorded error
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]?.message).toContain('Periodic ping failed');
    });
});

describe('Client periodic ping configuration', () => {
    it('should use default values when ping config is not provided', () => {
        const defaultClient = new Client({ name: 'test', version: '1.0.0' });
        const testClient = defaultClient as unknown as TestClient;

        expect(testClient._pingConfig.enabled).toBe(false);
        expect(testClient._pingConfig.intervalMs).toBe(30000);
    });

    it('should use provided ping config values', () => {
        const configuredClient = new Client(
            { name: 'test', version: '1.0.0' },
            {
                ping: {
                    enabled: true,
                    intervalMs: 60000
                }
            }
        );
        const testClient = configuredClient as unknown as TestClient;

        expect(testClient._pingConfig.enabled).toBe(true);
        expect(testClient._pingConfig.intervalMs).toBe(60000);
    });

    it('should use partial ping config with defaults', () => {
        const partialClient = new Client(
            { name: 'test', version: '1.0.0' },
            {
                ping: {
                    intervalMs: 45000
                }
            }
        );
        const testClient = partialClient as unknown as TestClient;

        expect(testClient._pingConfig.enabled).toBe(false);
        expect(testClient._pingConfig.intervalMs).toBe(45000);
    });
});
