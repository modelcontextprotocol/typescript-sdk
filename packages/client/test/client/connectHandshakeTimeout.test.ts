import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/core-internal';
import { LATEST_PROTOCOL_VERSION, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { Client } from '../../src/client/client';

class HangingInitializedTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    initializedSignal: AbortSignal | undefined;
    private initializedSent!: () => void;
    readonly initializedSentPromise = new Promise<void>(resolve => {
        this.initializedSent = resolve;
    });

    constructor(private readonly honorRequestSignal = true) {}

    async start(): Promise<void> {}

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        if (!('method' in message)) return;

        if (message.method === 'initialize' && 'id' in message) {
            this.onmessage?.({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    serverInfo: { name: 'hanging-server', version: '1.0.0' }
                }
            });
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
        this.onclose?.();
    }
}

function createClient(): Client {
    return new Client({ name: 'connect-timeout-test', version: '1.0.0' });
}

describe('Client.connect initialized notification cancellation', () => {
    test('bounds the notifications/initialized POST by the connect timeout', async () => {
        // The timeout must settle connect() itself, even if a custom transport
        // ignores the optional request signal.
        const transport = new HangingInitializedTransport(false);
        const client = createClient();

        await expect(client.connect(transport, { timeout: 20 })).rejects.toMatchObject({
            code: SdkErrorCode.RequestTimeout
        });

        expect(transport.initializedSignal?.aborted).toBe(true);
    });

    test('aborts the notifications/initialized POST when the connect signal aborts', async () => {
        const transport = new HangingInitializedTransport();
        const client = createClient();
        const controller = new AbortController();

        const connecting = client.connect(transport, { timeout: 1_000, signal: controller.signal });
        await transport.initializedSentPromise;
        controller.abort(new Error('connect cancelled'));

        await expect(connecting).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout });
        expect(transport.initializedSignal?.aborted).toBe(true);
    });
});
