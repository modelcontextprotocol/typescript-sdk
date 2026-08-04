/**
 * Fault injection per transport auth seam, adapted from the PR #2564
 * neutral-review measurement harness: each scenario drives negotiateEra()
 * with a REAL StreamableHTTPClientTransport and a mocked fetch, so the full
 * transport 401/403 handling and auth() flow execute for real.
 *
 * The invariant under test: any error escaping a stamped auth seam reaches
 * the caller IDENTITY-PRESERVED (same object; instanceof and diagnostics
 * intact) as an auth outcome — never a legacy verdict (the probe's browser
 * CORS row must not consume auth-flow TypeErrors), never a rewrap. Errors
 * thrown outside the stamped seams keep their pre-existing behavior.
 */
import { OAuthError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import type { AuthProvider, OAuthClientProvider } from '../../src/client/auth';
import { UnauthorizedError } from '../../src/client/auth';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';
import { negotiateEra } from '../../src/client/versionNegotiation';

const SERVER = 'https://server.example.com/mcp';
const AS = 'https://auth.example.com';

const AS_METADATA = {
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    registration_endpoint: `${AS}/register`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256']
};

function freshProvider(): OAuthClientProvider {
    return {
        get redirectUrl() {
            return 'http://localhost:3000/callback';
        },
        get clientMetadata() {
            return { redirect_uris: ['http://localhost:3000/callback'] };
        },
        clientInformation: () => undefined,
        saveClientInformation: () => {},
        tokens: () => undefined,
        saveTokens: () => {},
        redirectToAuthorization: () => {},
        saveCodeVerifier: () => {},
        codeVerifier: () => 'verifier'
    };
}

/** fetch mock: 401 wall on the MCP endpoint, real discovery, DCR delegated. */
function authWallFetch(onRegister: () => Promise<Response>): typeof fetch {
    return (async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        if (url.href === SERVER || url.pathname === '/mcp') {
            return new Response('Unauthorized', {
                status: 401,
                headers: {
                    'WWW-Authenticate': `Bearer resource_metadata="https://server.example.com/.well-known/oauth-protected-resource/mcp"`
                }
            });
        }
        if (url.pathname.includes('oauth-protected-resource')) {
            return Response.json({ resource: SERVER, authorization_servers: [AS] });
        }
        if (url.pathname.includes('oauth-authorization-server') || url.pathname.includes('openid-configuration')) {
            return Response.json(AS_METADATA);
        }
        if (url.pathname === '/register') {
            return onRegister();
        }
        return new Response('Not Found', { status: 404 });
    }) as typeof fetch;
}

async function runProbe(transport: StreamableHTTPClientTransport, environment: 'node' | 'browser') {
    return negotiateEra(
        { kind: 'auto', modernVersions: ['2026-07-28'], fallbackAvailable: true, probe: {} },
        {
            transport,
            clientInfo: { name: 'seam-test', version: '0' },
            capabilities: {},
            environment,
            transportKind: 'http',
            defaultTimeoutMs: 3000
        }
    ).then(
        result => ({ settled: 'resolved' as const, result, error: undefined as unknown }),
        (error: unknown) => ({ settled: 'rejected' as const, result: undefined, error })
    );
}

