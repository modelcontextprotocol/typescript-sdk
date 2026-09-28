/**
 * `Protocol.notification()` must hand its caller the ONLY rejection a failed
 * send produces. The send funnel (`_notificationViaCodec`) is an async method
 * that throws synchronously when there is no transport, so the promise it
 * returns is already rejected. If `notification()` returns that promise
 * instead of awaiting it, the async-function resolution goes through the
 * thenable job: the inner rejection sits with no handler for one microtask
 * before the job reads and calls its `then`. Node's tracker forgives that;
 * workerd (Cloudflare Workers) reports it as `unhandledrejection` followed by
 * `rejectionhandled`, which surfaces as noise in Vitest runs on that platform
 * (#2864).
 *
 * The observation below is the handler-attachment timing itself: with
 * `return await`, `await` attaches its reaction through the internal
 * promise-then path and the inner promise's own `then` property is never
 * read; with a bare `return`, the thenable job reads it one microtask later.
 */
import { describe, expect, test } from 'vitest';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors';
import type { BaseContext } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';

class TestProtocolImpl extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

/**
 * A natively rejected promise whose `then` property records every read.
 * The thenable-resolution job reaches `then` via property lookup; `await`
 * on a native promise does not.
 */
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

describe('Protocol.notification(): a failed send rejects only through the returned promise', () => {
    test('when not connected, the inner send rejection is handled in the same microtask (no thenable-job hop)', async () => {
        const protocol = new TestProtocolImpl();
        const notConnected = new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        const inner = instrumentedRejection(notConnected);

        // Stand in for the real funnel with a rejection we can observe. The real
        // one throws synchronously on `!this._transport`, i.e. it also returns an
        // already-rejected promise — the shape that matters here.
        // Plain instance override rather than `vi.spyOn`: the spy wrapper itself
        // reads `then` on any promise a spied call returns, which would mask the
        // observation below.
        (protocol as unknown as { _notificationViaCodec: () => Promise<void> })._notificationViaCodec = () => inner.promise;

        await expect(protocol.notification({ method: 'notifications/initialized' })).rejects.toBe(notConnected);

        // A bare `return innerPromise` from the async method resolves via the
        // thenable job, which reads `then` one microtask after the inner promise
        // rejected — the window in which workerd reports it unhandled.
        expect(inner.thenReads()).toBe(0);
    });

    test('when not connected, the returned promise still rejects with SdkError NotConnected (unstubbed path)', async () => {
        const protocol = new TestProtocolImpl();

        await expect(protocol.notification({ method: 'notifications/initialized' })).rejects.toSatisfy(
            (error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.NotConnected
        );
    });
});
