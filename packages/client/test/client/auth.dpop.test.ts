import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OAuthClientProvider } from '../../src/client/auth';
import { auth, executeTokenRequest, extractWWWAuthenticateParams } from '../../src/client/auth';
import { createPrivateKeyJwtAuth } from '../../src/client/authExtensions';
import { DpopSession } from '../../src/client/dpop';

function decodeJwtPart(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('executeTokenRequest — DPoP', () => {
    let session: DpopSession;
    let fetchFn: Mock;

    beforeEach(async () => {
        session = await DpopSession.create();
        fetchFn = vi.fn();
    });

    it('signs a DPoP proof into the token request DPoP header', async () => {
        fetchFn.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ access_token: 'tok', token_type: 'DPoP' })
        });

        await executeTokenRequest('https://as.example.com', {
            tokenRequestParams: new URLSearchParams({ grant_type: 'client_credentials' }),
            dpop: session,
            fetchFn
        });

        const [, init] = fetchFn.mock.calls[0]!;
        const headers = init.headers as Headers;
        const proof = headers.get('DPoP');
        expect(proof).toBeTruthy();
        const payload = decodeJwtPart(proof!.split('.')[1]!);
        expect(payload.htm).toBe('POST');
        expect(payload.htu).toBe('https://as.example.com/token');
        // No `ath`: the token request presents credentials to *obtain* a token, not an existing one.
        expect(payload.ath).toBeUndefined();
    });

    it('retries once with a fresh nonce-carrying proof on a 400 use_dpop_nonce challenge', async () => {
        fetchFn
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                headers: new Headers({ 'DPoP-Nonce': 'as-nonce-1' }),
                clone() {
                    return this;
                },
                json: async () => ({ error: 'use_dpop_nonce' })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({ access_token: 'tok', token_type: 'DPoP' })
            });

        const tokens = await executeTokenRequest('https://as.example.com', {
            tokenRequestParams: new URLSearchParams({ grant_type: 'client_credentials' }),
            dpop: session,
            fetchFn
        });

        expect(tokens.access_token).toBe('tok');
        expect(fetchFn).toHaveBeenCalledTimes(2);
        const secondProof = (fetchFn.mock.calls[1]![1].headers as Headers).get('DPoP');
        const firstProof = (fetchFn.mock.calls[0]![1].headers as Headers).get('DPoP');
        expect(secondProof).not.toBe(firstProof); // fresh jti — never resend the identical proof
        expect(decodeJwtPart(secondProof!.split('.')[1]!).nonce).toBe('as-nonce-1');
        // The session also remembers the nonce for future requests to this origin.
        expect(session.nonceFor('https://as.example.com')).toBe('as-nonce-1');
    });

    it('does not retry a second time (surfaces the error) when the nonce challenge repeats', async () => {
        // A real Response (not a plain mock object): parseErrorResponse — reached once the single
        // retry is exhausted and the challenge repeats — branches on `instanceof Response`.
        fetchFn.mockImplementation(async () =>
            Response.json(
                { error: 'use_dpop_nonce' },
                {
                    status: 400,
                    headers: { 'DPoP-Nonce': 'as-nonce-1' }
                }
            )
        );

        await expect(
            executeTokenRequest('https://as.example.com', {
                tokenRequestParams: new URLSearchParams({ grant_type: 'client_credentials' }),
                dpop: session,
                fetchFn
            })
        ).rejects.toMatchObject({ code: 'use_dpop_nonce' });
        // Exactly one retry: the initial nonce-less attempt, and one retry carrying the nonce.
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('re-runs addClientAuthentication for the nonce retry so a private_key_jwt client_assertion is not replayed', async () => {
        const addClientAuthentication = createPrivateKeyJwtAuth({
            issuer: 'client-1',
            subject: 'client-1',
            privateKey: 'a-string-secret-at-least-256-bits-long',
            alg: 'HS256'
        });
        const assertions: string[] = [];
        fetchFn.mockImplementation(async (_url: URL, init: RequestInit) => {
            assertions.push((init.body as URLSearchParams).get('client_assertion')!);
            return assertions.length === 1
                ? Response.json({ error: 'use_dpop_nonce' }, { status: 400, headers: { 'DPoP-Nonce': 'as-nonce-1' } })
                : Response.json({ access_token: 'tok', token_type: 'DPoP' });
        });

        await executeTokenRequest('https://as.example.com', {
            tokenRequestParams: new URLSearchParams({ grant_type: 'client_credentials' }),
            addClientAuthentication,
            dpop: session,
            fetchFn
        });

        expect(assertions).toHaveLength(2);
        // RFC 7521 §5.2 / RFC 7523 §3: an AS MAY enforce one-time use of assertions keyed on jti.
        const [first, second] = assertions.map(a => decodeJwtPart(a.split('.')[1]!));
        expect(second!.jti).not.toBe(first!.jti);
    });

    it('is unaffected when no dpop session is supplied (plain OAuth token requests keep working)', async () => {
        fetchFn.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ access_token: 'tok', token_type: 'Bearer' })
        });

        await executeTokenRequest('https://as.example.com', {
            tokenRequestParams: new URLSearchParams({ grant_type: 'client_credentials' }),
            fetchFn
        });

        const [, init] = fetchFn.mock.calls[0]!;
        expect((init.headers as Headers).has('DPoP')).toBe(false);
    });
});

