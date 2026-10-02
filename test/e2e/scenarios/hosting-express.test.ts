/**
 * Self-contained test bodies for Express-bound hosting surfaces.
 *
 * These tests cover the SDK's Express-bound surface (auth middleware/routers, host
 * validation, createMcpExpressApp) over real HTTP — the layer a server operator
 * deploys and remote clients depend on; Client/Server are not the subject.
 *
 * The SDK's requireBearerAuth, mcpAuthRouter, mcpAuthMetadataRouter, and host-
 * header validation middleware are Express RequestHandlers; they cannot be
 * exercised with in-process Web-standard Request/Response. These tests build
 * real Express apps, listen on ephemeral ports (127.0.0.1), drive them with
 * fetch(), and assert exact HTTP status + header + body shapes.
 *
 * Function names mirror the requirement id in camelCase. NO casts, exact
 * assertions, closure recorders outside factories (for stateless compat),
 * minimal comments, every server closed in finally.
 */

import crypto from 'node:crypto';
import http from 'node:http';

import express, { type RequestHandler } from 'express';
import { expect } from 'vitest';

import { requireBearerAuth } from '../../../src/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter, mcpAuthMetadataRouter, createOAuthMetadata } from '../../../src/server/auth/router.js';
import { ProxyOAuthServerProvider } from '../../../src/server/auth/providers/proxyProvider.js';
import type { OAuthServerProvider } from '../../../src/server/auth/provider.js';
import { InvalidGrantError, InvalidTokenError } from '../../../src/server/auth/errors.js';
import { createMcpExpressApp } from '../../../src/server/express.js';
import type { OAuthClientInformationFull } from '../../../src/shared/auth.js';

import type { TestArgs } from '../types.js';
import { startExpressMinimal, startExpressWithHostValidation, type ExpressHost } from '../helpers/express.js';
import { verifies } from '../helpers/verifies.js';

const RESOURCE_METADATA_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource';
const VALID_TOKEN = 'analytics-dashboard-token';
const EXPIRED_TOKEN = 'expired-access-token';
const MALFORMED_TOKEN = 'not-a-valid-jwt';

/**
 * POST `body` to `url` via `node:http`, forcing `Host: <host>`.
 * Unlike undici fetch(), node:http sends caller-supplied Host header verbatim.
 */
function postWithHost(url: URL, host: string, body: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    Host: host,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'Content-Length': Buffer.byteLength(body)
                }
            },
            res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => (data += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

verifies('hosting:auth:missing-401', async (_args: TestArgs) => {
    const verifier = { verifyAccessToken: async (_token: string) => ({ token: '', clientId: 'test', scopes: [], expiresAt: 1e12 }) };

    await using host = await startExpressMinimal(requireBearerAuth({ verifier, resourceMetadataUrl: RESOURCE_METADATA_URL }));

    const res = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error="invalid_token"');
    expect(wwwAuth).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);

    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_token');
});

