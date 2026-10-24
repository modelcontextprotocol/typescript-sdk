import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/core-internal';
import { LATEST_PROTOCOL_VERSION, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Client } from '../../src/client/client';

class HangingInitializedTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    initializedSignal: AbortSignal | undefined;
    closeCalls = 0;
    private initializedSent!: () => void;
    readonly initializedSentPromise = new Promise<void>(resolve => {
        this.initializedSent = resolve;
    });

    constructor(
        private readonly honorRequestSignal = true,
        private readonly initializeDelay = 0,
        private readonly afterInitialize?: () => void
    ) {}

    async start(): Promise<void> {}

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        if (!('method' in message)) return;

        if (message.method === 'initialize' && 'id' in message) {
            if (this.initializeDelay) await new Promise(resolve => setTimeout(resolve, this.initializeDelay));
            this.onmessage?.({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    serverInfo: { name: 'hanging-server', version: '1.0.0' }
                }
            });
            this.afterInitialize?.();
            return;
        }

        if (message.method === 'notifications/initialized') {
            const signal = options?.requestSignal;
            this.initializedSignal = signal;
            this.initializedSent();

            // Model a per-request HTTP transport whose POST remains pending
            // until request-level cancellation aborts it.
            if (!this.honorRequestSignal) return await new Promise<void>(() => {});
            return await new Promise<void>((_resolve, reject) => {
                if (signal?.aborted) {
                    reject(signal.reason);
                    return;
                }
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        }
    }

    async close(): Promise<void> {
        this.closeCalls++;
        this.onclose?.();
    }
}

function createClient(): Client {
    return new Client({ name: 'connect-timeout-test', version: '1.0.0' });
}

describe('Client.connect initialized notification cancellation', () => {
    afterEach(() => vi.useRealTimers());
    test('bounds the notifications/initialized POST by its own stage timeout', async () => {
        // The timeout must settle connect() itself, even if a custom transport
        // ignores the optional request signal.
        const transport = new HangingInitializedTransport(false);
        const client = createClient();

        await expect(client.connect(transport, { timeout: 20 })).rejects.toMatchObject({
            code: SdkErrorCode.RequestTimeout
        });

        expect(transport.initializedSignal?.aborted).toBe(true);
        expect(transport.closeCalls).toBe(1);
        expect(client.transport).toBeUndefined();
    });

    test.each([
        new Error('connect cancelled'),
        new SdkError(SdkErrorCode.ConnectionClosed, 'caller closed connection'),
        new DOMException('Aborted', 'AbortError')
    ])('preserves the caller abort reason while sending initialized: %s', async reason => {
        const transport = new HangingInitializedTransport();
        const client = createClient();
        const controller = new AbortController();

        const connecting = client.connect(transport, { timeout: 1_000, signal: controller.signal });
        await transport.initializedSentPromise;
        controller.abort(reason);

        await expect(connecting).rejects.toBe(reason);
        expect(transport.initializedSignal?.reason).toBe(reason);
        expect(transport.initializedSignal?.aborted).toBe(true);
        expect(transport.closeCalls).toBe(1);
        expect(client.transport).toBeUndefined();
    });

    test('gives initialized a fresh timeout after initialize uses part of its budget', async () => {
        vi.useFakeTimers();
        const transport = new HangingInitializedTransport(false, 80);
        const client = createClient();
        let settled = false;
        const connecting = client.connect(transport, { timeout: 100 });
        const rejected = expect(connecting).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout });
        void connecting.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );

        await vi.advanceTimersByTimeAsync(80);
        await transport.initializedSentPromise;
        await vi.advanceTimersByTimeAsync(99);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(transport.closeCalls).toBe(1);
    });

    test.each([
        new Error('connect cancelled before initialized'),
        new SdkError(SdkErrorCode.ConnectionClosed, 'caller closed connection'),
        'cancelled'
    ])('preserves an abort reason before initialized and closes the transport: %s', async reason => {
        const controller = new AbortController();
        const transport = new HangingInitializedTransport(true, 0, () => controller.abort(reason));
        const client = createClient();

        await expect(client.connect(transport, { signal: controller.signal })).rejects.toBe(reason);
        expect(transport.initializedSignal).toBeUndefined();
        expect(transport.closeCalls).toBe(1);
        expect(client.transport).toBeUndefined();
    });
});
