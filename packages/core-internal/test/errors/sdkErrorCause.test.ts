import { describe, it, expect } from 'vitest';
import { SdkError, SdkErrorCode, SdkHttpError } from '../../src/index';

describe('SdkError cause chain', () => {
    it('forwards cause to Error.cause when passed via options', () => {
        const root = new TypeError('ENOTFOUND');
        const error = new SdkError(SdkErrorCode.EraNegotiationFailed, 'probe failed', undefined, {
            cause: root
        });

        expect(error.cause).toBe(root);
        expect(error.data).toBeUndefined();
    });

    it('keeps data and cause independent', () => {
        const root = new Error('connection refused');
        const error = new SdkError(
            SdkErrorCode.RequestTimeout,
            'timed out',
            { timeout: 5000 },
            {
                cause: root
            }
        );

        expect(error.cause).toBe(root);
        expect(error.data).toEqual({ timeout: 5000 });
    });

    it('leaves cause undefined when options are omitted', () => {
        const error = new SdkError(SdkErrorCode.NotConnected, 'not connected');
        expect(error.cause).toBeUndefined();
    });

    it('leaves cause undefined when only data is passed', () => {
        const error = new SdkError(SdkErrorCode.RequestTimeout, 'timed out', { timeout: 5000 });
        expect(error.cause).toBeUndefined();
    });
});

describe('SdkHttpError cause chain', () => {
    it('forwards cause through to Error.cause', () => {
        const root = new Error('socket hang up');
        const error = new SdkHttpError(
            SdkErrorCode.ClientHttpFailedToOpenStream,
            'stream failed',
            { status: 502, statusText: 'Bad Gateway' },
            { cause: root }
        );

        expect(error.cause).toBe(root);
        expect(error.status).toBe(502);
        expect(error.data.status).toBe(502);
    });

    it('leaves cause undefined when options are omitted', () => {
        const error = new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'auth failed', { status: 401 });

        expect(error.cause).toBeUndefined();
    });
});