verifies('hosting:auth:invalid-401', async (_args: TestArgs) => {
    const verifier = {
        verifyAccessToken: async (token: string) => {
            if (token === MALFORMED_TOKEN) throw new InvalidTokenError('Token verification failed');
            return { token, clientId: 'test', scopes: [], expiresAt: 1e12 };
        }
    };

    await using host = await startExpressMinimal(requireBearerAuth({ verifier }));

    const res = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${MALFORMED_TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error="invalid_token"');
});

verifies('hosting:auth:expired-401', async (_args: TestArgs) => {
    const PAST_EXPIRY = 1;
    const verifier = {
        verifyAccessToken: async (token: string) => ({
            token,
            clientId: 'test-client',
            scopes: [],
            expiresAt: token === EXPIRED_TOKEN ? PAST_EXPIRY : Date.now() / 1000 + 3600
        })
    };

    await using host = await startExpressMinimal(requireBearerAuth({ verifier }));

    const res = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${EXPIRED_TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toContain('error="invalid_token"');
});

verifies('hosting:auth:scope-403', async (_args: TestArgs) => {
    const verifier = {
        verifyAccessToken: async (token: string) => ({
            token,
            clientId: 'test-client',
            scopes: token === VALID_TOKEN ? ['mcp:tools:read'] : ['mcp:tools:call'],
            expiresAt: Date.now() / 1000 + 3600
        })
    };

    await using host = await startExpressMinimal(
        requireBearerAuth({
            verifier,
            requiredScopes: ['mcp:tools:read', 'mcp:tools:call'],
            resourceMetadataUrl: RESOURCE_METADATA_URL
        })
    );

    const res = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${VALID_TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(res.status).toBe(403);

    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error="insufficient_scope"');
    expect(wwwAuth).toContain('scope="mcp:tools:read mcp:tools:call"');
    expect(wwwAuth).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);

    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('insufficient_scope');
});

verifies('hosting:auth:aud-validation', async (_args: TestArgs) => {
    const SERVER_RESOURCE_ID = 'https://mcp.example.com/api';
    const WRONG_AUDIENCE = 'https://other.example.com/api';

    const verifier = {
        verifyAccessToken: async (token: string) => {
            const aud = token === 'wrong-aud-token' ? WRONG_AUDIENCE : SERVER_RESOURCE_ID;
            return {
                token,
                clientId: 'test-client',
                scopes: [],
                expiresAt: Date.now() / 1000 + 3600,
                resource: new URL(aud)
            };
        }
    };

    const app = express();
    app.use(express.json());
    app.use(requireBearerAuth({ verifier, resourceMetadataUrl: SERVER_RESOURCE_ID }));
    app.post('/mcp', (_req, res) => {
        res.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    });

    await using host = await startExpressMinimal(app);

    const wrongAud = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: 'Bearer wrong-aud-token'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(wrongAud.status).toBeGreaterThanOrEqual(401);
    expect(wrongAud.status).toBeLessThanOrEqual(403);

    const wwwAuth = wrongAud.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error=');

    const body = (await wrongAud.json()) as { error?: string };
    expect(body.error).toBeTruthy();
});

verifies('hosting:auth:metadata-endpoints', async (_args: TestArgs) => {
    const issuer = new URL('https://auth.example.com');
    const provider = {
        authorize: async () => {
            throw new Error('not needed');
        },
        challengeForAuthorizationCode: async () => 'test-challenge',
        exchangeAuthorizationCode: async () => ({ access_token: 'test-token', token_type: 'Bearer' }),
        exchangeRefreshToken: async () => ({ access_token: 'test-token', token_type: 'Bearer' }),
        verifyAccessToken: async () => ({ token: '', clientId: '', scopes: [], expiresAt: 1e12 }),
        clientsStore: { getClient: async () => undefined }
    };

    const app = express();
    app.use(express.json());
    app.use(
        mcpAuthRouter({
            provider,
            issuerUrl: issuer
        })
    );

    await using host = await startExpressMinimal(app);

    const asMetadata = await fetch(new URL('/.well-known/oauth-authorization-server', host.baseUrl));
    expect(asMetadata.status).toBe(200);
    const asBody = (await asMetadata.json()) as { issuer?: string; authorization_endpoint?: string };
    expect(asBody.issuer).toBe(issuer.href);
    expect(asBody.authorization_endpoint).toBeTruthy();

    const prmMetadata = await fetch(new URL('/.well-known/oauth-protected-resource', host.baseUrl));
    expect(prmMetadata.status).toBe(200);
    const prmBody = (await prmMetadata.json()) as { resource?: string; authorization_servers?: string[] };
    expect(prmBody.authorization_servers).toContain(issuer.href);
});

verifies('hosting:auth:prm:authorization-servers-field', async (_args: TestArgs) => {
    const issuer = new URL('https://auth.example.com');
    const oauthMetadata = createOAuthMetadata({
        provider: {
            authorize: async () => {
                throw new Error('stub');
            },
            challengeForAuthorizationCode: async () => 'test',
            exchangeAuthorizationCode: async () => ({ access_token: 'test', token_type: 'Bearer' }),
            exchangeRefreshToken: async () => ({ access_token: 'test', token_type: 'Bearer' }),
            verifyAccessToken: async () => ({ token: '', clientId: '', scopes: [], expiresAt: 1e12 }),
            clientsStore: { getClient: async () => undefined }
        },
        issuerUrl: issuer
    });

    const app = express();
    app.use(
        mcpAuthMetadataRouter({
            oauthMetadata,
            resourceServerUrl: new URL('https://mcp.example.com')
        })
    );

    await using host = await startExpressMinimal(app);

    const res = await fetch(new URL('/.well-known/oauth-protected-resource', host.baseUrl));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_servers?: string[] };
    expect(body.authorization_servers).toBeInstanceOf(Array);
    expect(body.authorization_servers?.length).toBeGreaterThan(0);
    expect(body.authorization_servers).toContain(issuer.href);
});

verifies('hosting:auth:as-router', async (_args: TestArgs) => {
    const issuer = new URL('https://auth.example.com');
    const provider: OAuthServerProvider = {
        authorize: async (_client, _params, res) => {
            res.redirect(302, 'https://example.com/callback?code=test-code&state=test');
        },
        challengeForAuthorizationCode: async () => 'test-challenge',
        exchangeAuthorizationCode: async () => ({ access_token: 'test-token', token_type: 'Bearer' }),
        exchangeRefreshToken: async () => ({ access_token: 'test-token', token_type: 'Bearer' }),
        verifyAccessToken: async (token: string) => ({ token, clientId: 'test', scopes: [], expiresAt: 1e12 }),
        clientsStore: {
            getClient: async (id: string) =>
                id === 'test-client'
                    ? ({
                          client_id: 'test-client',
                          client_secret: 'secret',
                          redirect_uris: ['https://example.com/callback']
                      } as OAuthClientInformationFull)
                    : undefined,
            registerClient: async () =>
                ({
                    client_id: 'new-client',
                    client_secret: 'new-secret',
                    redirect_uris: ['https://example.com/callback']
                }) as OAuthClientInformationFull
        },
        revokeToken: async () => {}
    };

    const app = express();
    app.use(express.json());
    app.use(mcpAuthRouter({ provider, issuerUrl: issuer }));

    await using host = await startExpressMinimal(app);

    const authRes = await fetch(new URL('/authorize', host.baseUrl));
    expect(authRes.status).not.toBe(404);

    const tokenRes = await fetch(new URL('/token', host.baseUrl), { method: 'POST' });
    expect(tokenRes.status).not.toBe(404);

    const registerRes = await fetch(new URL('/register', host.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://example.com/callback'] })
    });
    expect(registerRes.status).not.toBe(404);
    const registerBody = (await registerRes.json()) as { client_id?: string };
    expect(registerBody.client_id).toBeTruthy();

    const revokeRes = await fetch(new URL('/revoke', host.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token=old-token&client_id=test-client&client_secret=secret'
    });
    expect([200, 400]).toContain(revokeRes.status);
});

verifies('hosting:auth:proxy-provider', async (_args: TestArgs) => {
    const upstreamRequests: Array<{ url: string; method: string; body?: string }> = [];

    const upstreamAS = express();
    upstreamAS.use(express.json());
    upstreamAS.use(express.urlencoded({ extended: true }));
    upstreamAS.get('/authorize', (req, res) => {
        upstreamRequests.push({ url: req.url, method: req.method });
        res.redirect(302, `https://example.com/callback?code=upstream-code&state=${req.query.state ?? ''}`);
    });
    upstreamAS.post('/token', (req, res) => {
        upstreamRequests.push({ url: req.url, method: req.method, body: JSON.stringify(req.body) });
        res.json({ access_token: 'upstream-token', token_type: 'Bearer' });
    });
    upstreamAS.post('/revoke', (req, res) => {
        upstreamRequests.push({ url: req.url, method: req.method, body: JSON.stringify(req.body) });
        res.sendStatus(200);
    });

    await using upstream = await startExpressMinimal(upstreamAS);

    const provider = new ProxyOAuthServerProvider({
        endpoints: {
            authorizationUrl: new URL('/authorize', upstream.baseUrl).href,
            tokenUrl: new URL('/token', upstream.baseUrl).href,
            revocationUrl: new URL('/revoke', upstream.baseUrl).href
        },
        verifyAccessToken: async token => ({ token, clientId: 'proxy-client', scopes: [], expiresAt: 1e12 }),
        getClient: async (id: string) =>
            id === 'proxy-client'
                ? ({
                      client_id: 'proxy-client',
                      client_secret: 'proxy-secret',
                      redirect_uris: ['https://example.com/cb']
                  } as OAuthClientInformationFull)
                : undefined
    });

    const app = express();
    app.use(express.json());
    app.use(mcpAuthRouter({ provider, issuerUrl: new URL('https://proxy.example.com') }));

    await using proxy = await startExpressMinimal(app);

    const authRes = await fetch(new URL('/authorize', proxy.baseUrl));
    expect(authRes.status).not.toBe(404);

    const tokenRes = await fetch(new URL('/token', proxy.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=test&redirect_uri=https://example.com/cb&client_id=proxy-client&code_verifier=test'
    });
    expect(tokenRes.status).not.toBe(404);

    const revokeRes = await fetch(new URL('/revoke', proxy.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token=old-token&client_id=proxy-client&client_secret=proxy-secret'
    });
    expect([200, 400]).toContain(revokeRes.status);
});

verifies('hosting:http:host-validation-middleware', async (_args: TestArgs) => {
    const handler: RequestHandler = (_req, res) => {
        res.json({ ok: true });
    };

    await using host = await startExpressWithHostValidation(['localhost', '127.0.0.1'], handler);

    const good = await fetch(new URL('/test', host.baseUrl));
    expect(good.status).toBe(200);

    const spoofed = await postWithHost(new URL('/test', host.baseUrl), 'evil.example.com', JSON.stringify({ test: 'data' }));
    expect(spoofed.status).toBe(403);
    const body = JSON.parse(spoofed.body) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/Invalid Host/i);
});

