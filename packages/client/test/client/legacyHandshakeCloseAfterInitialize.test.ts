/**
 * The trigger reported in #2864: the transport closes during the legacy
 * `initialize` handshake, right after the server's result is delivered, so the
 * client's `notifications/initialized` is sent on a connection that is already
 * gone. `connect()` must reject through its returned promise with the
 * not-connected send failure, and nothing else may escape.
 *
 * Node's rejection tracker does not report the one-microtask handler gap that
 * workerd does (see core-internal's notificationSendRejection test for the
 * timing observation itself); this end-to-end test pins the trigger path and
 * the error `connect()` rejects with.
 */
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import { isJSONRPCRequest, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { Client } from '../../src/client/client';

/** Answers `initialize`, then closes in the same tick — before the client can send `notifications/initialized`. */
class ReplyThenCloseTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    sent: JSONRPCMessage[] = [];
    closeCalls = 0;

    async start(): Promise<void> {}

    async send(message: JSONRPCMessage): Promise<void> {
        this.sent.push(message);
        if (!isJSONRPCRequest(message) || message.method !== 'initialize') return;
        queueMicrotask(() => {
            this.onmessage?.({
                jsonrpc: '2.0',
                id: message.id,
                result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'flaky', version: '0' } }
            });
            this.onclose?.();
        });
    }

    async close(): Promise<void> {
        this.closeCalls++;
    }
}

describe('legacy handshake: transport closes between the initialize result and notifications/initialized', () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
    };

    beforeEach(() => {
        unhandled.length = 0;
        process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
        process.off('unhandledRejection', onUnhandled);
    });

    test('connect() rejects with SdkError NotConnected from the initialized-notification send and no rejection escapes', async () => {
        const transport = new ReplyThenCloseTransport();
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'legacy' } });

        const rejection = await client.connect(transport).then(
            () => undefined,
            (error: unknown) => error
        );

        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.NotConnected);
        // The handshake got as far as the send that failed: initialize went out,
        // the initialized notification never did.
        expect(transport.sent.map(m => ('method' in m ? m.method : 'response'))).toEqual(['initialize']);

        // Let any stray rejection surface before asserting none did.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
    });
});
