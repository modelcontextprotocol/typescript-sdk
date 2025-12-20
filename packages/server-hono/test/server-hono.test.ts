import type { AuthorizationParams, OAuthClientInformationFull, OAuthServerProvider, OAuthTokens } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { vi } from 'vitest';

import { mcpAuthRouter } from '../src/auth/router.js';
import { createMcpHonoApp } from '../src/hono.js';
import { hostHeaderValidation } from '../src/middleware/hostHeaderValidation.js';
import { mcpStreamableHttpHandler } from '../src/streamableHttp.js';

describe('@modelcontextprotocol/server-hono', () => {
    test('mcpStreamableHttpHandler delegates to transport.handleRequest (and passes authInfo + parsedBody when set)', async () => {
        const calls: { url?: string; method?: string; options?: unknown }[] = [];

        const transport = {
            async handleRequest(req: Request, options?: unknown): Promise<Response> {
                calls.push({ url: req.url, method: req.method, options });
                return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
            }
        };

        const app = new Hono();
        app.use('/mcp', async (c: Context, next) => {
            // Upstream middleware can pre-parse and stash body + auth.
            c.set('parsedBody', { hello: 'world' });
            c.set('auth', {
                token: 't',
                clientId: 'c',
                scopes: [],
                expiresAt: Math.floor(Date.now() / 1000) + 60
            });
            return await next();
        });
        app.all('/mcp', mcpStreamableHttpHandler(transport as unknown as Parameters<typeof mcpStreamableHttpHandler>[0]));

        const res = await app.request('http://localhost/mcp', { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('ok');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.method).toBe('POST');
        expect(calls[0]!.url).toBe('http://localhost/mcp');
        expect(calls[0]!.options).toEqual(
            expect.objectContaining({
                parsedBody: { hello: 'world' },
                authInfo: expect.objectContaining({ clientId: 'c' })
            })
        );
    });

    test('hostHeaderValidation blocks invalid Host and allows valid Host', async () => {
        const app = new Hono();
        app.use('*', hostHeaderValidation(['localhost']));
        app.get('/health', c => c.text('ok'));

        const bad = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(bad.status).toBe(403);
        expect(await bad.json()).toEqual(
            expect.objectContaining({
                jsonrpc: '2.0',
                error: expect.objectContaining({
                    code: -32000
                }),
                id: null
            })
        );

        const good = await app.request('http://localhost/health', { headers: { Host: 'localhost:3000' } });
        expect(good.status).toBe(200);
        expect(await good.text()).toBe('ok');
    });

    test('registerMcpAuthRoutes mounts metadata + authorize routes', async () => {
        const validClient: OAuthClientInformationFull = {
            client_id: 'valid-client',
            client_secret: 'valid-secret',
            redirect_uris: ['https://example.com/callback']
        };

        const provider: OAuthServerProvider = {
            clientsStore: {
                async getClient(clientId: string) {
                    return clientId === 'valid-client' ? validClient : undefined;
                }
            },
            async authorize(_client: OAuthClientInformationFull, params: AuthorizationParams): Promise<Response> {
                const u = new URL(params.redirectUri);
                u.searchParams.set('code', 'mock_auth_code');
                if (params.state) u.searchParams.set('state', params.state);
                return Response.redirect(u.toString(), 302);
            },
            async challengeForAuthorizationCode(): Promise<string> {
                return 'mock_challenge';
            },
            async exchangeAuthorizationCode(): Promise<OAuthTokens> {
                return {
                    access_token: 'mock_access_token',
                    token_type: 'bearer',
                    expires_in: 3600,
                    refresh_token: 'mock_refresh_token'
                };
            },
            async exchangeRefreshToken(): Promise<OAuthTokens> {
                return {
                    access_token: 'new_mock_access_token',
                    token_type: 'bearer',
                    expires_in: 3600,
                    refresh_token: 'new_mock_refresh_token'
                };
            },
            async verifyAccessToken() {
                throw new Error('not used');
            }
        };

        const app = new Hono();
        app.route('/', mcpAuthRouter({ provider, issuerUrl: new URL('https://auth.example.com') }));

        const metadata = await app.request('http://localhost/.well-known/oauth-authorization-server', { method: 'GET' });
        expect(metadata.status).toBe(200);
        const metaJson = (await metadata.json()) as { issuer?: string; authorization_endpoint?: string };
        expect(metaJson.issuer).toBe('https://auth.example.com/');
        expect(metaJson.authorization_endpoint).toBe('https://auth.example.com/authorize');

        const authorize = await app.request(
            'http://localhost/authorize?client_id=valid-client&response_type=code&code_challenge=x&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=s',
            { method: 'GET' }
        );
        expect(authorize.status).toBe(302);
        const location = authorize.headers.get('location')!;
        expect(location).toContain('https://example.com/callback');
        expect(location).toContain('code=mock_auth_code');
        expect(location).toContain('state=s');
    });

    test('registerMcpAuthRoutes returns 405 (not 404) for unsupported methods', async () => {
        const provider: OAuthServerProvider = {
            clientsStore: {
                async getClient() {
                    return undefined;
                }
            },
            async authorize() {
                throw new Error('not used');
            },
            async challengeForAuthorizationCode() {
                throw new Error('not used');
            },
            async exchangeAuthorizationCode() {
                throw new Error('not used');
            },
            async exchangeRefreshToken() {
                throw new Error('not used');
            },
            async verifyAccessToken() {
                throw new Error('not used');
            }
        };

        const app = new Hono();
        app.route('/', mcpAuthRouter({ provider, issuerUrl: new URL('https://auth.example.com') }));

        const res = await app.request('http://localhost/authorize', { method: 'PUT' });
        expect(res.status).toBe(405);
    });

    test('registerMcpAuthRoutes passes parsedBody to web handlers (POST /authorize works with empty raw body)', async () => {
        const validClient: OAuthClientInformationFull = {
            client_id: 'valid-client',
            client_secret: 'valid-secret',
            redirect_uris: ['https://example.com/callback']
        };

        const provider: OAuthServerProvider = {
            clientsStore: {
                async getClient(clientId: string) {
                    return clientId === 'valid-client' ? validClient : undefined;
                }
            },
            async authorize(_client: OAuthClientInformationFull, params: AuthorizationParams): Promise<Response> {
                const u = new URL(params.redirectUri);
                u.searchParams.set('code', 'mock_auth_code');
                if (params.state) u.searchParams.set('state', params.state);
                return Response.redirect(u.toString(), 302);
            },
            async challengeForAuthorizationCode(): Promise<string> {
                return 'mock_challenge';
            },
            async exchangeAuthorizationCode(): Promise<OAuthTokens> {
                return {
                    access_token: 'mock_access_token',
                    token_type: 'bearer',
                    expires_in: 3600,
                    refresh_token: 'mock_refresh_token'
                };
            },
            async exchangeRefreshToken(): Promise<OAuthTokens> {
                return {
                    access_token: 'new_mock_access_token',
                    token_type: 'bearer',
                    expires_in: 3600,
                    refresh_token: 'new_mock_refresh_token'
                };
            },
            async verifyAccessToken() {
                throw new Error('not used');
            }
        };

        const app = new Hono();
        app.use('/authorize', async (c: Context, next) => {
            c.set('parsedBody', {
                client_id: 'valid-client',
                response_type: 'code',
                code_challenge: 'x',
                code_challenge_method: 'S256',
                redirect_uri: 'https://example.com/callback',
                state: 's'
            });
            return await next();
        });
        app.route('/', mcpAuthRouter({ provider, issuerUrl: new URL('https://auth.example.com') }));

        const authorize = await app.request('http://localhost/authorize', { method: 'POST' });
        expect(authorize.status).toBe(302);
        const location = authorize.headers.get('location')!;
        expect(location).toContain('https://example.com/callback');
        expect(location).toContain('code=mock_auth_code');
        expect(location).toContain('state=s');
    });

    test('createMcpHonoApp enables localhost DNS rebinding protection by default', async () => {
        const app = createMcpHonoApp();
        app.get('/health', c => c.text('ok'));

        const bad = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(bad.status).toBe(403);

        const good = await app.request('http://localhost/health', { headers: { Host: 'localhost:3000' } });
        expect(good.status).toBe(200);
    });

    test('createMcpHonoApp uses allowedHosts when provided (even when binding to 0.0.0.0)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = createMcpHonoApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'] });
        warn.mockRestore();

        app.get('/health', c => c.text('ok'));

        const bad = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(bad.status).toBe(403);

        const good = await app.request('http://localhost/health', { headers: { Host: 'myapp.local:3000' } });
        expect(good.status).toBe(200);
    });

    test('createMcpHonoApp does not apply host validation for 0.0.0.0 without allowedHosts', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = createMcpHonoApp({ host: '0.0.0.0' });
        warn.mockRestore();

        app.get('/health', c => c.text('ok'));

        const res = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(res.status).toBe(200);
    });

    test('createMcpHonoApp parses JSON bodies into parsedBody (express.json()-like)', async () => {
        const app = createMcpHonoApp();
        app.post('/echo', (c: Context) => c.json(c.get('parsedBody')));

        const res = await app.request('http://localhost/echo', {
            method: 'POST',
            headers: { Host: 'localhost:3000', 'content-type': 'application/json' },
            body: JSON.stringify({ a: 1 })
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ a: 1 });
    });
});