describe('stamped-seam fault injection (identity-preserving auth outcomes, never legacy)', () => {
    test('DCR POST throws TypeError inside the SDK auth flow — browser: the raw TypeError propagates, no CORS-legacy verdict', async () => {
        const dcrError = new TypeError('Failed to fetch');
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
            authProvider: freshProvider(),
            fetch: authWallFetch(() => Promise.reject(dcrError))
        });
        const out = await runProbe(transport, 'browser');
        expect(out.settled).toBe('rejected');
        expect(out.error).toBe(dcrError);
    });

    test('DCR POST throws TypeError — node: same raw propagation, no network-error rewrap', async () => {
        const dcrError = new TypeError('Failed to fetch');
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
            authProvider: freshProvider(),
            fetch: authWallFetch(() => Promise.reject(dcrError))
        });
        const out = await runProbe(transport, 'node');
        expect(out.settled).toBe('rejected');
        expect(out.error).toBe(dcrError);
    });

    test("401 persists after re-auth: the transport's ClientHttpAuthentication diagnostic reaches the caller intact", async () => {
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
            authProvider: {
                token: async () => 'stale-token',
                onUnauthorized: async () => {}
            },
            fetch: authWallFetch(() => Promise.resolve(new Response(null, { status: 500 })))
        });
        const out = await runProbe(transport, 'node');
        expect(out.settled).toBe('rejected');
        expect(out.error).toBeInstanceOf(SdkHttpError);
        expect((out.error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpAuthentication);
        expect((out.error as Error).message).toContain('after re-authentication');
    });

    test('403 insufficient_scope with no provider to drive step-up: the raw InsufficientScopeError propagates', async () => {
        const fetchMock = (async (input: string | URL | Request): Promise<Response> => {
            const url = new URL(String(input instanceof Request ? input.url : input));
            if (url.href === SERVER || url.pathname === '/mcp') {
                return new Response('Forbidden', {
                    status: 403,
                    headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="mcp:tools"' }
                });
            }
            return new Response('Not Found', { status: 404 });
        }) as typeof fetch;
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), { fetch: fetchMock });
        const out = await runProbe(transport, 'node');
        expect(out.settled).toBe('rejected');
        expect((out.error as Error).name).toBe('InsufficientScopeError');
        expect((out.error as Error).message).toContain('mcp:tools');
    });

    test('user callback (clientInformation) throws a custom class inside auth(): the raw instance propagates — instanceof works', async () => {
        class UserDbError extends Error {
            override readonly name = 'UserDbError';
        }
        const userError = new UserDbError('user db exploded');
        const provider = freshProvider();
        provider.clientInformation = () => {
            throw userError;
        };
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
            authProvider: provider,
            fetch: authWallFetch(() => Promise.resolve(new Response(null, { status: 500 })))
        });
        const out = await runProbe(transport, 'node');
        expect(out.settled).toBe('rejected');
        expect(out.error).toBe(userError);
        expect(out.error).toBeInstanceOf(UserDbError);
    });

    test('token endpoint rejects with a non-recoverable OAuthError: the raw OAuthError (code intact) propagates', async () => {
        const fetchMock = (async (input: string | URL | Request): Promise<Response> => {
            const url = new URL(String(input instanceof Request ? input.url : input));
            if (url.href === SERVER || url.pathname === '/mcp') {
                return new Response('Unauthorized', {
                    status: 401,
                    headers: {
                        'WWW-Authenticate': `Bearer resource_metadata="https://server.example.com/.well-known/oauth-protected-resource/mcp"`
                    }
                });
            }
            if (url.pathname.includes('oauth-protected-resource')) {
                return Response.json({ resource: SERVER, authorization_servers: [AS] });
            }
            if (url.pathname.includes('oauth-authorization-server') || url.pathname.includes('openid-configuration')) {
                return Response.json(AS_METADATA);
            }
            if (url.pathname === '/token') {
                return Response.json({ error: 'invalid_scope', error_description: 'scope not granted' }, { status: 400 });
            }
            return new Response('Not Found', { status: 404 });
        }) as typeof fetch;
        const provider = freshProvider();
        provider.clientInformation = () => ({ client_id: 'abc', issuer: AS });
        provider.tokens = () => ({ access_token: 'tok', refresh_token: 'rt', token_type: 'Bearer', issuer: AS });
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), { authProvider: provider, fetch: fetchMock });
        const out = await runProbe(transport, 'node');
        expect(out.settled).toBe('rejected');
        expect(out.error).toBeInstanceOf(OAuthError);
        expect((out.error as OAuthError).code).toBe('invalid_scope');
    });

    test('healthy flow ending in REDIRECT: UnauthorizedError propagates (the finishAuth contract)', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
            authProvider: freshProvider(),
            fetch: authWallFetch(() =>
                Promise.resolve(Response.json({ client_id: 'abc', redirect_uris: ['http://localhost:3000/callback'] }, { status: 201 }))
            )
        });
        const out = await runProbe(transport, 'node');
        expect(out.settled).toBe('rejected');
        expect(out.error).toBeInstanceOf(UnauthorizedError);
    });

    test('R6: token() throws at the _commonHeaders read — browser: raw TypeError propagates, never the CORS-legacy verdict', async () => {
        const tokenError = new TypeError("Cannot read properties of undefined (reading 'access_token')");
        const provider: AuthProvider = {
            token: () => {
                throw tokenError;
            }
        };
        let fetched = 0;
        const fetchMock = (async (): Promise<Response> => {
            fetched++;
            return new Response(null, { status: 500 });
        }) as typeof fetch;
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), { authProvider: provider, fetch: fetchMock });
        const out = await runProbe(transport, 'browser');
        expect(out.settled).toBe('rejected');
        expect(out.error).toBe(tokenError);
        // The failure happened before any network I/O — nothing was fetched,
        // and in particular no legacy initialize followed.
        expect(fetched).toBe(0);
    });

    test('B12: a CUSTOM onUnauthorized callback throws TypeError — browser: raw propagation, never the CORS-legacy verdict', async () => {
        const cbError = new TypeError('custom re-auth crashed');
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
            authProvider: {
                token: async () => undefined,
                onUnauthorized: async () => {
                    throw cbError;
                }
            },
            fetch: authWallFetch(() => Promise.resolve(new Response(null, { status: 500 })))
        });
        const out = await runProbe(transport, 'browser');
        expect(out.settled).toBe('rejected');
        expect(out.error).toBe(cbError);
    });

    test('B11 regression pin: on the NON-probe path a throwing custom onUnauthorized propagates the raw instance from send()', async () => {
        class CallbackError extends Error {
            override readonly name = 'CallbackError';
        }
        const cbError = new CallbackError('boom');
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
            authProvider: {
                token: async () => undefined,
                onUnauthorized: async () => {
                    throw cbError;
                }
            },
            fetch: authWallFetch(() => Promise.resolve(new Response(null, { status: 500 })))
        });
        await transport.start();
        const rejection = await transport
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
            .then(() => {
                throw new Error('send unexpectedly resolved');
            })
            .catch((e: unknown) => e);
        // Identity preserved: the stamp is a non-enumerable marker, not a wrap.
        expect(rejection).toBe(cbError);
        expect(rejection).toBeInstanceOf(CallbackError);
        await transport.close();
    });

    test('control: an error thrown outside every auth seam (the probe POST itself failing) stays a typed negotiation error', async () => {
        const netError = new Error('socket hang up');
        const fetchMock = (async (): Promise<Response> => {
            throw netError;
        }) as typeof fetch;
        const transport = new StreamableHTTPClientTransport(new URL(SERVER), { fetch: fetchMock });
        const out = await runProbe(transport, 'node');
        expect(out.settled).toBe('rejected');
        expect(out.error).toBeInstanceOf(SdkError);
        expect((out.error as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect(((out.error as SdkError).data as { cause?: unknown }).cause).toBe(netError);
    });
});