describe('auth() refresh — DPoP', () => {
    const mockFetch = vi.fn();
    let session: DpopSession;
    let provider: OAuthClientProvider;
    let tokenResponse: () => Response;

    beforeEach(async () => {
        mockFetch.mockReset();
        vi.stubGlobal('fetch', mockFetch);
        session = await DpopSession.create();
        const tokens = vi.fn().mockResolvedValue({ access_token: 'old', token_type: 'DPoP', refresh_token: 'rt-1' });
        provider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            clientInformation: vi.fn().mockResolvedValue({ client_id: 'client-1' }),
            tokens,
            saveTokens: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn(),
            invalidateCredentials: vi.fn(async scope => {
                if (scope === 'tokens' || scope === 'all') tokens.mockResolvedValue(undefined);
            }),
            dpop: () => session
        };
        mockFetch.mockImplementation(async (url: URL | string) => {
            const urlString = url.toString();
            if (urlString.includes('/.well-known/oauth-authorization-server')) {
                return Response.json({
                    issuer: 'https://api.example.com',
                    authorization_endpoint: 'https://api.example.com/authorize',
                    token_endpoint: 'https://api.example.com/token',
                    response_types_supported: ['code'],
                    dpop_signing_alg_values_supported: ['ES256']
                });
            }
            if (urlString === 'https://api.example.com/token') return tokenResponse();
            return new Response(null, { status: 404 });
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('signs a DPoP proof into the refresh_token grant request', async () => {
        tokenResponse = () => Response.json({ access_token: 'new', token_type: 'DPoP', refresh_token: 'rt-2' });

        await expect(auth(provider, { serverUrl: 'https://api.example.com/mcp' })).resolves.toBe('AUTHORIZED');

        const [, init] = mockFetch.mock.calls.find(c => c[0].toString() === 'https://api.example.com/token')!;
        expect((init.body as URLSearchParams).get('grant_type')).toBe('refresh_token');
        const proof = new Headers(init.headers).get('DPoP');
        expect(decodeJwtPart(proof!.split('.')[1]!).htu).toBe('https://api.example.com/token');
    });

    it('falls back to a fresh authorization when the AS rejects the refresh with invalid_dpop_proof', async () => {
        // e.g. the (non-extractable) DPoP key was regenerated across a restart while the persisted
        // refresh token is still bound to the old key (RFC 9449 §5) — refreshing can never succeed.
        tokenResponse = () => Response.json({ error: 'invalid_dpop_proof', error_description: 'key mismatch' }, { status: 400 });

        await expect(auth(provider, { serverUrl: 'https://api.example.com/mcp' })).resolves.toBe('REDIRECT');
        expect(provider.invalidateCredentials).toHaveBeenCalledWith('tokens');
        expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
    });
});

describe('extractWWWAuthenticateParams — DPoP scheme', () => {
    it('extracts resource_metadata from a DPoP challenge (not just Bearer)', () => {
        const response = new Response(null, {
            headers: {
                'WWW-Authenticate':
                    'DPoP error="invalid_token", resource_metadata="https://example.com/.well-known/oauth-protected-resource"'
            }
        });
        const { resourceMetadataUrl, error } = extractWWWAuthenticateParams(response);
        expect(resourceMetadataUrl?.toString()).toBe('https://example.com/.well-known/oauth-protected-resource');
        expect(error).toBe('invalid_token');
    });

    it('extracts scope from a DPoP insufficient_scope challenge (SEP-2350 step-up for DPoP resources)', () => {
        const response = new Response(null, {
            headers: { 'WWW-Authenticate': 'DPoP error="insufficient_scope", scope="admin"' }
        });
        expect(extractWWWAuthenticateParams(response).scope).toBe('admin');
    });

    it('still returns {} for an unrecognized scheme', () => {
        const response = new Response(null, { headers: { 'WWW-Authenticate': 'Digest realm="x"' } });
        expect(extractWWWAuthenticateParams(response)).toEqual({});
    });
});
