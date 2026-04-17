import { describe, expect, it, vi } from 'vitest';
import {
    ErrorCode,
    InvalidTokenError,
    McpError,
    OAuthError,
    OAuthErrorCode,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode,
    StreamableHTTPError
} from '../../src/exports/public/index.js';
import { CustomOAuthError, ServerError } from '../../src/errors/oauthErrorsCompat.js';

describe('v1-compat error aliases', () => {
    it('McpError / ErrorCode alias ProtocolError / ProtocolErrorCode (+ ConnectionClosed/RequestTimeout from SdkErrorCode)', () => {
        expect(McpError).toBe(ProtocolError);
        expect(ErrorCode.InvalidParams).toBe(ProtocolErrorCode.InvalidParams);
        expect(ErrorCode.ConnectionClosed).toBe(SdkErrorCode.ConnectionClosed);
        expect(ErrorCode.RequestTimeout).toBe(SdkErrorCode.RequestTimeout);
        const e = new McpError(ErrorCode.InvalidParams, 'x');
        expect(e).toBeInstanceOf(ProtocolError);
        expect(e.code).toBe(ProtocolErrorCode.InvalidParams);
    });

    it('OAuthError.errorCode getter returns .code (no warning)', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const e = new OAuthError(OAuthErrorCode.InvalidToken, 'bad');
        expect(e.errorCode).toBe(OAuthErrorCode.InvalidToken);
        expect(e.errorCode).toBe('invalid_token');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('InvalidTokenError is an OAuthError with .code = InvalidToken (no warning)', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const e = new InvalidTokenError('expired');
        expect(e).toBeInstanceOf(OAuthError);
        expect(e.code).toBe(OAuthErrorCode.InvalidToken);
        expect(e.message).toBe('expired');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('OAuth subclass class .name matches v1 named-declaration behavior', () => {
        expect(InvalidTokenError.name).toBe('InvalidTokenError');
        const e = new InvalidTokenError('expired');
        expect(e.name).toBe('InvalidTokenError');
        expect(e.constructor.name).toBe('InvalidTokenError');
    });

    it('OAuth subclasses are usable in type position (value + type binding like v1 classes)', () => {
        const e: InvalidTokenError = new InvalidTokenError('expired');
        const handle = (err: ServerError): string => err.code;
        expect(handle(new ServerError('boom'))).toBe('server_error');
        expect(e.code).toBe('invalid_token');
    });

    it('subclass static errorCode and toResponseObject() match v1 wire format', () => {
        expect(ServerError.errorCode).toBe('server_error');
        const e = new ServerError('boom');
        expect(e.toResponseObject()).toEqual({ error: 'server_error', error_description: 'boom' });
    });

    it('CustomOAuthError reads static errorCode from concrete subclass', () => {
        class MyError extends CustomOAuthError {
            static override errorCode = 'my_custom_code';
        }
        const e = new MyError('nope');
        expect(e).toBeInstanceOf(OAuthError);
        expect(e.code).toBe('my_custom_code');
    });

    it('StreamableHTTPError is an SdkError subclass with .status from data', () => {
        const e = new StreamableHTTPError(SdkErrorCode.ClientHttpFailedToOpenStream, 'Service Unavailable', { status: 503 });
        expect(e).toBeInstanceOf(SdkError);
        expect(e.code).toBe(SdkErrorCode.ClientHttpFailedToOpenStream);
        expect(e.status).toBe(503);
        expect(e.name).toBe('StreamableHTTPError');
    });
});
