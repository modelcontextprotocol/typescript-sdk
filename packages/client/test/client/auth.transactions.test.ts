import type { StoredOAuthTokens } from '@modelcontextprotocol/core-internal';
import { OAuthErrorCode, OAuthErrorResponseSchema } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import type { AuthOptions, AuthResult, OAuthClientProvider } from '../../src/client/auth';
import { auth, IssuerMismatchError, parseErrorResponse } from '../../src/client/auth';

const issuer = 'https://auth.example.com';
const serverUrl = 'https://api.example.com/mcp';
const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256']
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(r => {
        resolve = r;
    });
    return { promise, resolve };
}

function fixture() {
    let tokens: StoredOAuthTokens | undefined = { access_token: 'expired', refresh_token: 'refresh-0', token_type: 'Bearer', issuer };
    const posts: URLSearchParams[] = [];
    const tokenResponse = vi.fn(
        async (): Promise<Response> =>
            Response.json({ access_token: 'fresh', refresh_token: `refresh-${posts.length}`, token_type: 'Bearer' })
    );
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname.includes('oauth-protected-resource')) {
            return Response.json({
                resource: `${url.origin}${url.pathname.replace('/.well-known/oauth-protected-resource', '')}`,
                authorization_servers: [issuer]
            });
        }
        if (url.pathname.includes('oauth-authorization-server')) return Response.json(metadata);
        if (url.href === `${issuer}/token`) {
            expect(init?.method).toBe('POST');
            posts.push(new URLSearchParams(init?.body as URLSearchParams));
            return tokenResponse();
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    const provider: OAuthClientProvider = {
        redirectUrl: 'https://client.example.com/callback',
        clientMetadata: { redirect_uris: ['https://client.example.com/callback'] },
        clientInformation: () => ({ client_id: 'client', issuer }),
        tokens: () => tokens,
        saveTokens: vi.fn(value => {
            tokens = value;
        }),
        invalidateCredentials: vi.fn(scope => {
            if (scope === 'tokens') tokens = undefined;
        }),
        redirectToAuthorization: vi.fn(),
        saveCodeVerifier: vi.fn(),
        codeVerifier: () => 'verifier'
    };
    const options: AuthOptions = { serverUrl, fetchFn };
    return { provider, options, posts, tokenResponse, fetchFn };
}

describe('OAuth error response boundary', () => {
    it.each(['string', 'Response'])('accepts a null description from %s without relaxing the public schema', async kind => {
        const body = { error: 'invalid_grant', error_description: null };
        expect(OAuthErrorResponseSchema.safeParse(body).success).toBe(false);
        const error = await parseErrorResponse(kind === 'string' ? JSON.stringify(body) : Response.json(body, { status: 400 }));
        expect(error.code).toBe(OAuthErrorCode.InvalidGrant);
    });

    it.each([
        null,
        [],
        [{ error: 'invalid_grant', error_description: null }],
        { error: null, error_description: null },
        { error: 'invalid_grant', error_description: 42 },
        { error: 'invalid_grant', error_description: null, error_uri: 42 }
    ])('keeps malformed payloads as ServerError: %j', async body => {
        expect((await parseErrorResponse(JSON.stringify(body))).code).toBe(OAuthErrorCode.ServerError);
    });
});

