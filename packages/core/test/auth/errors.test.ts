import { describe, expect, it } from 'vitest';

import {
    CustomOAuthError,
    InvalidClientMetadataError,
    InvalidGrantError,
    isTransientOAuthError,
    OAUTH_ERRORS,
    OAuthError,
    oauthErrorFromCode,
    OAuthErrorCode,
    ServerError,
    TemporarilyUnavailableError,
    TooManyRequestsError
} from '../../src/auth/errors.js';

describe('oauthErrorFromCode', () => {
    it('returns the specific subclass for every known error code', () => {
        for (const code of Object.values(OAuthErrorCode)) {
            const error = oauthErrorFromCode(code, 'boom');
            expect(error).toBeInstanceOf(OAuthError);
            expect(error).toBeInstanceOf(OAUTH_ERRORS[code]);
            expect(error.code).toBe(code);
            expect(error.message).toBe('boom');
        }
    });

    it('returns a plain OAuthError preserving the raw code for unknown codes', () => {
        const error = oauthErrorFromCode('invalid_refresh_token', 'token rotated');
        expect(error).toBeInstanceOf(OAuthError);
        expect(error.constructor).toBe(OAuthError);
        expect(error.code).toBe('invalid_refresh_token');
    });

    it('passes errorUri through', () => {
        const error = oauthErrorFromCode(OAuthErrorCode.InvalidGrant, 'boom', 'https://example.com/error');
        expect(error.errorUri).toBe('https://example.com/error');
    });
});

describe('oauthErrorFromCode prototype-chain safety', () => {
    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('treats Object.prototype member %s as an unknown code', code => {
        const error = oauthErrorFromCode(code, 'server sent a hostile code');
        expect(error).toBeInstanceOf(OAuthError);
        expect(error.constructor).toBe(OAuthError);
        expect(error.code).toBe(code);
        expect(error.message).toContain('server sent a hostile code');
    });
});

describe('OAuthError.fromResponse', () => {
    it('produces subclass instances so 1.x instanceof checks keep working', () => {
        const error = OAuthError.fromResponse({ error: 'invalid_grant', error_description: 'expired' });
        expect(error).toBeInstanceOf(InvalidGrantError);
        expect(error.code).toBe(OAuthErrorCode.InvalidGrant);
        expect(error.message).toBe('expired');
    });

    it('preserves unknown codes on the base class', () => {
        const error = OAuthError.fromResponse({ error: 'consent_required' });
        expect(error.constructor).toBe(OAuthError);
        expect(error.code).toBe('consent_required');
    });
});

describe('deprecated 1.x subclasses', () => {
    it('construct with (message, errorUri) and carry the right code', () => {
        const error = new InvalidGrantError('expired', 'https://example.com/error');
        expect(error.code).toBe(OAuthErrorCode.InvalidGrant);
        expect(error.message).toBe('expired');
        expect(error.errorUri).toBe('https://example.com/error');
        expect(error).toBeInstanceOf(OAuthError);
    });

    it('keep name set to OAuthError for 2.x name-based checks', () => {
        expect(new InvalidClientMetadataError('bad').name).toBe('OAuthError');
    });

    it('CustomOAuthError carries an arbitrary code', () => {
        const error = new CustomOAuthError('weird_code', 'odd');
        expect(error.code).toBe('weird_code');
        expect(error).toBeInstanceOf(OAuthError);
    });

    it('expose the deprecated errorCode alias', () => {
        expect(new ServerError('boom').errorCode).toBe(OAuthErrorCode.ServerError);
        expect(new OAuthError('custom_thing', 'boom').errorCode).toBe('custom_thing');
    });

    it('OAUTH_ERRORS covers every OAuthErrorCode member', () => {
        for (const code of Object.values(OAuthErrorCode)) {
            expect(OAUTH_ERRORS[code]).toBeDefined();
        }
    });
});

describe('isTransientOAuthError', () => {
    it('is true for the RFC transient codes', () => {
        expect(isTransientOAuthError(new ServerError('boom'))).toBe(true);
        expect(isTransientOAuthError(new TemporarilyUnavailableError('busy'))).toBe(true);
        expect(isTransientOAuthError(new TooManyRequestsError('slow down'))).toBe(true);
    });

    it('is true for unknown codes (1.x collapsed them into ServerError, hence retryable)', () => {
        expect(isTransientOAuthError(oauthErrorFromCode('invalid_refresh_token', 'rotated'))).toBe(true);
        expect(isTransientOAuthError(new CustomOAuthError('proprietary_hiccup', 'try later'))).toBe(true);
    });

    it('is false for known permanent codes', () => {
        expect(isTransientOAuthError(oauthErrorFromCode(OAuthErrorCode.InvalidGrant, 'expired'))).toBe(false);
        expect(isTransientOAuthError(oauthErrorFromCode(OAuthErrorCode.AccessDenied, 'no'))).toBe(false);
    });

    it('is false for non-OAuth errors', () => {
        expect(isTransientOAuthError(new Error('boom'))).toBe(false);
        expect(isTransientOAuthError(undefined)).toBe(false);
    });
});
