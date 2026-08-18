import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthProvider, AuthRequestContext } from '../../src/client/auth';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';

/**
 * A minimal `AuthProvider` (not `OAuthClientProvider`) so these tests exercise the transport's own
 * `_commonHeaders`/401-handling wiring directly, independent of `adaptOAuthProvider` (covered by
 * `auth.dpop.test.ts`) and `withDpop` (covered by `middleware.dpop.test.ts`).
 */
function createDpopAuthProvider(): AuthProvider & { authorizeRequest: Mock; consumeChallenge: Mock; onUnauthorized: Mock } {
    return {
        token: vi.fn().mockResolvedValue(undefined),
        authorizeRequest: vi.fn(async (ctx: AuthRequestContext) => ({
            Authorization: 'DPoP the-access-token',
            DPoP: `proof-for-${ctx.method}-${ctx.url.pathname}`
        })),
        consumeChallenge: vi.fn().mockResolvedValue(false),
        onUnauthorized: vi.fn().mockResolvedValue(undefined)
    };
}

describe('StreamableHTTPClientTransport — DPoP', () => {
    let transport: StreamableHTTPClientTransport;
    let authProvider: ReturnType<typeof createDpopAuthProvider>;

    beforeEach(() => {
        authProvider = createDpopAuthProvider();
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });
        vi.spyOn(globalThis, 'fetch');
    });

    afterEach(async () => {
        await transport.close().catch(() => {});
        vi.clearAllMocks();
    });

    it('presents DPoP Authorization + a per-request proof on POST, keyed to the request', async () => {
        (globalThis.fetch as Mock).mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(authProvider.authorizeRequest).toHaveBeenCalledWith({ method: 'POST', url: new URL('http://localhost:1234/mcp') });
        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        const headers = init.headers as Headers;
        expect(headers.get('Authorization')).toBe('DPoP the-access-token');
        expect(headers.get('DPoP')).toBe('proof-for-POST-/mcp');
    });

    it('presents a proof on the GET SSE stream, keyed to GET (not POST)', async () => {
        (globalThis.fetch as Mock).mockResolvedValueOnce({ ok: false, status: 405, headers: new Headers(), text: async () => '' });

        await (transport as unknown as { _startOrAuthSse: (o: object) => Promise<void> })._startOrAuthSse({});

        expect(authProvider.authorizeRequest).toHaveBeenCalledWith({ method: 'GET', url: new URL('http://localhost:1234/mcp') });
        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect((init.headers as Headers).get('DPoP')).toBe('proof-for-GET-/mcp');
    });

    it('presents a proof on session termination (DELETE)', async () => {
        // A session id is required for terminateSession to send anything.
        (transport as unknown as { _sessionId?: string })._sessionId = 'sess-1';
        (globalThis.fetch as Mock).mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), text: async () => '' });

        await transport.terminateSession();

        expect(authProvider.authorizeRequest).toHaveBeenCalledWith({ method: 'DELETE', url: new URL('http://localhost:1234/mcp') });
    });

    it("a caller-supplied per-request 'dpop' header cannot override the transport's own proof (reserved header name)", async () => {
        (globalThis.fetch as Mock).mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        await transport.send(
            { jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' },
            { headers: { dpop: 'attacker-supplied-proof', DPoP: 'attacker-supplied-proof-2' } }
        );

        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect((init.headers as Headers).get('DPoP')).toBe('proof-for-POST-/mcp');
    });

    it('falls back to Bearer + token() when the provider has no authorizeRequest (plain AuthProvider back-compat)', async () => {
        const bearerProvider: AuthProvider = { token: vi.fn().mockResolvedValue('bearer-tok') };
        const bearerTransport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider: bearerProvider });
        (globalThis.fetch as Mock).mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        await bearerTransport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect((init.headers as Headers).get('Authorization')).toBe('Bearer bearer-tok');
        expect((init.headers as Headers).has('DPoP')).toBe(false);
        await bearerTransport.close();
    });

    it('retries once on a use_dpop_nonce challenge, independent of the (already-spent) auth retry budget', async () => {
        const nonceChallenge = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: new Headers({ 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'rs-nonce-1' }),
            text: async () => ''
        };
        // consumeChallenge is only "retry-worthy" (true) on this specific 401; the credential-401
        // path (onUnauthorized) must never see it.
        authProvider.consumeChallenge.mockImplementation(async (res: Response) => res.status === 401 && res.headers.has('dpop-nonce'));

        (globalThis.fetch as Mock)
            .mockResolvedValueOnce(nonceChallenge) // first attempt: nonce challenge
            .mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() }); // retry: succeeds

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(authProvider.consumeChallenge).toHaveBeenCalledTimes(1);
        expect(authProvider.onUnauthorized).not.toHaveBeenCalled();
    });

    it('bounds retries when the nonce challenge never clears (no infinite loop)', async () => {
        const nonceChallenge = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: new Headers({ 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'rs-nonce-1' }),
            text: async () => ''
        };
        authProvider.consumeChallenge.mockResolvedValue(true); // always "retry-worthy" — must still be bounded
        (globalThis.fetch as Mock).mockResolvedValue(nonceChallenge);

        await expect(transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' })).rejects.toThrow();

        // The nonce-retry budget (1) is spent after the 2nd attempt; the 3rd attempt falls through
        // to the ordinary credential-retry path (onUnauthorized, isAuthRetry) since a persistent
        // nonce challenge is indistinguishable from a broken server at that point — that path's
        // own single-retry budget is what finally throws. Total: initial + nonce retry + auth
        // retry = 3, not unbounded.
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
        expect(authProvider.onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('the nonce-challenge leg runs before, and does not consume, onUnauthorized on the post-auth-retry leg', async () => {
        // Sequence: first request -> ordinary 401 (credential failure) -> onUnauthorized runs ->
        // retried request -> a *nonce* 401 this time (server now demands a nonce) -> nonce retry -> success.
        // This is exactly the auth/dpop-nonce conformance scenario's shape.
        const credentialChallenge = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: new Headers({ 'WWW-Authenticate': 'DPoP error="invalid_token"' }),
            text: async () => ''
        };
        const nonceChallenge = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: new Headers({ 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'rs-nonce-1' }),
            text: async () => ''
        };
        authProvider.consumeChallenge.mockImplementation(async (res: Response) => res.headers.has('dpop-nonce'));

        (globalThis.fetch as Mock)
            .mockResolvedValueOnce(credentialChallenge)
            .mockResolvedValueOnce(nonceChallenge)
            .mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
        expect(authProvider.onUnauthorized).toHaveBeenCalledTimes(1);
        expect(authProvider.consumeChallenge).toHaveBeenCalledTimes(2);
    });
});
