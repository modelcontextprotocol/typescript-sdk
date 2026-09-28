/**
 * Server-side twin of core-internal's notificationSendRejection test: a
 * `sendLoggingMessage()` on a server with no transport must reject ONLY
 * through the returned promise. The send funnel returns an already-rejected
 * promise; if `Protocol.notification()` returned it instead of awaiting it,
 * the inner rejection would sit unhandled for one microtask (reported by
 * workerd as `unhandledrejection` + `rejectionhandled`, #2864).
 */
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { Server } from '../../src/server/server';

function instrumentedRejection(error: Error): { promise: Promise<void>; thenReads: () => number } {
    const promise = Promise.reject<void>(error);
    const originalThen = promise.then.bind(promise);
    let reads = 0;
    Object.defineProperty(promise, 'then', {
        get() {
            reads++;
            return originalThen;
        }
    });
    return { promise, thenReads: () => reads };
}

describe('Server notification sends on a closed connection', () => {
    test('sendLoggingMessage() when not connected: the inner send rejection is handled in the same microtask', async () => {
        const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { logging: {} } });
        const notConnected = new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        const inner = instrumentedRejection(notConnected);

        // Plain instance override rather than `vi.spyOn`: the spy wrapper itself
        // reads `then` on any promise a spied call returns, which would mask the
        // observation below.
        (server as unknown as { _notificationViaCodec: () => Promise<void> })._notificationViaCodec = () => inner.promise;

        await expect(server.sendLoggingMessage({ level: 'info', data: 'hello' })).rejects.toBe(notConnected);

        // `then` is read (synchronously at return, called one microtask later)
        // only when `notification()` returns the inner promise without awaiting it.
        expect(inner.thenReads()).toBe(0);
    });

    test('sendLoggingMessage() when not connected still rejects with SdkError NotConnected (unstubbed path)', async () => {
        const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { logging: {} } });

        await expect(server.sendLoggingMessage({ level: 'info', data: 'hello' })).rejects.toSatisfy(
            (error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.NotConnected
        );
    });
});
