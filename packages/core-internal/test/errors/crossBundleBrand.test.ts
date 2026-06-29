import { describe, expect, it, vi } from 'vitest';

import { OAuthError, OAuthErrorCode } from '../../src/auth/errors';
import { SdkError, SdkErrorCode, SdkHttpError } from '../../src/errors/sdkErrors';
import { ProtocolErrorCode } from '../../src/types/enums';
import {
    MissingRequiredClientCapabilityError,
    ProtocolError,
    ResourceNotFoundError,
    UnsupportedProtocolVersionError,
    UrlElicitationRequiredError
} from '../../src/types/errors';

// `@modelcontextprotocol/client` and `@modelcontextprotocol/server` each bundle their
// own copy of core-internal; `vi.resetModules()` + a dynamic import reproduces that
// dual-copy situation faithfully (separate class objects, shared registry symbol).
async function loadForeignCopies() {
    vi.resetModules();
    const sdkErrors = await import('../../src/errors/sdkErrors');
    const protocolErrors = await import('../../src/types/errors');
    const authErrors = await import('../../src/auth/errors');
    return { sdkErrors, protocolErrors, authErrors };
}

describe('cross-bundle error instanceof (branded)', () => {
    it('same-bundle instanceof keeps working for every class', () => {
        const http = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'boom', { status: 404 });
        expect(http instanceof SdkHttpError).toBe(true);
        expect(http instanceof SdkError).toBe(true);
        expect(http instanceof Error).toBe(true);

        const proto = new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad');
        expect(proto instanceof ProtocolError).toBe(true);

        const rnf = new ResourceNotFoundError('file:///missing');
        expect(rnf instanceof ResourceNotFoundError).toBe(true);
        expect(rnf instanceof ProtocolError).toBe(true);

        const oauth = new OAuthError(OAuthErrorCode.InvalidToken, 'nope');
        expect(oauth instanceof OAuthError).toBe(true);
    });

    it('hierarchies stay disjoint', () => {
        const sdk = new SdkError(SdkErrorCode.NotConnected, 'x');
        const proto = new ProtocolError(ProtocolErrorCode.InvalidParams, 'x');
        expect(sdk instanceof ProtocolError).toBe(false);
        expect(proto instanceof SdkError).toBe(false);
        expect(proto instanceof OAuthError).toBe(false);

        const rnf = new ResourceNotFoundError('file:///missing');
        expect(rnf instanceof UrlElicitationRequiredError).toBe(false);
        expect(rnf instanceof UnsupportedProtocolVersionError).toBe(false);
        expect(rnf instanceof MissingRequiredClientCapabilityError).toBe(false);
    });

    it('an instance from a second module copy satisfies instanceof against this copy (and vice versa)', async () => {
        const { sdkErrors, protocolErrors, authErrors } = await loadForeignCopies();

        // Sanity: these really are different class objects.
        expect(sdkErrors.SdkHttpError).not.toBe(SdkHttpError);
        expect(protocolErrors.ProtocolError).not.toBe(ProtocolError);

        const foreignHttp = new sdkErrors.SdkHttpError(sdkErrors.SdkErrorCode.ClientHttpAuthentication, '401', { status: 401 });
        expect(foreignHttp instanceof SdkHttpError).toBe(true);
        expect(foreignHttp instanceof SdkError).toBe(true);
        expect(foreignHttp instanceof ProtocolError).toBe(false);

        const localHttp = new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, '401', { status: 401 });
        expect(localHttp instanceof sdkErrors.SdkHttpError).toBe(true);
        expect(localHttp instanceof sdkErrors.SdkError).toBe(true);

        const foreignRnf = new protocolErrors.ResourceNotFoundError('file:///missing');
        expect(foreignRnf instanceof ResourceNotFoundError).toBe(true);
        expect(foreignRnf instanceof ProtocolError).toBe(true);
        expect(foreignRnf instanceof UrlElicitationRequiredError).toBe(false);

        const foreignPlainProto = new protocolErrors.ProtocolError(ProtocolErrorCode.InvalidParams, 'x');
        expect(foreignPlainProto instanceof ProtocolError).toBe(true);
        expect(foreignPlainProto instanceof ResourceNotFoundError).toBe(false);

        const foreignOauth = new authErrors.OAuthError(authErrors.OAuthErrorCode.InvalidGrant, 'x');
        expect(foreignOauth instanceof OAuthError).toBe(true);
        expect(foreignOauth instanceof SdkError).toBe(false);
    });

    it('ProtocolError.fromError from a second copy reconstructs instances this copy recognizes', async () => {
        const { protocolErrors } = await loadForeignCopies();
        const reconstructed = protocolErrors.ProtocolError.fromError(ProtocolErrorCode.InvalidParams, 'gone', {
            uri: 'file:///missing'
        });
        expect(reconstructed instanceof ResourceNotFoundError).toBe(true);
        expect(reconstructed instanceof ProtocolError).toBe(true);
    });

    it('user-defined subclasses keep plain prototype semantics (no cross-class false positives)', () => {
        class MyError extends ProtocolError {}
        const mine = new MyError(ProtocolErrorCode.InternalError, 'mine');
        expect(mine instanceof MyError).toBe(true);
        expect(mine instanceof ProtocolError).toBe(true);

        // A base-class instance — same or foreign bundle — must never satisfy the subclass.
        const base = new ProtocolError(ProtocolErrorCode.InternalError, 'base');
        expect(base instanceof MyError).toBe(false);
    });

    it('a foreign base instance does not satisfy a user-defined subclass of this copy', async () => {
        const { protocolErrors } = await loadForeignCopies();
        class MyError extends ProtocolError {}
        const foreignBase = new protocolErrors.ProtocolError(ProtocolErrorCode.InternalError, 'x');
        expect(foreignBase instanceof MyError).toBe(false);
    });

    it('does not leak the brand through enumeration or serialization', () => {
        const err = new SdkHttpError(SdkErrorCode.ClientHttpForbidden, 'nope', { status: 403 });
        expect(Object.keys(err)).not.toContain(expect.stringContaining('mcp'));
        const json = JSON.stringify({ ...err });
        expect(json).not.toContain('mcp.Sdk');
    });

    it('ignores a brand inherited via the prototype chain (prototype-pollution hardening)', () => {
        const BRANDS = Symbol.for('mcp.sdk.errorBrands');
        // A brand reachable only through the prototype chain must not count —
        // otherwise polluting a shared prototype would make arbitrary objects
        // satisfy instanceof against every branded class.
        const polluted = Object.create({ [BRANDS]: new Set(['mcp.SdkError', 'mcp.SdkHttpError']) }) as object;
        expect(polluted instanceof SdkError).toBe(false);
        expect(polluted instanceof SdkHttpError).toBe(false);

        // An own-property carrier (what stampErrorBrands produces) is honored.
        const own = Object.create(Error.prototype) as object;
        Object.defineProperty(own, BRANDS, { value: new Set(['mcp.SdkError']), enumerable: false });
        expect(own instanceof SdkError).toBe(true);
    });

    it('matches across versions by identity, not shape (contract lock)', () => {
        // Brand strings are version-less by design: an instance constructed by a
        // different SDK version cross-matches. instanceof implies identity, not
        // field shape - consumers read fields defensively.
        const BRANDS = Symbol.for('mcp.sdk.errorBrands');
        const olderAlpha = Object.create(Error.prototype) as { status?: number };
        Object.defineProperty(olderAlpha, BRANDS, { value: new Set(['mcp.SdkError', 'mcp.SdkHttpError']), enumerable: false });
        expect((olderAlpha as unknown) instanceof SdkHttpError).toBe(true);
        expect(olderAlpha.status).toBeUndefined();
    });

    it('does not throw on hostile proxies (falls back to prototype check)', () => {
        const hostile = new Proxy(
            {},
            {
                getOwnPropertyDescriptor() {
                    throw new Error('trap');
                }
            }
        );
        expect((hostile as unknown) instanceof SdkError).toBe(false);
    });

    it('tolerates primitives, null, and brandless objects', () => {
        for (const value of [null, undefined, 42, 'x', Symbol('s'), {}, new Error('plain')]) {
            expect((value as unknown) instanceof SdkError).toBe(false);
            expect((value as unknown) instanceof ProtocolError).toBe(false);
            expect((value as unknown) instanceof OAuthError).toBe(false);
        }
    });
});
