import type { FetchLike } from '@modelcontextprotocol/core-internal';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthProvider, OAuthClientProvider } from '../../src/client/auth';
import { DpopSession } from '../../src/client/dpop';
import { withDpop } from '../../src/client/middleware';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';

function decodeJwtPart(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function proofOf(call: unknown[]): Record<string, unknown> {
    return decodeJwtPart(new Headers((call[1] as RequestInit).headers).get('DPoP')!.split('.')[1]!);
}

const nonceChallenge = (nonce?: string) =>
    new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', ...(nonce ? { 'DPoP-Nonce': nonce } : {}) }
    });

/**
 * These tests drive the transport with a real {@linkcode DpopSession} behind an
 * {@linkcode OAuthClientProvider} and assert on what reaches `fetch` — the transport applies DPoP by
 * wrapping its resource-server fetch with `withDpopFromProvider`, so the wire is the contract.
 */
describe('StreamableHTTPClientTransport — DPoP', () => {
    const url = new URL('http://localhost:1234/mcp');
    let session: DpopSession;
    let provider: OAuthClientProvider & { tokens: Mock };
    let transport: StreamableHTTPClientTransport;
    let fetchSpy: Mock<typeof fetch>;

    const authProviderOf = (t: StreamableHTTPClientTransport) => (t as unknown as { _authProvider: AuthProvider })._authProvider;

    beforeEach(async () => {
        session = await DpopSession.create();
        provider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            clientInformation: vi.fn(),
            tokens: vi.fn().mockResolvedValue({ access_token: 'tok-1', token_type: 'DPoP' }),
            saveTokens: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn(),
            dpop: () => session
        };
        fetchSpy = vi.spyOn(globalThis, 'fetch');
        transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    });

    afterEach(async () => {
        await transport.close().catch(() => {});
        vi.restoreAllMocks();
    });

    it('presents Authorization: DPoP + a proof bound to POST and the MCP URL', async () => {
        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        const headers = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
        expect(headers.get('Authorization')).toBe('DPoP tok-1');
        expect(proofOf(fetchSpy.mock.calls[0]!)).toMatchObject({ htm: 'POST', htu: url.href });
        expect(proofOf(fetchSpy.mock.calls[0]!).ath).toBeDefined();
    });

    it('binds the GET SSE stream proof to GET', async () => {
        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 405 }));

        await (transport as unknown as { _startOrAuthSse: (o: object) => Promise<void> })._startOrAuthSse({});

        expect(proofOf(fetchSpy.mock.calls[0]!)).toMatchObject({ htm: 'GET', htu: url.href });
    });

    it('binds the session-termination proof to DELETE, and retries DELETE once on a use_dpop_nonce challenge', async () => {
        (transport as unknown as { _sessionId?: string })._sessionId = 'sess-1';
        fetchSpy.mockResolvedValueOnce(nonceChallenge('rs-nonce-1')).mockResolvedValueOnce(new Response(null, { status: 200 }));

        await expect(transport.terminateSession()).resolves.toBeUndefined();

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(proofOf(fetchSpy.mock.calls[0]!)).toMatchObject({ htm: 'DELETE', htu: url.href });
        expect(proofOf(fetchSpy.mock.calls[1]!)).toMatchObject({ htm: 'DELETE', nonce: 'rs-nonce-1' });
    });

    it('presents a token_type=Bearer token with the Bearer scheme and no proof, even though dpop() resolves (RFC 9449 §7.1)', async () => {
        provider.tokens.mockResolvedValue({ access_token: 'tok-1', token_type: 'Bearer' });
        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        const headers = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
        expect(headers.get('Authorization')).toBe('Bearer tok-1');
        expect(headers.has('DPoP')).toBe(false);
    });

    it("a caller-supplied per-request 'dpop' header cannot override the transport's own proof (reserved header name)", async () => {
        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));

        await transport.send(
            { jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' },
            { headers: { dpop: 'attacker-supplied-proof', DPoP: 'attacker-supplied-proof-2' } }
        );

        expect(proofOf(fetchSpy.mock.calls[0]!).htm).toBe('POST');
    });

    it('retries once on a use_dpop_nonce challenge with a fresh proof carrying the nonce, without re-authorizing', async () => {
        const onUnauthorized = vi.spyOn(authProviderOf(transport), 'onUnauthorized');
        fetchSpy.mockResolvedValueOnce(nonceChallenge('rs-nonce-1')).mockResolvedValueOnce(new Response(null, { status: 202 }));

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const [first, second] = fetchSpy.mock.calls.map(c => proofOf(c));
        expect(second!.nonce).toBe('rs-nonce-1');
        expect(second!.jti).not.toBe(first!.jti); // RFC 9449 §4.2: never replay the original proof
        expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it('does not spend the nonce retry on a use_dpop_nonce challenge that carries no fresh DPoP-Nonce', async () => {
        session.rememberNonce(url, 'stale-nonce');
        const onUnauthorized = vi.spyOn(authProviderOf(transport), 'onUnauthorized').mockResolvedValue();
        fetchSpy.mockResolvedValueOnce(nonceChallenge()).mockResolvedValueOnce(new Response(null, { status: 202 }));

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        // Straight to the credential path: challenge → onUnauthorized → one retry.
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('bounds retries when the nonce challenge never clears: a nonce retry per attempt, one credential retry, then throws', async () => {
        const onUnauthorized = vi.spyOn(authProviderOf(transport), 'onUnauthorized').mockResolvedValue();
        fetchSpy.mockImplementation(async () => nonceChallenge('rs-nonce-1'));

        await expect(transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' })).rejects.toThrow();

        // attempt 1 (+ its nonce retry) → onUnauthorized → attempt 2 (+ its nonce retry) → give up.
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('handles a credential 401 first and a nonce challenge on the re-authorized retry (auth/dpop-nonce shape)', async () => {
        const onUnauthorized = vi.spyOn(authProviderOf(transport), 'onUnauthorized').mockResolvedValue();
        fetchSpy
            .mockResolvedValueOnce(new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="invalid_token"' } }))
            .mockResolvedValueOnce(nonceChallenge('rs-nonce-1'))
            .mockResolvedValueOnce(new Response(null, { status: 202 }));

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        expect(proofOf(fetchSpy.mock.calls[2]!).nonce).toBe('rs-nonce-1');
    });

    it('carries a DPoP-Nonce received on a 2xx response into the next request’s proof (RFC 9449 §8.2)', async () => {
        fetchSpy
            .mockResolvedValueOnce(new Response(null, { status: 202, headers: { 'DPoP-Nonce': 'rs-nonce-1' } }))
            .mockResolvedValueOnce(new Response(null, { status: 202 }));

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });
        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-2' });

        expect(proofOf(fetchSpy.mock.calls[1]!).nonce).toBe('rs-nonce-1');
    });

    it('wraps a caller-supplied fetch (it still runs, and sees the DPoP headers)', async () => {
        const customFetch = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 202 }));
        const t = new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: customFetch });

        await t.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(new Headers(customFetch.mock.calls[0]![1]!.headers).get('Authorization')).toBe('DPoP tok-1');
        await t.close();
    });

    it('leaves a plain AuthProvider untouched (Bearer via token()); DPoP there is opt-in via fetch: withDpop(...)', async () => {
        fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));

        const bearer = new StreamableHTTPClientTransport(url, { authProvider: { token: async () => 'bearer-tok' } });
        await bearer.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });
        expect(new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers).get('Authorization')).toBe('Bearer bearer-tok');
        expect(new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers).has('DPoP')).toBe(false);
        await bearer.close();

        const explicit = new StreamableHTTPClientTransport(url, {
            authProvider: { token: async () => 'pop-tok' },
            fetch: withDpop(session, () => 'pop-tok')(fetch)
        });
        await explicit.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-2' });
        expect(new Headers((fetchSpy.mock.calls[1]![1] as RequestInit).headers).get('Authorization')).toBe('DPoP pop-tok');
        expect(proofOf(fetchSpy.mock.calls[1]!)).toMatchObject({ htm: 'POST', htu: url.href });
        await explicit.close();
    });
});