verifies('hosting:express-app-helper', async (_args: TestArgs) => {
    const app = createMcpExpressApp();
    app.post('/mcp', (_req, res) => {
        res.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    });

    await using host = await startExpressMinimal(app);

    expect(host.baseUrl.hostname).toBe('127.0.0.1');

    const good = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    expect(good.status).toBe(200);

    const spoofed = await postWithHost(
        new URL('/mcp', host.baseUrl),
        'evil.example.com',
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    );
    expect(spoofed.status).toBe(403);
    const body = JSON.parse(spoofed.body) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/Invalid Host/i);
});

// ---------------------------------------------------------------------------
// Bundled authorization-server endpoints (/register, /authorize, /token):
// in-memory provider + dynamic registration drive the SDK's own handlers
// over real HTTP, mirroring what a real OAuth client would send.
// ---------------------------------------------------------------------------

const AS_REDIRECT_URI = 'https://client.example.com/callback';

interface IssuedAuthorizationCode {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
}

function createAuthorizationServerProvider(): OAuthServerProvider {
    const clients = new Map<string, OAuthClientInformationFull>();
    const codes = new Map<string, IssuedAuthorizationCode>();
    let clientCount = 0;
    let codeCount = 0;

    return {
        clientsStore: {
            getClient: async (clientId: string) => clients.get(clientId),
            registerClient: async client => {
                clientCount += 1;
                const registered: OAuthClientInformationFull = { ...client, client_id: `registered-client-${clientCount}` };
                clients.set(registered.client_id, registered);
                return registered;
            }
        },
        authorize: async (client, params, res) => {
            codeCount += 1;
            const code = `authorization-code-${codeCount}`;
            codes.set(code, { clientId: client.client_id, codeChallenge: params.codeChallenge, redirectUri: params.redirectUri });
            const target = new URL(params.redirectUri);
            target.searchParams.set('code', code);
            if (params.state !== undefined) {
                target.searchParams.set('state', params.state);
            }
            res.redirect(302, target.href);
        },
        challengeForAuthorizationCode: async (_client, authorizationCode) => {
            const issued = codes.get(authorizationCode);
            if (!issued) {
                throw new InvalidGrantError('authorization code does not exist');
            }
            return issued.codeChallenge;
        },
        exchangeAuthorizationCode: async (client, authorizationCode, _codeVerifier, redirectUri) => {
            const issued = codes.get(authorizationCode);
            if (!issued) {
                throw new InvalidGrantError('authorization code does not exist');
            }
            if (issued.clientId !== client.client_id) {
                throw new InvalidGrantError('authorization code was issued to a different client');
            }
            if (redirectUri !== undefined && redirectUri !== issued.redirectUri) {
                throw new InvalidGrantError('redirect_uri does not match the one used at authorization');
            }
            // Single-use: the first successful exchange consumes the code.
            codes.delete(authorizationCode);
            return { access_token: `access-token-for-${authorizationCode}`, token_type: 'Bearer' };
        },
        exchangeRefreshToken: async () => {
            throw new InvalidGrantError('refresh tokens are not issued by this provider');
        },
        verifyAccessToken: async (token: string) => ({
            token,
            clientId: 'registered-client-1',
            scopes: [],
            expiresAt: Date.now() / 1000 + 3600
        })
    };
}