describe('auth transactions', () => {
    it('recovers concurrent invalid_grant-null callers within one complete transaction', async () => {
        const { provider, options, posts, tokenResponse } = fixture();
        const events: string[] = [];
        let active = false;
        provider.withAuthTransaction = async operation => {
            events.push('enter');
            active = true;
            try {
                return await operation();
            } finally {
                active = false;
                events.push('exit');
            }
        };
        const invalidate = provider.invalidateCredentials!;
        provider.invalidateCredentials = vi.fn(async scope => {
            expect(active).toBe(true);
            events.push(`invalidate:${scope}`);
            await invalidate(scope);
        });
        provider.redirectToAuthorization = vi.fn(() => {
            expect(active).toBe(true);
            events.push('redirect');
        });
        tokenResponse.mockImplementation(async () => {
            expect(active).toBe(true);
            events.push('refresh');
            return Response.json({ error: 'invalid_grant', error_description: null }, { status: 400 });
        });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(Promise.all([auth(provider, options), auth(provider, options), auth(provider, options)])).resolves.toEqual([
                'REDIRECT',
                'REDIRECT',
                'REDIRECT'
            ]);
        } finally {
            warning.mockRestore();
        }
        expect(posts).toHaveLength(1);
        expect(posts[0]!.get('grant_type')).toBe('refresh_token');
        expect(provider.invalidateCredentials).toHaveBeenCalledExactlyOnceWith('tokens');
        expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['enter', 'refresh', 'invalidate:tokens', 'redirect', 'exit']);
    });

    it.each([false, true])('refreshes with transaction hook present=%s', async present => {
        const { provider, options, posts } = fixture();
        let active = false;
        const hook = vi.fn(async (operation: () => Promise<AuthResult>) => {
            active = true;
            try {
                return await operation();
            } finally {
                active = false;
            }
        });
        if (present) provider.withAuthTransaction = hook;
        const save = provider.saveTokens;
        provider.saveTokens = value => {
            expect(active).toBe(present);
            return save(value);
        };
        await expect(Promise.all([auth(provider, options), auth(provider, options)])).resolves.toEqual(['AUTHORIZED', 'AUTHORIZED']);
        expect(posts).toHaveLength(1);
        expect(hook).toHaveBeenCalledTimes(present ? 1 : 0);
        expect(active).toBe(false);
    });

    it('releases the transaction after callback failure and permits the next call', async () => {
        const { provider, options } = fixture();
        const failure = new Error('save failed');
        const save = provider.saveTokens;
        provider.saveTokens = vi.fn().mockRejectedValueOnce(failure).mockImplementation(save);
        const events: string[] = [];
        provider.withAuthTransaction = async operation => {
            events.push('enter');
            try {
                return await operation();
            } finally {
                events.push('exit');
            }
        };
        await expect(auth(provider, options)).rejects.toBe(failure);
        await expect(auth(provider, options)).resolves.toBe('AUTHORIZED');
        expect(events).toEqual(['enter', 'exit', 'enter', 'exit']);
    });

    it.each([{ authorizationCode: 'code' }, { forceReauthorization: true }])(
        'bypass runs its own transaction without waiting for ordinary auth: %j',
        async bypass => {
            const { provider, options, tokenResponse, posts } = fixture();
            // Supply the callback's persisted issuer binding, without affecting discovery on ordinary calls.
            provider.discoveryState = () => ({
                authorizationServerUrl: issuer,
                authorizationServerMetadata: metadata,
                resourceMetadata: { resource: serverUrl, authorization_servers: [issuer] }
            });
            const started = deferred();
            const release = deferred();
            tokenResponse.mockImplementationOnce(async () => {
                started.resolve();
                await release.promise;
                return Response.json({ access_token: 'fresh', token_type: 'Bearer' });
            });
            const hook = vi.fn(async (operation: () => Promise<AuthResult>) => operation());
            provider.withAuthTransaction = hook;
            const pending = auth(provider, options);
            await started.promise;
            try {
                await expect(auth(provider, { ...options, ...bypass })).resolves.toBe(
                    'authorizationCode' in bypass ? 'AUTHORIZED' : 'REDIRECT'
                );
                expect(hook).toHaveBeenCalledTimes(2);
                if ('authorizationCode' in bypass) expect(posts[1]!.get('code')).toBe('code');
                else expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
            } finally {
                release.resolve();
                await pending;
            }
        }
    );
});

