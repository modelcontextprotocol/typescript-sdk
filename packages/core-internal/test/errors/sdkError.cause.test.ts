import { describe, it, expect } from 'vitest';
import { SdkError, SdkErrorCode, SdkHttpError } from '../../src/index';

describe('SdkError cause forwarding', () => {
    it('forwards ErrorOptions.cause onto Error.cause', () => {
        const root = new TypeError('fetch failed');
        const error = new SdkError(SdkErrorCode.EraNegotiationFailed, 'probe failed', undefined, { cause: root });

        expect(error.cause).toBe(root);
        expect(error.data).toBeUndefined();
    });

    it('peels a mistaken { cause } out of the data bag onto Error.cause', () => {
        const root = new TypeError('fetch failed');
        Object.defineProperty(root, 'cause', {
            value: new Error('getaddrinfo ENOTFOUND does-not-resolve.invalid'),
            configurable: true
        });

        // Historical call shape: third arg is `data`, but sites passed `{ cause }`.
        const error = new SdkError(SdkErrorCode.EraNegotiationFailed, 'Version negotiation probe failed: fetch failed', {
            cause: root
        });

        expect(error.cause).toBe(root);
        expect(error.data).toBeUndefined();
        expect((error.cause as Error).cause).toBeInstanceOf(Error);
        expect(((error.cause as Error).cause as Error).message).toContain('ENOTFOUND');
    });

    it('keeps sibling data fields when peeling cause', () => {
        const root = new Error('boom');
        const error = new SdkError(SdkErrorCode.RequestTimeout, 'timed out', { timeout: 5_000, cause: root });

        expect(error.cause).toBe(root);
        expect(error.data).toEqual({ timeout: 5_000 });
    });

    it('does not invent a cause for ordinary data bags', () => {
        const error = new SdkError(SdkErrorCode.RequestTimeout, 'timed out', { timeout: 5_000 });

        expect(error.cause).toBeUndefined();
        expect(error.data).toEqual({ timeout: 5_000 });
    });

    it('preserves SdkHttpError status data while allowing an options cause', () => {
        const root = new Error('socket hang up');
        const error = new SdkHttpError(
            SdkErrorCode.ClientHttpFailedToOpenStream,
            'stream failed',
            { status: 502, statusText: 'Bad Gateway' },
            { cause: root }
        );

        expect(error).toBeInstanceOf(SdkHttpError);
        expect(error.status).toBe(502);
        expect(error.cause).toBe(root);
    });
});
