import { describe, it, expect } from 'vitest';
import { SdkError, SdkErrorCode, SdkHttpError } from '../../src/index';

describe('SdkError cause forwarding (#2657)', () => {
    it('forwards a `cause` from the data slot to Error.cause', () => {
        const root = new Error('getaddrinfo ENOTFOUND does-not-resolve.invalid');
        const error = new SdkError(SdkErrorCode.EraNegotiationFailed, 'Version negotiation probe failed: fetch failed', {
            cause: root
        });

        // The standard `.cause` chain must reach the underlying error, so
        // pino/Sentry-style walkers surface the real failure.
        expect(error.cause).toBe(root);
    });

    it('still keeps the full object on `data` (does not move it out)', () => {
        const root = new Error('boom');
        const error = new SdkError(SdkErrorCode.EraNegotiationFailed, 'msg', { cause: root, extra: 1 });

        expect(error.cause).toBe(root);
        expect(error.data).toEqual({ cause: root, extra: 1 });
    });

    it('leaves cause undefined when data carries none', () => {
        const error = new SdkError(SdkErrorCode.NotConnected, 'Transport is not connected', {
            status: 401
        });

        expect(error.cause).toBeUndefined();
        expect(error.data).toEqual({ status: 401 });
    });

    it('leaves cause undefined when there is no data', () => {
        const error = new SdkError(SdkErrorCode.NotConnected, 'Transport is not connected');

        expect(error.cause).toBeUndefined();
    });

    it('does not treat an HTTP data payload as a cause', () => {
        const error = new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'Unauthorized', {
            status: 401,
            statusText: 'Unauthorized'
        });

        expect(error.cause).toBeUndefined();
        expect(error.status).toBe(401);
    });
});
