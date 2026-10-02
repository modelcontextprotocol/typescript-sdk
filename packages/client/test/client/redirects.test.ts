import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';

import type { OAuthClientProvider } from '../../src/client/auth';
import {
    discoverAuthorizationServerMetadata,
    discoverOAuthProtectedResourceMetadata,
    exchangeAuthorization,
    refreshAuthorization,
    registerClient
} from '../../src/client/auth';
import { exchangeJwtAuthGrant, requestJwtAuthorizationGrant } from '../../src/client/crossAppAccess';
import type { SSEClientTransportOptions } from '../../src/client/sse';
import { SSEClientTransport } from '../../src/client/sse';
import type { StreamableHTTPClientTransportOptions } from '../../src/client/streamableHttp';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';

type Recorded = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
type Handler = (req: IncomingMessage, res: ServerResponse, recorded: Recorded) => void;

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const request: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const notification: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/roots/list_changed' };
const clientInformation = { client_id: 'client-1', client_secret: 'client-secret-1' };

/** Two loopback servers: `endpoint` is what the client is configured with, `other` is a different origin. */
describe('redirects', () => {
    let endpoint: Server;
    let other: Server;
    let endpointUrl: URL;
    let otherUrl: URL;
    let endpointRequests: Recorded[];
    let otherRequests: Recorded[];
    let handle: Handler;
    let transport: StreamableHTTPClientTransport | SSEClientTransport | undefined;

    const record = (requests: Recorded[], respond: Handler) =>
        createServer((req, res) => {
            let body = '';
            req.on('data', chunk => (body += chunk));
            req.on('end', () => {
                const recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
                requests.push(recorded);
                respond(req, res, recorded);
            });
        });

    const redirectTo = (location: string | URL, status = 307): Handler => {
        return (_req, res) => void res.writeHead(status, { location: String(location) }).end();
    };

    beforeEach(async () => {
        endpointRequests = [];
        otherRequests = [];
        handle = (_req, res) => void res.writeHead(404).end();
        endpoint = record(endpointRequests, (req, res, recorded) => handle(req, res, recorded));
        other = record(otherRequests, (_req, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
        endpointUrl = await listenOnRandomPort(endpoint);
        otherUrl = await listenOnRandomPort(other);
    });

    afterEach(async () => {
        await transport?.close();
        transport = undefined;
        endpoint.closeAllConnections();
        other.closeAllConnections();
        await new Promise(resolve => endpoint.close(resolve));
        await new Promise(resolve => other.close(resolve));
    });

    const streamableHttp = async (): Promise<StreamableHTTPClientTransport> => {
        const created = new StreamableHTTPClientTransport(new URL('/mcp', endpointUrl), {
            requestInit: { headers: { 'x-api-key': 'key-1' } },
            sessionId: 'session-1'
        });
        created.onerror = () => {};
        transport = created;
        await created.start();
        return created;
    };

    describe('to another origin', () => {
        test('Streamable HTTP POST is not followed, and the next message still sends', async () => {
            const client = await streamableHttp();
            handle = redirectTo(new URL('/mcp?from=endpoint', otherUrl));

            const error = await client.send(request).catch((error_: Error) => error_);

            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain(`Redirect to ${new URL('/mcp', otherUrl)} not followed`);
            expect((error as Error).message).not.toContain('from=endpoint');
            expect(otherRequests).toEqual([]);
            expect(endpointRequests).toHaveLength(1);

            handle = (_req, res) => void res.writeHead(202).end();
            await client.send(notification);
            expect(client.sessionId).toBe('session-1');
            expect(endpointRequests).toHaveLength(2);
            expect(endpointRequests[1]!.headers['mcp-session-id']).toBe('session-1');
            expect(endpointRequests[1]!.headers['x-api-key']).toBe('key-1');
            expect(otherRequests).toEqual([]);
        });

        test('Streamable HTTP GET stream is not followed', async () => {
            const client = await streamableHttp();
            handle = redirectTo(new URL('/mcp', otherUrl));

            await expect(client.resumeStream('event-1')).rejects.toThrow(`Redirect to ${new URL('/mcp', otherUrl)} not followed`);
            expect(otherRequests).toEqual([]);
            expect(endpointRequests.map(r => r.method)).toEqual(['GET']);
        });

        test('Streamable HTTP DELETE is not followed, and the session is kept', async () => {
            const client = await streamableHttp();
            handle = redirectTo(new URL('/mcp', otherUrl));

            await expect(client.terminateSession()).rejects.toThrow(`Redirect to ${new URL('/mcp', otherUrl)} not followed`);
            expect(otherRequests).toEqual([]);
            expect(endpointRequests.map(r => r.method)).toEqual(['DELETE']);
            expect(client.sessionId).toBe('session-1');
        });

        test('SSE stream is not followed', async () => {
            handle = redirectTo(new URL('/sse', otherUrl));
            const client = new SSEClientTransport(new URL('/sse', endpointUrl), { requestInit: { headers: { 'x-api-key': 'key-1' } } });
            transport = client;

            await expect(client.start()).rejects.toThrow(`Redirect to ${new URL('/sse', otherUrl)} not followed`);
            expect(otherRequests).toEqual([]);
            expect(endpointRequests.map(r => r.method)).toEqual(['GET']);
        });

        test('SSE stream given its own fetch is not followed', async () => {
            handle = redirectTo(new URL('/sse', otherUrl));
            const client = new SSEClientTransport(new URL('/sse', endpointUrl), {
                eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'x-api-key': 'key-1' } }) }
            });
            transport = client;

            await expect(client.start()).rejects.toThrow(`Redirect to ${new URL('/sse', otherUrl)} not followed`);
            expect(otherRequests).toEqual([]);
            expect(endpointRequests.map(r => r.headers['x-api-key'])).toEqual(['key-1']);
        });

        test('SSE POST is not followed, and the next message still sends', async () => {
            handle = (req, res) => {
                if (req.method === 'GET') {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.write('event: endpoint\ndata: /messages\n\n');
                    return;
                }
                redirectTo(new URL('/messages', otherUrl))(req, res, undefined as never);
            };
            const client = new SSEClientTransport(new URL('/sse', endpointUrl), { requestInit: { headers: { 'x-api-key': 'key-1' } } });
            client.onerror = () => {};
            transport = client;
            await client.start();

            await expect(client.send(request)).rejects.toThrow(`Redirect to ${new URL('/messages', otherUrl)} not followed`);
            expect(otherRequests).toEqual([]);

            const redirecting = handle;
            handle = (req, res, recorded) => (req.method === 'POST' ? void res.writeHead(202).end() : redirecting(req, res, recorded));
            await client.send(notification);
            expect(endpointRequests.at(-1)).toMatchObject({ method: 'POST', url: '/messages', body: JSON.stringify(notification) });
            expect(otherRequests).toEqual([]);
        });

        test('a protocol-relative Location is not followed', async () => {
            const client = await streamableHttp();
            handle = redirectTo(`//${otherUrl.host}/mcp`);

            await expect(client.send(request)).rejects.toThrow(`Redirect to ${new URL('/mcp', otherUrl)} not followed`);
            expect(otherRequests).toEqual([]);
        });

        test('from https to http names the https form of the target', async () => {
            const fetchStub = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'http://example.com/mcp/' } }));
            const client = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), { fetch: fetchStub });
            client.onerror = () => {};
            transport = client;
            await client.start();

            const error = await client.send(request).catch((error_: Error) => error_);

            expect((error as Error).message).toContain('https://example.com/mcp/');
            expect((error as Error).message).not.toContain('http://');
            expect(fetchStub).toHaveBeenCalledTimes(1);
        });

        test('in a browser, where the target is not exposed, the request fails', async () => {
            const opaque = { type: 'opaqueredirect', status: 0, ok: false, statusText: '', headers: new Headers() } as Response;
            const fetchStub = vi.fn(async () => opaque);
            const client = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), { fetch: fetchStub });
            client.onerror = () => {};
            transport = client;
            await client.start();

            await expect(client.send(request)).rejects.toThrow('Redirect not followed');
            expect(fetchStub).toHaveBeenCalledTimes(1);
        });

        test('protected resource metadata discovery is not followed', async () => {
            handle = redirectTo(new URL('/.well-known/oauth-protected-resource', otherUrl));

            await expect(discoverOAuthProtectedResourceMetadata(endpointUrl)).rejects.toThrow('HTTP 307');
            expect(otherRequests).toEqual([]);
        });

        test('authorization server metadata discovery is not followed', async () => {
            handle = redirectTo(new URL('/.well-known/oauth-authorization-server', otherUrl));

            await expect(discoverAuthorizationServerMetadata(endpointUrl)).resolves.toBeUndefined();
            expect(endpointRequests.map(r => r.url)).toEqual([
                '/.well-known/oauth-authorization-server',
                '/.well-known/openid-configuration'
            ]);
            expect(otherRequests).toEqual([]);
        });

        test('authorization server metadata discovery tries the next well-known URL', async () => {
            const metadata = {
                issuer: endpointUrl.origin,
                authorization_endpoint: `${endpointUrl.origin}/authorize`,
                token_endpoint: `${endpointUrl.origin}/token`,
                jwks_uri: `${endpointUrl.origin}/jwks`,
                response_types_supported: ['code'],
                subject_types_supported: ['public'],
                id_token_signing_alg_values_supported: ['RS256']
            };
            handle = (req, res, recorded) =>
                req.url === '/.well-known/openid-configuration'
                    ? void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata))
                    : redirectTo(new URL('/metadata', otherUrl), 302)(req, res, recorded);

            await expect(discoverAuthorizationServerMetadata(endpointUrl)).resolves.toMatchObject(metadata);
            expect(otherRequests).toEqual([]);
        });

        test('protected resource metadata discovery tries the root well-known URL', async () => {
            const metadata = { resource: new URL('/mcp', endpointUrl).href, authorization_servers: [endpointUrl.origin] };
            handle = (req, res, recorded) =>
                req.url === '/.well-known/oauth-protected-resource'
                    ? void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata))
                    : redirectTo(new URL('/metadata', otherUrl), 302)(req, res, recorded);

            await expect(discoverOAuthProtectedResourceMetadata(new URL('/mcp', endpointUrl))).resolves.toEqual(metadata);
            expect(endpointRequests.map(r => r.url)).toEqual([
                '/.well-known/oauth-protected-resource/mcp',
                '/.well-known/oauth-protected-resource'
            ]);
            expect(otherRequests).toEqual([]);
        });

        test('client registration is not followed', async () => {
            handle = redirectTo(new URL('/register', otherUrl));

            await expect(
                registerClient(endpointUrl, { clientMetadata: { redirect_uris: ['http://localhost:3000/callback'] } })
            ).rejects.toThrow('HTTP 307');
            expect(otherRequests).toEqual([]);
        });

        test('authorization code exchange is not followed', async () => {
            handle = redirectTo(new URL('/token', otherUrl));

            await expect(
                exchangeAuthorization(endpointUrl, {
                    clientInformation,
                    authorizationCode: 'code-1',
                    codeVerifier: 'verifier-1',
                    redirectUri: 'http://localhost:3000/callback'
                })
            ).rejects.toThrow('HTTP 307');
            expect(otherRequests).toEqual([]);
        });

        test('token refresh is not followed', async () => {
            handle = redirectTo(new URL('/token', otherUrl));

            await expect(refreshAuthorization(endpointUrl, { clientInformation, refreshToken: 'refresh-1' })).rejects.toThrow('HTTP 307');
            expect(otherRequests).toEqual([]);
        });

        test('JWT authorization grant request is not followed', async () => {
            handle = redirectTo(new URL('/token', otherUrl));

            await expect(
                requestJwtAuthorizationGrant({
                    tokenEndpoint: new URL('/token', endpointUrl),
                    audience: 'https://auth.example.com',
                    resource: 'https://mcp.example.com',
                    idToken: 'id-token-1',
                    clientId: 'client-1'
                })
            ).rejects.toThrow('307');
            expect(otherRequests).toEqual([]);
        });

        test('JWT authorization grant exchange is not followed', async () => {
            handle = redirectTo(new URL('/token', otherUrl));

            await expect(
                exchangeJwtAuthGrant({
                    tokenEndpoint: new URL('/token', endpointUrl),
                    jwtAuthGrant: 'grant-1',
                    clientId: 'client-1',
                    clientSecret: 'client-secret-1'
                })
            ).rejects.toThrow('307');
            expect(otherRequests).toEqual([]);
        });
    });

    describe('that changes the method', () => {
        test.each([301, 302, 303])('a %i of a POST within the origin is not followed', async status => {
            const client = await streamableHttp();
            handle = redirectTo('/mcp/', status);

            await expect(client.send(request)).rejects.toThrow(`Redirect to ${new URL('/mcp/', endpointUrl)} not followed`);
            expect(endpointRequests.map(r => `${r.method} ${r.url}`)).toEqual(['POST /mcp']);
        });

        test('after a followed redirect, a relative Location is named from the URL that answered', async () => {
            const client = await streamableHttp();
            handle = (req, res, recorded) =>
                req.url === '/mcp' ? redirectTo('/a/b/mcp', 307)(req, res, recorded) : redirectTo('login', 302)(req, res, recorded);

            await expect(client.send(request)).rejects.toThrow(`Redirect to ${new URL('/a/b/login', endpointUrl)} not followed`);
            expect(endpointRequests.map(r => `${r.method} ${r.url}`)).toEqual(['POST /mcp', 'POST /a/b/mcp']);
        });
    });

    describe('within the origin', () => {
        test.each([307, 308])('a %i of a POST is followed with its headers and body', async status => {
            const client = await streamableHttp();
            handle = (req, res, recorded) =>
                req.url === '/mcp' ? redirectTo('/mcp/', status)(req, res, recorded) : void res.writeHead(202).end();

            await client.send(request);

            expect(endpointRequests.map(r => `${r.method} ${r.url}`)).toEqual(['POST /mcp', 'POST /mcp/']);
            expect(endpointRequests[1]!.body).toBe(JSON.stringify(request));
            expect(endpointRequests[1]!.headers).toMatchObject({
                'x-api-key': 'key-1',
                'mcp-session-id': 'session-1',
                'content-type': 'application/json'
            });
        });

        test.each(REDIRECT_STATUSES)('a %i of the GET stream is followed', async status => {
            const client = await streamableHttp();
            const received = new Promise<JSONRPCMessage>(resolve => (client.onmessage = resolve));
            handle = (req, res, recorded) => {
                if (req.url === '/mcp') return redirectTo('/mcp/', status)(req, res, recorded);
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(`id: event-2\ndata: ${JSON.stringify(notification)}\n\n`);
            };

            await client.resumeStream('event-1');

            await expect(received).resolves.toEqual(notification);
            expect(endpointRequests.map(r => `${r.method} ${r.url}`)).toEqual(['GET /mcp', 'GET /mcp/']);
            expect(endpointRequests[1]!.headers).toMatchObject({ 'x-api-key': 'key-1', 'last-event-id': 'event-1' });
        });

        test('a 307 of the token request is followed', async () => {
            const tokens = { access_token: 'access-1', token_type: 'Bearer' };
            handle = (req, res, recorded) => {
                if (req.url === '/token') return redirectTo('/token/', 307)(req, res, recorded);
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(tokens));
            };

            await expect(refreshAuthorization(endpointUrl, { clientInformation, refreshToken: 'refresh-1' })).resolves.toMatchObject(
                tokens
            );
            expect(endpointRequests.map(r => `${r.method} ${r.url}`)).toEqual(['POST /token', 'POST /token/']);
            expect(endpointRequests[1]!.body).toContain('refresh_token=refresh-1');
        });
    });

    describe('redirectPolicy', () => {
        const requestInit = { headers: { 'x-api-key': 'key-1' } };
        const sent = { 'x-api-key': 'key-1', 'mcp-session-id': 'session-1' };
        const toOther: Handler = (req, res, recorded) => redirectTo(new URL(req.url ?? '/', otherUrl))(req, res, recorded);
        /** Answers the GET of the SSE transport with its endpoint event and hands every other request to `rest`. */
        const sseEndpoint =
            (rest: Handler): Handler =>
            (req, res, recorded) => {
                if (req.method !== 'GET') return rest(req, res, recorded);
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('event: endpoint\ndata: /messages\n\n');
            };
        /** Answers OAuth discovery for an authorization server at the endpoint and hands every other request to `rest`. */
        const oauthDiscovery =
            (rest: Handler): Handler =>
            (req, res, recorded) => {
                const origin = endpointUrl.origin;
                const metadata = req.url?.startsWith('/.well-known/oauth-protected-resource')
                    ? { resource: origin, authorization_servers: [origin] }
                    : req.url?.startsWith('/.well-known/oauth-authorization-server')
                      ? {
                            issuer: origin,
                            authorization_endpoint: `${origin}/authorize`,
                            token_endpoint: `${origin}/token`,
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        }
                      : undefined;
                if (!metadata) return rest(req, res, recorded);
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata));
            };
        const authProvider = (): OAuthClientProvider => ({
            redirectUrl: 'http://localhost:3000/callback',
            clientMetadata: { redirect_uris: ['http://localhost:3000/callback'] },
            clientInformation: () => clientInformation,
            tokens: vi.fn(),
            saveTokens: () => {},
            redirectToAuthorization: () => {},
            saveCodeVerifier: () => {},
            codeVerifier: () => 'verifier-1'
        });

        type Options = StreamableHTTPClientTransportOptions & SSEClientTransportOptions;
        const streamableHttpWith = async (options: StreamableHTTPClientTransportOptions): Promise<StreamableHTTPClientTransport> => {
            const created = new StreamableHTTPClientTransport(new URL('/mcp', endpointUrl), {
                requestInit,
                sessionId: 'session-1',
                ...options
            });
            created.onerror = () => {};
            transport = created;
            await created.start();
            return created;
        };
        const sseWith = (options: SSEClientTransportOptions): SSEClientTransport => {
            const created = new SSEClientTransport(new URL('/sse', endpointUrl), { requestInit, ...options });
            created.onerror = () => {};
            transport = created;
            return created;
        };

        const sseStarted = async (options: SSEClientTransportOptions): Promise<SSEClientTransport> => {
            const created = sseWith(options);
            await created.start();
            return created;
        };
        const started: [string, (options: Options) => Promise<StreamableHTTPClientTransport | SSEClientTransport>][] = [
            ['Streamable HTTP', streamableHttpWith],
            ['SSE', sseStarted]
        ];

        describe("'follow' leaves redirects to fetch", () => {
            const follow = { redirectPolicy: 'follow' } as const;

            test('Streamable HTTP POST to another origin is followed with its headers and body', async () => {
                const client = await streamableHttpWith(follow);
                handle = toOther;

                await client.send(notification);

                expect(otherRequests).toMatchObject([
                    {
                        method: 'POST',
                        url: '/mcp',
                        body: JSON.stringify(notification),
                        headers: { ...sent, 'content-type': 'application/json' }
                    }
                ]);
            });

            test('Streamable HTTP GET stream to another origin is followed', async () => {
                const client = await streamableHttpWith(follow);
                handle = toOther;

                await client.resumeStream('event-1');

                expect(otherRequests[0]).toMatchObject({ method: 'GET', url: '/mcp', headers: { ...sent, 'last-event-id': 'event-1' } });
            });

            test('Streamable HTTP DELETE to another origin is followed', async () => {
                const client = await streamableHttpWith(follow);
                handle = toOther;

                await client.terminateSession();

                expect(otherRequests).toMatchObject([{ method: 'DELETE', url: '/mcp', headers: sent }]);
                expect(client.sessionId).toBeUndefined();
            });

            test('SSE stream to another origin is followed', async () => {
                handle = toOther;

                await sseWith(follow)
                    .start()
                    .catch(() => {});

                expect(otherRequests[0]).toMatchObject({ method: 'GET', url: '/sse', headers: { 'x-api-key': 'key-1' } });
            });

            test('SSE stream given its own fetch is followed to another origin', async () => {
                handle = toOther;
                const eventSourceInit = { fetch: (url: string | URL, init?: RequestInit) => fetch(url, init) };

                await sseWith({ ...follow, eventSourceInit })
                    .start()
                    .catch(() => {});

                expect(otherRequests[0]).toMatchObject({ method: 'GET', url: '/sse', headers: { 'x-api-key': 'key-1' } });
            });

            test('SSE POST to another origin is followed with its headers and body', async () => {
                handle = sseEndpoint(toOther);
                const client = await sseStarted(follow);

                await client.send(notification);

                expect(otherRequests).toMatchObject([
                    { method: 'POST', url: '/messages', body: JSON.stringify(notification), headers: { 'x-api-key': 'key-1' } }
                ]);
            });

            describe.each(started)('%s', (_name, create) => {
                test('the token request of finishAuth is followed to another origin with its body', async () => {
                    handle = oauthDiscovery(sseEndpoint(toOther));
                    const client = await create({ ...follow, authProvider: authProvider() });

                    await client.finishAuth('code-1').catch(() => {});

                    expect(otherRequests).toMatchObject([{ method: 'POST', url: '/token', headers: { 'x-api-key': 'key-1' } }]);
                    expect(otherRequests[0]!.body).toContain('code=code-1');
                });

                test('requestInit.redirect is handed to fetch, and a redirect it returns is reported as any other response', async () => {
                    handle = sseEndpoint(redirectTo('/next'));
                    const client = await create({ ...follow, requestInit: { ...requestInit, redirect: 'manual' } });

                    await expect(client.send(request)).rejects.toThrow(/^Error POSTing to endpoint( \(HTTP 307\))?: $/);
                    expect(endpointRequests.filter(r => r.method === 'POST')).toHaveLength(1);
                });
            });
        });

        describe("'same-origin' is the default", () => {
            describe.each(started)('%s', (_name, create) => {
                test.each([undefined, 'same-origin', 'other'] as const)(
                    'set to %s, a redirect to another origin is not followed',
                    async value => {
                        handle = oauthDiscovery(sseEndpoint(toOther));
                        const client = await create({ redirectPolicy: value as 'same-origin', authProvider: authProvider() });

                        await expect(client.send(request)).rejects.toThrow(/Redirect to \S+ not followed/);
                        await client.finishAuth('code-1').catch(() => {});
                        expect(endpointRequests.map(r => `${r.method} ${r.url}`)).toContain('POST /token');
                        expect(otherRequests).toEqual([]);
                    }
                );

                test.each(['error', 'manual'] as const)(
                    'a requestInit.redirect of %s is handed to fetch, and a redirect within the origin is not followed',
                    async redirect => {
                        handle = sseEndpoint(redirectTo('/next'));
                        const client = await create({ requestInit: { ...requestInit, redirect } });

                        await expect(client.send(request)).rejects.toThrow();
                        expect(endpointRequests.filter(r => r.method === 'POST')).toHaveLength(1);
                    }
                );
            });

            test.each<[string, (client: StreamableHTTPClientTransport) => Promise<unknown>]>([
                ['GET stream', client => client.resumeStream('event-1')],
                ['DELETE', client => client.terminateSession()]
            ])("a requestInit.redirect of 'error' is handed to fetch for the Streamable HTTP %s", async (_name, run) => {
                handle = redirectTo('/next');
                const client = await streamableHttpWith({ requestInit: { ...requestInit, redirect: 'error' } });

                await expect(run(client)).rejects.toThrow();
                expect(endpointRequests.map(r => r.url)).toEqual(['/mcp']);
            });

            test.each<[string, () => Promise<unknown>]>([
                ['Streamable HTTP POST', () => streamableHttpWith({}).then(client => client.send(request))],
                ['Streamable HTTP GET stream', () => streamableHttpWith({}).then(client => client.resumeStream('event-1'))],
                ['Streamable HTTP DELETE', () => streamableHttpWith({}).then(client => client.terminateSession())],
                ['SSE stream', () => sseWith({}).start()],
                [
                    'SSE POST',
                    async () => {
                        handle = sseEndpoint(toOther);
                        const client = await sseStarted({});
                        return client.send(request);
                    }
                ]
            ])('the error of a %s that is not followed names the option', async (_name, run) => {
                handle = toOther;

                await expect(run()).rejects.toThrow(/Redirect to \S+ not followed.* \(redirectPolicy: 'same-origin'\)$/);
                expect(otherRequests).toEqual([]);
            });
        });
    });
});
