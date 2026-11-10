import type { FetchLike, StoredOAuthTokens } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import type { OAuthClientProvider, OAuthDiscoveryState } from '../../src/client/auth';
import { auth, discoverOAuthProtectedResourceMetadata, discoverOAuthServerInfo, selectResourceURL } from '../../src/client/auth';

const SERVER = 'https://resource.example/mcp/tenant';
const ROOT = 'https://resource.example';
const PRM = `${ROOT}/.well-known/oauth-protected-resource`;
const CHALLENGE = `${ROOT}/metadata`;
const ISSUER = 'https://auth.example';
const AS_METADATA = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256']
};
const metadata = (resource: string) => ({ resource, authorization_servers: [ISSUER] });

function createProvider(initialState?: OAuthDiscoveryState) {
    let state = initialState;
    let tokens: StoredOAuthTokens | undefined;
    const provider = {
        redirectUrl: 'http://localhost/callback',
        clientMetadata: { redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' },
        clientInformation: vi.fn(() => ({ client_id: 'client', issuer: ISSUER })),
        tokens: vi.fn(() => tokens),
        saveTokens: vi.fn((value: StoredOAuthTokens) => {
            tokens = value;
        }),
        redirectToAuthorization: vi.fn(),
        saveCodeVerifier: vi.fn(),
        codeVerifier: vi.fn(() => 'verifier'),
        discoveryState: vi.fn(() => state),
        saveDiscoveryState: vi.fn((value: OAuthDiscoveryState) => {
            state = JSON.parse(JSON.stringify(value));
        })
    } satisfies OAuthClientProvider;
    return provider;
}

describe('RFC 9728 protected resource identity (#3077)', () => {
    it.each([
        ['challenge parent', SERVER, `${ROOT}/mcp`, true],
        ['challenge root', SERVER, ROOT, true],
        ['path-aware parent', SERVER, `${ROOT}/mcp`, false],
        ['query mismatch', `${ROOT}/mcp?tenant=a`, `${ROOT}/mcp?tenant=b`, true],
        ['different origin', SERVER, 'https://other.example/mcp/tenant', true],
        ['sibling', SERVER, `${ROOT}/mcp/other`, true],
        ['non-segment prefix', SERVER, `${ROOT}/mc`, true],
        ['extra trailing slash', SERVER, `${SERVER}/`, true],
        ['missing trailing slash', `${SERVER}/`, SERVER, true],
        ['dot segment', SERVER, `${ROOT}/mcp/./tenant`, true],
        ['encoded segment', SERVER, `${ROOT}/mcp/%74enant`, true],
        ['challenge backslash in authority', SERVER, `${ROOT}\\other/mcp/tenant`, true],
        ['path-aware backslash in authority', SERVER, `${ROOT}\\other/mcp/tenant`, false],
        ['fragment', SERVER, `${SERVER}#fragment`, true]
    ])('rejects %s before using metadata or invoking provider hooks', async (_, serverUrl, resource, challenge) => {
        const provider = { ...createProvider(), validateResourceURL: vi.fn().mockResolvedValue(new URL(SERVER)) };
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(Response.json(metadata(resource as string)));

        await expect(
            auth(provider, {
                serverUrl: serverUrl as string,
                ...(challenge ? { resourceMetadataUrl: new URL(CHALLENGE) } : {}),
                fetchFn
            })
        ).rejects.toThrow('does not match expected');

        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(provider.saveDiscoveryState).not.toHaveBeenCalled();
        expect(provider.clientInformation).not.toHaveBeenCalled();
        expect(provider.validateResourceURL).not.toHaveBeenCalled();
        expect(provider.redirectToAuthorization).not.toHaveBeenCalled();
        expect(provider.saveTokens).not.toHaveBeenCalled();
    });

    it('rejects a root document claiming a non-root resource', async () => {
        const fetchFn = vi
            .fn<FetchLike>()
            .mockResolvedValueOnce(new Response(null, { status: 404 }))
            .mockResolvedValueOnce(Response.json(metadata(`${ROOT}/mcp`)));
        await expect(discoverOAuthServerInfo(SERVER, { fetchFn })).rejects.toThrow('does not match expected');
        expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([`${PRM}/mcp/tenant`, PRM]);
    });

    it('preserves a trailing path slash in the PRM discovery URL', async () => {
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(Response.json(metadata(`${SERVER}/`)));
        await expect(discoverOAuthProtectedResourceMetadata(`${SERVER}/`, undefined, fetchFn)).resolves.toEqual(metadata(`${SERVER}/`));
        expect(String(fetchFn.mock.calls[0]![0])).toBe(`${PRM}/mcp/tenant/`);
    });

    it.each(['challenge', 'path', 'root'] as const)(
        'preserves resource through authorization, cached code exchange and refresh: %s',
        async route => {
            const resource = route === 'root' ? ROOT : SERVER;
            const provider = createProvider();
            const fetchFn = vi.fn<FetchLike>(async input => {
                const url = String(input);
                if (url === `${ISSUER}/token`)
                    return Response.json({ access_token: 'token', token_type: 'Bearer', refresh_token: 'refresh' });
                if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return Response.json(AS_METADATA);
                if (route === 'root' && url === `${PRM}/mcp/tenant`) return new Response(null, { status: 404 });
                if (url === (route === 'challenge' ? CHALLENGE : route === 'root' ? PRM : `${PRM}/mcp/tenant`))
                    return Response.json(metadata(resource));
                throw new Error(`Unexpected request: ${url}`);
            });
            const options = { serverUrl: SERVER, fetchFn, ...(route === 'challenge' ? { resourceMetadataUrl: new URL(CHALLENGE) } : {}) };
            await expect(auth(provider, options)).resolves.toBe('REDIRECT');
            const authorizationUrl = provider.redirectToAuthorization.mock.calls[0]![0] as URL;
            expect(authorizationUrl.searchParams.get('resource')).toBe(resource);
            expect(provider.discoveryState()?.resourceMetadataRootFallback).toBe(route === 'root' ? true : undefined);

            fetchFn.mockClear();
            await expect(auth(provider, { serverUrl: SERVER, fetchFn, authorizationCode: 'code' })).resolves.toBe('AUTHORIZED');
            await expect(auth(provider, { serverUrl: SERVER, fetchFn })).resolves.toBe('AUTHORIZED');
            expect(fetchFn).toHaveBeenCalledTimes(2);
            for (const [url, init] of fetchFn.mock.calls) {
                expect(String(url)).toBe(`${ISSUER}/token`);
                expect(new URLSearchParams(init?.body as string).get('resource')).toBe(resource);
            }
            expect(new URLSearchParams(fetchFn.mock.calls[1]![1]?.body as string).get('grant_type')).toBe('refresh_token');
        }
    );

    it.each([
        { resourceMetadata: metadata(`${ROOT}/mcp`) },
        { resourceMetadata: metadata(`${ROOT}\\other/mcp/tenant`) },
        { resourceMetadata: metadata('https://other.example'), resourceMetadataRootFallback: true }
    ])('rejects invalid cached metadata before any network request', async cached => {
        const provider = createProvider({ authorizationServerUrl: ISSUER, ...cached });
        const fetchFn = vi.fn<FetchLike>();
        await expect(auth(provider, { serverUrl: SERVER, fetchFn })).rejects.toThrow('does not match expected');
        expect(fetchFn).not.toHaveBeenCalled();
        expect(provider.saveDiscoveryState).not.toHaveBeenCalled();
    });

    it('does not let cached root provenance bypass a new challenge', async () => {
        const provider = createProvider({
            authorizationServerUrl: ISSUER,
            resourceMetadata: metadata(ROOT),
            resourceMetadataRootFallback: true
        });
        const fetchFn = vi.fn<FetchLike>();
        await expect(auth(provider, { serverUrl: SERVER, resourceMetadataUrl: new URL(CHALLENGE), fetchFn })).rejects.toThrow(
            'does not match expected'
        );
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('validates fetched PRM before enriching a partial discovery cache', async () => {
        const provider = createProvider({ authorizationServerUrl: ISSUER });
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(Response.json(metadata(`${ROOT}/mcp`)));
        await expect(auth(provider, { serverUrl: SERVER, fetchFn })).rejects.toThrow('does not match expected');
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(provider.saveDiscoveryState).not.toHaveBeenCalled();
    });

    it.each([true, false])('rediscovers an old root cache instead of assuming its source (valid: %s)', async valid => {
        const provider = createProvider({
            authorizationServerUrl: ISSUER,
            resourceMetadata: metadata(ROOT),
            authorizationServerMetadata: AS_METADATA
        });
        const fetchFn = vi.fn<FetchLike>(async input => {
            const url = String(input);
            if (url === `${PRM}/mcp/tenant`) return valid ? new Response(null, { status: 404 }) : Response.json(metadata(ROOT));
            if (url === PRM) return Response.json(metadata(ROOT));
            if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return Response.json(AS_METADATA);
            throw new Error(`Unexpected request: ${url}`);
        });
        if (valid) {
            await expect(auth(provider, { serverUrl: SERVER, fetchFn })).resolves.toBe('REDIRECT');
            expect(provider.discoveryState()?.resourceMetadataRootFallback).toBe(true);
            expect(fetchFn).toHaveBeenCalledTimes(3);
        } else {
            await expect(auth(provider, { serverUrl: SERVER, fetchFn })).rejects.toThrow('does not match expected');
            expect(provider.saveDiscoveryState).not.toHaveBeenCalled();
            expect(fetchFn).toHaveBeenCalledTimes(1);
        }
    });

    it('keeps the original server URL for custom resource selection after root discovery', async () => {
        const validateResourceURL = vi.fn().mockResolvedValue(undefined);
        const provider = {
            ...createProvider({
                authorizationServerUrl: ISSUER,
                authorizationServerMetadata: AS_METADATA,
                resourceMetadata: metadata(ROOT),
                resourceMetadataRootFallback: true
            }),
            validateResourceURL
        };
        await expect(auth(provider, { serverUrl: SERVER, fetchFn: vi.fn<FetchLike>() })).resolves.toBe('REDIRECT');
        expect(validateResourceURL).toHaveBeenCalledWith(new URL(SERVER), ROOT);
    });

    it('validates identity for direct selectResourceURL callers too', async () => {
        await expect(selectResourceURL(SERVER, createProvider(), metadata(`${ROOT}/mcp`))).rejects.toThrow('does not match expected');
        await expect(selectResourceURL(SERVER, createProvider(), metadata(SERVER))).resolves.toEqual(new URL(SERVER));
    });

    it.each([`${ROOT}\\other/mcp/tenant`, `${ROOT}\\/mcp/tenant`])(
        'rejects ambiguous authority boundaries in direct resource selection: %s',
        async resource => {
            await expect(selectResourceURL(SERVER, createProvider(), metadata(resource))).rejects.toThrow('does not match expected');
        }
    );

    it('accepts a pathless resource with a query without rewriting it', async () => {
        const resource = 'HTTPS://RESOURCE.example?tenant=a';
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(Response.json(metadata(resource)));
        await expect(discoverOAuthProtectedResourceMetadata(`${ROOT}?tenant=a`, undefined, fetchFn)).resolves.toEqual(metadata(resource));
        expect(String(fetchFn.mock.calls[0]![0])).toBe(`${PRM}?tenant=a`);
    });

    it('accepts authority case and the empty root path without rewriting the selected indicator', async () => {
        const resource = 'https://RESOURCE.example:443';
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(Response.json(metadata(resource)));
        await expect(discoverOAuthProtectedResourceMetadata(ROOT, undefined, fetchFn)).resolves.toEqual(metadata(resource));
    });
});
