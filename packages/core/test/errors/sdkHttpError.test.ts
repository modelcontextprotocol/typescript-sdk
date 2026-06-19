import { describe, it, expect } from 'vitest';
import { SdkError, SdkErrorCode, SdkHttpError } from '../../src/index.js';

describe('SdkHttpError', () => {
    it('exposes status and statusText via getters', () => {
        const error = new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'Unauthorized', {
            status: 401,
            statusText: 'Unauthorized'
        });

        expect(error.status).toBe(401);
        expect(error.statusText).toBe('Unauthorized');
    });

    it('returns undefined for statusText when omitted', () => {
        const error = new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'auth failed', {
            status: 401
        });

        expect(error.status).toBe(401);
        expect(error.statusText).toBeUndefined();
    });

    it('is an instance of SdkError', () => {
        const error = new SdkHttpError(SdkErrorCode.ClientHttpForbidden, 'Forbidden', {
            status: 403,
            statusText: 'Forbidden'
        });

        expect(error).toBeInstanceOf(SdkError);
        expect(error).toBeInstanceOf(SdkHttpError);
    });

    it('preserves code and message from SdkError', () => {
        const error = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Not Implemented', {
            status: 501,
            statusText: 'Not Implemented'
        });

        expect(error.code).toBe(SdkErrorCode.ClientHttpNotImplemented);
        expect(error.message).toBe('Not Implemented');
        expect(error.name).toBe('SdkHttpError');
    });

    it('exposes extra data fields alongside status', () => {
        const error = new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'auth failed', {
            status: 401,
            statusText: 'Unauthorized',
            retryAfter: 30
        });

        expect(error.data.retryAfter).toBe(30);
        expect(error.status).toBe(401);
    });
});