describe('ordinary auth option compatibility', () => {
    it('shares equivalent URL strings and effective false validation options', async () => {
        const { provider, options, posts } = fixture();
        await Promise.all([
            auth(provider, options),
            auth(provider, { ...options, serverUrl: new URL(serverUrl), skipIssuerMetadataValidation: false })
        ]);
        expect(posts).toHaveLength(1);
    });

    it.each(['resource', 'scope', 'metadata URL', 'fetch identity'])(
        'serializes different %s options and reads freshly stored tokens',
        async difference => {
            const { provider, options, posts, fetchFn, tokenResponse } = fixture();
            const started = deferred();
            const release = deferred();
            tokenResponse.mockImplementationOnce(async () => {
                started.resolve();
                await release.promise;
                return Response.json({ access_token: 'fresh', refresh_token: 'rotated', token_type: 'Bearer' });
            });
            const other: AuthOptions = { ...options };
            if (difference === 'resource') other.serverUrl = 'https://api.example.com/other';
            if (difference === 'scope') other.scope = 'extra';
            if (difference === 'metadata URL')
                other.resourceMetadataUrl = new URL('https://api.example.com/.well-known/oauth-protected-resource/mcp?version=2');
            const otherFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => fetchFn(input, init));
            if (difference === 'fetch identity') other.fetchFn = otherFetch;
            const first = auth(provider, options);
            await started.promise;
            const second = auth(provider, other);
            const sharedSecond = auth(provider, { ...other });
            expect(posts).toHaveLength(1);
            release.resolve();
            await expect(Promise.all([first, second, sharedSecond])).resolves.toEqual(['AUTHORIZED', 'AUTHORIZED', 'AUTHORIZED']);
            expect(posts).toHaveLength(2);
            expect(posts[1]!.get('refresh_token')).toBe('rotated');
            expect(posts[1]!.get('resource')).toBe(difference === 'resource' ? 'https://api.example.com/other' : serverUrl);
            if (difference === 'metadata URL') {
                expect(fetchFn.mock.calls.some(([input]) => String(input) === other.resourceMetadataUrl!.href)).toBe(true);
            }
            if (difference === 'fetch identity') {
                expect(otherFetch.mock.calls.some(([input]) => String(input) === `${issuer}/token`)).toBe(true);
            }
        }
    );

    it('does not let an opt-out caller suppress issuer validation for a queued strict caller', async () => {
        const { provider, options, fetchFn, posts } = fixture();
        const originalFetch = fetchFn.getMockImplementation()!;
        fetchFn.mockImplementation(async (input, init) =>
            String(input).includes('oauth-authorization-server')
                ? Response.json({ ...metadata, issuer: 'https://different.example.com' })
                : originalFetch(input, init)
        );
        provider.clientInformation = () => ({ client_id: 'client', issuer: 'https://different.example.com' });
        provider.tokens = () => ({
            access_token: 'expired',
            refresh_token: 'refresh',
            token_type: 'Bearer',
            issuer: 'https://different.example.com'
        });
        const results = await Promise.allSettled([
            auth(provider, { ...options, skipIssuerMetadataValidation: true }),
            auth(provider, options)
        ]);
        expect(results[0]).toEqual({ status: 'fulfilled', value: 'AUTHORIZED' });
        expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(IssuerMismatchError) });
        expect(posts).toHaveLength(1);
    });

    it('preserves each queued scope when initiating authorization', async () => {
        const { provider, options } = fixture();
        provider.tokens = () => undefined;
        await expect(
            Promise.all([auth(provider, { ...options, scope: 'read' }), auth(provider, { ...options, scope: 'write' })])
        ).resolves.toEqual(['REDIRECT', 'REDIRECT']);
        const redirects = vi.mocked(provider.redirectToAuthorization).mock.calls;
        expect(redirects.map(([url]) => url.searchParams.get('scope'))).toEqual(['read', 'write']);
    });

    it('keeps a queued operation shareable after the earlier entry cleans up', async () => {
        const { provider, options, posts, tokenResponse } = fixture();
        const secondStarted = deferred();
        const releaseSecond = deferred();
        tokenResponse.mockImplementationOnce(async () =>
            Response.json({ access_token: 'fresh', refresh_token: 'rotated', token_type: 'Bearer' })
        );
        tokenResponse.mockImplementationOnce(async () => {
            secondStarted.resolve();
            await releaseSecond.promise;
            return Response.json({ access_token: 'fresh', token_type: 'Bearer' });
        });
        const first = auth(provider, options);
        const other = { ...options, scope: 'other' };
        const second = auth(provider, other);
        await first;
        await secondStarted.promise;
        const third = auth(provider, other);
        releaseSecond.resolve();
        await expect(Promise.all([second, third])).resolves.toEqual(['AUTHORIZED', 'AUTHORIZED']);
        expect(posts).toHaveLength(2);
    });

    it('executes queued options after rejection and clears the final rejected entry', async () => {
        const { provider, options, posts } = fixture();
        const failure = new Error('storage failed');
        const save = provider.saveTokens;
        provider.saveTokens = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockImplementation(save);
        const results = await Promise.allSettled([auth(provider, options), auth(provider, { ...options, scope: 'other' })]);
        expect(results).toEqual([
            { status: 'rejected', reason: failure },
            { status: 'rejected', reason: failure }
        ]);
        expect(posts).toHaveLength(2);
        await expect(auth(provider, { ...options, scope: 'other' })).resolves.toBe('AUTHORIZED');
        expect(posts).toHaveLength(3);
    });
});