async function startAuthorizationServer(): Promise<ExpressHost> {
    const app = express();
    app.use(express.json());
    app.use(mcpAuthRouter({ provider: createAuthorizationServerProvider(), issuerUrl: new URL('https://auth.example.com') }));
    return startExpressMinimal(app);
}

function createPkcePair(): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function postRegistration(baseUrl: URL, redirectUris: string[]): Promise<Response> {
    return fetch(new URL('/register', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'analytics-dashboard', redirect_uris: redirectUris })
    });
}

async function registerConfidentialClient(baseUrl: URL): Promise<{ clientId: string; clientSecret: string }> {
    const res = await postRegistration(baseUrl, [AS_REDIRECT_URI]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id?: string; client_secret?: string };
    if (typeof body.client_id !== 'string' || typeof body.client_secret !== 'string') {
        throw new Error('registration response did not include client_id and client_secret');
    }
    return { clientId: body.client_id, clientSecret: body.client_secret };
}

async function mintAuthorizationCode(baseUrl: URL, clientId: string, codeChallenge: string): Promise<string> {
    const authorizeUrl = new URL('/authorize', baseUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', AS_REDIRECT_URI);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'request-state');

    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    if (location === null) {
        throw new Error('authorize response did not include a Location header');
    }
    const redirect = new URL(location);
    expect(redirect.origin + redirect.pathname).toBe(AS_REDIRECT_URI);
    expect(redirect.searchParams.get('state')).toBe('request-state');
    const code = redirect.searchParams.get('code');
    if (code === null) {
        throw new Error('authorize redirect did not include a code parameter');
    }
    return code;
}

function postTokenExchange(baseUrl: URL, form: Record<string, string>): Promise<Response> {
    return fetch(new URL('/token', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString()
    });
}

verifies('hosting:auth:as:redirect-uri-scheme', async (_args: TestArgs) => {
    await using host = await startAuthorizationServer();

    const httpsRegistration = await postRegistration(host.baseUrl, ['https://client.example.com/callback']);
    expect(httpsRegistration.status).toBe(201);

    const loopbackRegistration = await postRegistration(host.baseUrl, ['http://127.0.0.1:49152/callback']);
    expect(loopbackRegistration.status).toBe(201);

    const nonLoopbackHttp = await postRegistration(host.baseUrl, ['http://attacker.example.com/callback']);
    expect(nonLoopbackHttp.status).toBe(400);
    const body = (await nonLoopbackHttp.json()) as { error?: string };
    expect(body.error).toBe('invalid_client_metadata');
});

verifies('hosting:auth:as:redirect-uri-binding', async (_args: TestArgs) => {
    await using host = await startAuthorizationServer();
    const { clientId, clientSecret } = await registerConfidentialClient(host.baseUrl);
    const { verifier, challenge } = createPkcePair();

    // Authorize leg: an unregistered redirect_uri gets a direct 400, never a redirect to the attacker URI.
    const authorizeUrl = new URL('/authorize', host.baseUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', 'https://attacker.example.com/callback');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorizeRes.status).toBe(400);
    expect(authorizeRes.headers.get('location')).toBeNull();
    expect(await authorizeRes.json()).toEqual({ error: 'invalid_request', error_description: 'Unregistered redirect_uri' });

    // Token leg: the handler forwards the request's redirect_uri to the provider, which rejects a value differing from authorize.
    const code = await mintAuthorizationCode(host.baseUrl, clientId, challenge);
    const tokenRes = await postTokenExchange(host.baseUrl, {
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: 'https://client.example.com/callback/other'
    });
    expect(tokenRes.status).toBe(400);
    expect(await tokenRes.json()).toEqual({
        error: 'invalid_grant',
        error_description: 'redirect_uri does not match the one used at authorization'
    });
});

verifies('hosting:auth:query-token-ignored', async (_args: TestArgs) => {
    const verifier = {
        verifyAccessToken: async (token: string) => {
            if (token !== VALID_TOKEN) {
                throw new InvalidTokenError('Token verification failed');
            }
            return { token, clientId: 'analytics-client', scopes: [], expiresAt: Date.now() / 1000 + 3600 };
        }
    };

    const app = express();
    app.use(express.json());
    app.use(requireBearerAuth({ verifier, resourceMetadataUrl: RESOURCE_METADATA_URL }));
    app.post('/mcp', (_req, res) => {
        res.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    });

    await using host = await startExpressMinimal(app);

    const queryUrl = new URL('/mcp', host.baseUrl);
    queryUrl.searchParams.set('access_token', VALID_TOKEN);
    const queryRes = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(queryRes.status).toBe(401);
    const wwwAuth = queryRes.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error="invalid_token"');
    const queryBody = (await queryRes.json()) as { error?: string };
    expect(queryBody.error).toBe('invalid_token');

    // Control: the same token in the Authorization header authenticates, proving only the query-string placement was ignored.
    const headerRes = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    expect(headerRes.status).toBe(200);
});

verifies('hosting:auth:as:authorize-requires-pkce', async (_args: TestArgs) => {
    await using host = await startAuthorizationServer();
    const { clientId } = await registerConfidentialClient(host.baseUrl);

    const authorizeUrl = new URL('/authorize', host.baseUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', AS_REDIRECT_URI);
    authorizeUrl.searchParams.set('state', 'pkce-required-state');

    const res = await fetch(authorizeUrl, { redirect: 'manual' });

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    if (location === null) {
        throw new Error('authorize response did not include a Location header');
    }
    const redirect = new URL(location);
    expect(redirect.origin + redirect.pathname).toBe(AS_REDIRECT_URI);
    expect(redirect.searchParams.get('error')).toBe('invalid_request');
    expect(redirect.searchParams.get('error_description')).toContain('code_challenge');
    expect(redirect.searchParams.get('code')).toBeNull();
});

verifies('hosting:auth:as:verifier-mismatch', async (_args: TestArgs) => {
    await using host = await startAuthorizationServer();
    const { clientId, clientSecret } = await registerConfidentialClient(host.baseUrl);

    const { challenge } = createPkcePair();
    const code = await mintAuthorizationCode(host.baseUrl, clientId, challenge);

    // A well-formed verifier from a different PKCE pair cannot hash to the stored challenge.
    const { verifier: wrongVerifier } = createPkcePair();
    const res = await postTokenExchange(host.baseUrl, {
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: wrongVerifier,
        redirect_uri: AS_REDIRECT_URI
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant', error_description: 'code_verifier does not match the challenge' });
});

verifies('hosting:auth:as:code-single-use', async (_args: TestArgs) => {
    await using host = await startAuthorizationServer();
    const { clientId, clientSecret } = await registerConfidentialClient(host.baseUrl);

    const { verifier, challenge } = createPkcePair();
    const code = await mintAuthorizationCode(host.baseUrl, clientId, challenge);
    const form = {
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: AS_REDIRECT_URI
    };

    const first = await postTokenExchange(host.baseUrl, form);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { access_token?: string; token_type?: string };
    expect(firstBody.token_type).toBe('Bearer');
    expect(firstBody.access_token).toBe(`access-token-for-${code}`);

    const second = await postTokenExchange(host.baseUrl, form);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'invalid_grant', error_description: 'authorization code does not exist' });
});
