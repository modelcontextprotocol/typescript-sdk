import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import {
    auth,
    discoverAuthorizationServerMetadata,
    discoverOAuthProtectedResourceMetadata,
    exchangeAuthorization,
    refreshAuthorization,
    registerClient,
    type OAuthClientProvider
} from '../../src/client/auth.js';
import { SSEClientTransport, SseError } from '../../src/client/sse.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '../../src/client/streamableHttp.js';
import type { FetchLike } from '../../src/shared/transport.js';
import type { JSONRPCMessage } from '../../src/types.js';
import { listenOnRandomPort } from '../helpers/http.js';

interface RecordedRequest {
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
    body: string;
}

interface TestServer {
    url: URL;
    requests: RecordedRequest[];
}

type Handler = (request: RecordedRequest, res: ServerResponse) => void;

const message: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const redirectStatuses = [301, 302, 303, 307, 308];

describe('redirects in the HTTP client transports', () => {
    const servers: Server[] = [];
    let other: TestServer;

    /** Starts a loopback server that records each request before handing it to `handler`. */
    async function startServer(handler: Handler): Promise<TestServer> {
        const requests: RecordedRequest[] = [];
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', chunk => (body += chunk));
            req.on('end', () => {
                const request = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body };
                requests.push(request);
                handler(request, res);
            });
        });
        servers.push(server);
        return { url: await listenOnRandomPort(server), requests };
    }

    const redirectTo =
        (status: number, location: string): Handler =>
        (_request, res) => {
            res.writeHead(status, { location }).end();
        };

    /** Answers the paths in `routes` (keyed by "METHOD /path") and anything else with 404. */
    const routes =
        (table: Record<string, Handler>): Handler =>
        (request, res) => {
            const handler = table[`${request.method} ${request.path}`];
            if (handler) {
                handler(request, res);
            } else {
                res.writeHead(404).end();
            }
        };

    const accepted: Handler = (_request, res) => {
        res.writeHead(202).end();
    };

    const json =
        (body: unknown): Handler =>
        (_request, res) => {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        };

    const sseStream: Handler = (_request, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages\n\n');
    };

    async function rejection(promise: Promise<unknown>): Promise<Error> {
        const error = await promise.then(
            () => undefined,
            (error: Error) => error
        );
        if (!error) {
            throw new Error('Expected the call to reject, but it resolved');
        }
        return error;
    }

    beforeEach(async () => {
        // A second server on another port: it accepts whatever reaches it.
        other = await startServer((request, res) => {
            res.writeHead(request.method === 'GET' ? 405 : 202).end();
        });
    });

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });

    describe('StreamableHTTPClientTransport', () => {
        let transport: StreamableHTTPClientTransport;

        async function connectTo(url: URL | string, fetch?: FetchLike): Promise<StreamableHTTPClientTransport> {
            transport = new StreamableHTTPClientTransport(new URL(url), {
                requestInit: { headers: { 'x-api-key': 'key-1' } },
                sessionId: 'session-1',
                fetch
            });
            transport.onerror = () => {};
            await transport.start();
            return transport;
        }

        afterEach(async () => {
            await transport?.close();
        });

        it('does not follow a redirect of a POST to another origin, and keeps the session', async () => {
            let moved = true;
            const endpoint = await startServer((request, res) =>
                moved ? redirectTo(307, new URL('/mcp?from=endpoint', other.url).href)(request, res) : accepted(request, res)
            );
            await connectTo(new URL('/mcp', endpoint.url));

            const error = await rejection(transport.send(message));

            expect(error.message).toBe(
                `Streamable HTTP error: Error POSTing to endpoint: Redirect to ${other.url.origin}/mcp not followed (redirectPolicy: 'same-origin')`
            );
            expect(other.requests).toEqual([]);
            expect(transport.sessionId).toBe('session-1');

            moved = false;
            await transport.send(message);

            expect(endpoint.requests).toHaveLength(2);
            expect(endpoint.requests[1]).toMatchObject({
                method: 'POST',
                body: JSON.stringify(message),
                headers: { 'x-api-key': 'key-1', 'mcp-session-id': 'session-1' }
            });
        });

        it('does not follow a redirect of the GET listen stream to another origin', async () => {
            const endpoint = await startServer(redirectTo(307, new URL('/mcp', other.url).href));
            await connectTo(new URL('/mcp', endpoint.url));

            const error = await rejection(transport.resumeStream('event-1'));

            expect(error.message).toBe(
                `Streamable HTTP error: Failed to open SSE stream: Redirect to ${other.url.origin}/mcp not followed (redirectPolicy: 'same-origin')`
            );
            expect(endpoint.requests).toHaveLength(1);
            expect(other.requests).toEqual([]);
        });

        it('does not follow a redirect of the session DELETE to another origin', async () => {
            const endpoint = await startServer(redirectTo(307, new URL('/mcp', other.url).href));
            await connectTo(new URL('/mcp', endpoint.url));

            const error = await rejection(transport.terminateSession());

            expect(error.message).toBe(
                `Streamable HTTP error: Failed to terminate session: Redirect to ${other.url.origin}/mcp not followed (redirectPolicy: 'same-origin')`
            );
            expect(other.requests).toEqual([]);
            expect(transport.sessionId).toBe('session-1');
        });

        it.each([301, 302, 303])('does not follow a %i of a POST, which would turn it into a GET', async status => {
            const endpoint = await startServer(routes({ 'POST /mcp': redirectTo(status, '/mcp/') }));
            await connectTo(new URL('/mcp', endpoint.url));

            const error = await rejection(transport.send(message));

            expect(error.message).toContain(`Redirect to ${endpoint.url.origin}/mcp/ not followed`);
            expect(endpoint.requests).toHaveLength(1);
        });

        it('does not follow a protocol-relative redirect to another origin', async () => {
            const endpoint = await startServer(redirectTo(307, `//${other.url.host}/mcp`));
            await connectTo(new URL('/mcp', endpoint.url));

            const error = await rejection(transport.send(message));

            expect(error.message).toContain(`Redirect to ${other.url.origin}/mcp not followed`);
            expect(other.requests).toEqual([]);
        });

        it('does not follow a redirect whose Location brings userinfo', async () => {
            const endpoint = await startServer(
                routes({ 'POST /mcp': (request, res) => redirectTo(307, `http://user:pass@${request.headers.host}/mcp/`)(request, res) })
            );
            await connectTo(new URL('/mcp', endpoint.url));

            const error = await rejection(transport.send(message));

            expect(error.message).toContain(`Redirect to ${endpoint.url.origin}/mcp/ not followed`);
            expect(endpoint.requests).toHaveLength(1);
        });

        it('follows five redirects and hands the sixth back', async () => {
            const endpoint = await startServer((request, res) =>
                redirectTo(307, `/hop/${Number(request.path.split('/')[2]) + 1}`)(request, res)
            );
            await connectTo(new URL('/hop/0', endpoint.url));

            const error = await rejection(transport.send(message));

            expect(error.message).toContain(`Redirect to ${endpoint.url.origin}/hop/6 not followed`);
            expect(endpoint.requests.map(request => request.path)).toEqual(['/hop/0', '/hop/1', '/hop/2', '/hop/3', '/hop/4', '/hop/5']);
        });

        it('suggests the https URL when an https endpoint redirects to http', async () => {
            let calls = 0;
            const fetchFn: FetchLike = async () => {
                calls++;
                return new Response(null, { status: 307, headers: { location: 'http://example.com/mcp/?a=1' } });
            };
            await connectTo('https://example.com/mcp', fetchFn);

            const error = await rejection(transport.send(message));

            expect(error.message).toBe(
                "Streamable HTTP error: Error POSTing to endpoint: Redirect to plain http not followed; try https://example.com/mcp/ instead (redirectPolicy: 'same-origin')"
            );
            expect(calls).toBe(1);
        });

        it.each([307, 308])('follows a %i of a POST within the origin with the same method, headers and body', async status => {
            const endpoint = await startServer(routes({ 'POST /mcp': redirectTo(status, '/mcp/'), 'POST /mcp/': accepted }));
            await connectTo(new URL('/mcp', endpoint.url));

            await transport.send(message);

            expect(endpoint.requests.map(request => `${request.method} ${request.path}`)).toEqual(['POST /mcp', 'POST /mcp/']);
            expect(endpoint.requests[1].body).toBe(JSON.stringify(message));
            expect(endpoint.requests[1].headers).toEqual(endpoint.requests[0].headers);
            expect(endpoint.requests[1].headers).toMatchObject({ 'x-api-key': 'key-1', 'mcp-session-id': 'session-1' });
        });

        it.each(redirectStatuses)('follows a %i of the GET listen stream within the origin', async status => {
            const notification: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
            const endpoint = await startServer(
                routes({
                    'GET /mcp': redirectTo(status, '/mcp/'),
                    'GET /mcp/': (_request, res) => {
                        res.writeHead(200, { 'content-type': 'text/event-stream' });
                        res.write(`data: ${JSON.stringify(notification)}\n\n`);
                    }
                })
            );
            await connectTo(new URL('/mcp', endpoint.url));
            const received = new Promise<JSONRPCMessage>(resolve => (transport.onmessage = resolve));

            await transport.resumeStream('event-1');

            expect(await received).toEqual(notification);
            expect(endpoint.requests.map(request => `${request.method} ${request.path}`)).toEqual(['GET /mcp', 'GET /mcp/']);
            expect(endpoint.requests[1].headers).toEqual(endpoint.requests[0].headers);
            expect(endpoint.requests[1].headers).toMatchObject({
                'x-api-key': 'key-1',
                'mcp-session-id': 'session-1',
                'last-event-id': 'event-1'
            });
        });

        it('follows a 307 of the session DELETE within the origin', async () => {
            const endpoint = await startServer(routes({ 'DELETE /mcp': redirectTo(307, '/mcp/'), 'DELETE /mcp/': json({}) }));
            await connectTo(new URL('/mcp', endpoint.url));

            await transport.terminateSession();

            expect(endpoint.requests.map(request => `${request.method} ${request.path}`)).toEqual(['DELETE /mcp', 'DELETE /mcp/']);
            expect(endpoint.requests[1].headers).toMatchObject({ 'x-api-key': 'key-1', 'mcp-session-id': 'session-1' });
            expect(transport.sessionId).toBeUndefined();
        });

        it('follows a relative redirect when the endpoint URL carries userinfo', async () => {
            const endpoint = await startServer(routes({ 'POST /mcp': redirectTo(307, '/mcp/'), 'POST /mcp/': accepted }));
            // fetch() itself does not take userinfo in a URL, so this fetch moves it out of the URL.
            const fetchFn: FetchLike = (url, init) => {
                const target = new URL(url);
                target.username = target.password = '';
                return fetch(target, init);
            };
            const url = new URL('/mcp', endpoint.url);
            url.username = 'user';
            url.password = 'pass';
            await connectTo(url, fetchFn);

            await transport.send(message);

            expect(endpoint.requests.map(request => `${request.method} ${request.path}`)).toEqual(['POST /mcp', 'POST /mcp/']);
            expect(endpoint.requests[1].body).toBe(JSON.stringify(message));
        });

        it('sends a request that is not redirected once', async () => {
            const endpoint = await startServer(accepted);
            await connectTo(new URL('/mcp', endpoint.url));

            await transport.send(message);

            expect(endpoint.requests).toHaveLength(1);
            expect(endpoint.requests[0]).toMatchObject({
                method: 'POST',
                path: '/mcp',
                body: JSON.stringify(message),
                headers: { 'x-api-key': 'key-1', 'mcp-session-id': 'session-1', 'content-type': 'application/json' }
            });
        });
    });

    describe('SSEClientTransport', () => {
        let transport: SSEClientTransport;

        function createTransport(url: URL, options: ConstructorParameters<typeof SSEClientTransport>[1] = {}): SSEClientTransport {
            transport = new SSEClientTransport(url, { requestInit: { headers: { 'x-api-key': 'key-1' } }, ...options });
            transport.onerror = () => {};
            return transport;
        }

        afterEach(async () => {
            await transport?.close();
        });

        it.each([
            ['the default fetch', {}],
            ['the fetch option', { fetch: (url: string | URL, init?: RequestInit) => fetch(url, init) }],
            ['eventSourceInit.fetch', { eventSourceInit: { fetch: (url: string | URL, init?: RequestInit) => fetch(url, init) } }]
        ])('does not follow a redirect of the listen stream to another origin with %s', async (_name, options) => {
            const endpoint = await startServer(redirectTo(307, new URL('/sse?from=endpoint', other.url).href));
            createTransport(new URL('/sse', endpoint.url), options);

            const error = await rejection(transport.start());

            expect(error).toBeInstanceOf(SseError);
            expect(error.message).toBe(`SSE error: Redirect to ${other.url.origin}/sse not followed (redirectPolicy: 'same-origin')`);
            expect((error as SseError).code).toBe(307);
            expect(endpoint.requests).toHaveLength(1);
            expect(other.requests).toEqual([]);
        });

        it('does not follow a redirect of a POST to another origin, and keeps the connection', async () => {
            let moved = true;
            const endpoint = await startServer(
                routes({
                    'GET /sse': sseStream,
                    'POST /messages': (request, res) =>
                        moved ? redirectTo(307, new URL('/messages', other.url).href)(request, res) : accepted(request, res)
                })
            );
            createTransport(new URL('/sse', endpoint.url));
            await transport.start();

            const error = await rejection(transport.send(message));

            expect(error.message).toBe(
                `Error POSTing to endpoint (HTTP 307): Redirect to ${other.url.origin}/messages not followed (redirectPolicy: 'same-origin')`
            );
            expect(other.requests).toEqual([]);

            moved = false;
            await transport.send(message);

            expect(endpoint.requests[endpoint.requests.length - 1]).toMatchObject({
                method: 'POST',
                body: JSON.stringify(message),
                headers: { 'x-api-key': 'key-1' }
            });
        });

        it.each(redirectStatuses)('follows a %i of the listen stream within the origin', async status => {
            const endpoint = await startServer(
                routes({ 'GET /sse': redirectTo(status, '/sse/'), 'GET /sse/': sseStream, 'POST /messages': accepted })
            );
            createTransport(new URL('/sse', endpoint.url));

            await transport.start();
            await transport.send(message);

            expect(endpoint.requests.map(request => `${request.method} ${request.path}`)).toEqual([
                'GET /sse',
                'GET /sse/',
                'POST /messages'
            ]);
            expect(endpoint.requests[1].headers).toMatchObject({ 'x-api-key': 'key-1', accept: 'text/event-stream' });
        });

        it('follows a 307 of a POST within the origin with the same method, headers and body', async () => {
            const endpoint = await startServer(
                routes({ 'GET /sse': sseStream, 'POST /messages': redirectTo(307, '/messages/'), 'POST /messages/': accepted })
            );
            createTransport(new URL('/sse', endpoint.url));
            await transport.start();

            await transport.send(message);

            expect(endpoint.requests.map(request => `${request.method} ${request.path}`)).toEqual([
                'GET /sse',
                'POST /messages',
                'POST /messages/'
            ]);
            expect(endpoint.requests[2].body).toBe(JSON.stringify(message));
            expect(endpoint.requests[2].headers).toEqual(endpoint.requests[1].headers);
        });
    });

    describe('OAuth requests', () => {
        const metadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code']
        };
        const tokens = { access_token: 'access-1', token_type: 'Bearer' };
        const clientInformation = { client_id: 'client-1', client_secret: 'client-secret-1' };
        const clientMetadata = { redirect_uris: ['http://localhost:3000/callback'], client_name: 'Test client' };
        const exchange = {
            clientInformation,
            authorizationCode: 'code-1',
            codeVerifier: 'verifier-1',
            redirectUri: 'http://localhost:3000/callback'
        };

        it('tries the next authorization server metadata URL when one redirects to another origin', async () => {
            const endpoint = await startServer(
                routes({
                    'GET /.well-known/oauth-authorization-server': redirectTo(302, new URL('/metadata', other.url).href),
                    'GET /.well-known/openid-configuration': json({
                        ...metadata,
                        jwks_uri: 'https://auth.example.com/jwks',
                        subject_types_supported: ['public'],
                        id_token_signing_alg_values_supported: ['RS256']
                    })
                })
            );

            const discovered = await discoverAuthorizationServerMetadata(endpoint.url);

            expect(discovered).toMatchObject(metadata);
            expect(other.requests).toEqual([]);
        });

        it('tries the root protected resource metadata URL when the path-aware one redirects to another origin', async () => {
            const resourceMetadata = { resource: 'https://resource.example.com/mcp', authorization_servers: ['https://auth.example.com'] };
            const endpoint = await startServer(
                routes({
                    'GET /.well-known/oauth-protected-resource/mcp': redirectTo(302, new URL('/metadata', other.url).href),
                    'GET /.well-known/oauth-protected-resource': json(resourceMetadata)
                })
            );

            const discovered = await discoverOAuthProtectedResourceMetadata(new URL('/mcp', endpoint.url));

            expect(discovered).toEqual(resourceMetadata);
            expect(other.requests).toEqual([]);
        });

        it('does not follow a redirect of a registration request to another origin', async () => {
            const endpoint = await startServer(redirectTo(307, new URL('/register?from=endpoint', other.url).href));

            const error = await rejection(registerClient(endpoint.url, { clientMetadata }));

            expect(error.message).toBe(`HTTP 307: Redirect to ${other.url.origin}/register not followed`);
            expect(other.requests).toEqual([]);
        });

        it.each([
            ['the default fetch', undefined],
            ['a fetchFn', (url: string | URL, init?: RequestInit) => fetch(url, init)]
        ])('does not follow a redirect of a token request to another origin with %s', async (_name, fetchFn) => {
            const endpoint = await startServer(redirectTo(307, new URL('/token', other.url).href));

            const exchangeError = await rejection(exchangeAuthorization(endpoint.url, { ...exchange, fetchFn }));
            const refreshError = await rejection(
                refreshAuthorization(endpoint.url, { clientInformation, refreshToken: 'refresh-1', fetchFn })
            );

            expect(exchangeError.message).toBe(`HTTP 307: Redirect to ${other.url.origin}/token not followed`);
            expect(refreshError.message).toBe(`HTTP 307: Redirect to ${other.url.origin}/token not followed`);
            expect(endpoint.requests).toHaveLength(2);
            expect(other.requests).toEqual([]);
        });

        it('follows a 307 of a token request within the origin with the same headers and body', async () => {
            const endpoint = await startServer(routes({ 'POST /token': redirectTo(307, '/token/'), 'POST /token/': json(tokens) }));

            const result = await exchangeAuthorization(endpoint.url, exchange);

            expect(result).toEqual(tokens);
            expect(endpoint.requests.map(request => `${request.method} ${request.path}`)).toEqual(['POST /token', 'POST /token/']);
            expect(endpoint.requests[1].body).toBe(endpoint.requests[0].body);
            expect(endpoint.requests[1].headers).toEqual(endpoint.requests[0].headers);
            expect(new URLSearchParams(endpoint.requests[1].body).get('code')).toBe('code-1');
        });

        it('follows a redirect of a metadata request within the origin', async () => {
            const endpoint = await startServer(
                routes({
                    'GET /.well-known/oauth-authorization-server': redirectTo(301, '/metadata'),
                    'GET /metadata': json(metadata)
                })
            );

            const discovered = await discoverAuthorizationServerMetadata(endpoint.url);

            expect(discovered).toMatchObject(metadata);
        });
    });

    describe("with redirectPolicy set to 'follow'", () => {
        let second: TestServer;
        let transport: StreamableHTTPClientTransport | SSEClientTransport;

        const options = { requestInit: { headers: { 'x-api-key': 'key-1' } }, redirectPolicy: 'follow' as const };
        const authorizationServerMetadata = (issuer: URL) => ({
            issuer: issuer.origin,
            authorization_endpoint: new URL('/authorize', issuer).href,
            token_endpoint: new URL('/token', issuer).href,
            response_types_supported: ['code']
        });
        const requestLines = (server: TestServer) => server.requests.map(request => `${request.method} ${request.path}`);
        const toSecond: Handler = (request, res) => redirectTo(307, new URL(request.path, second.url).href)(request, res);
        const passThrough = (url: string | URL, init?: RequestInit) => fetch(url, init);
        const discoveredAt = (server: TestServer) => () => ({
            authorizationServerUrl: server.url.origin,
            resourceMetadata: { resource: new URL('/mcp', server.url).href, authorization_servers: [server.url.origin] },
            authorizationServerMetadata: authorizationServerMetadata(server.url)
        });

        /** A provider that holds client information and an authorization code verifier, and records the tokens it is given. */
        function createProvider(saved: unknown[], discoveryState?: OAuthClientProvider['discoveryState']): OAuthClientProvider {
            return {
                redirectUrl: 'http://localhost:3000/callback',
                clientMetadata: { redirect_uris: ['http://localhost:3000/callback'] },
                clientInformation: () => ({ client_id: 'client-1' }),
                tokens: () => undefined,
                saveTokens: tokens => void saved.push(tokens),
                redirectToAuthorization: () => {},
                saveCodeVerifier: () => {},
                codeVerifier: () => 'verifier-1',
                discoveryState
            };
        }

        async function connectStreamableHttp(url: URL, fetch?: FetchLike): Promise<StreamableHTTPClientTransport> {
            const streamableHttp = new StreamableHTTPClientTransport(url, { ...options, sessionId: 'session-1', fetch });
            transport = streamableHttp;
            transport.onerror = () => {};
            await transport.start();
            return streamableHttp;
        }

        beforeEach(async () => {
            second = await startServer(
                routes({
                    'GET /mcp': (_request, res) => void res.writeHead(405).end(),
                    'POST /mcp': accepted,
                    'DELETE /mcp': json({}),
                    'GET /sse': sseStream,
                    'POST /messages': accepted,
                    'POST /token': json({ access_token: 'access-1', token_type: 'Bearer' })
                })
            );
        });

        afterEach(async () => {
            await transport?.close();
        });

        it.each([
            ['the default fetch', undefined],
            ['the fetch option', passThrough]
        ])('follows a 307 of a Streamable HTTP POST to another origin with %s', async (_name, fetchFn) => {
            const endpoint = await startServer(toSecond);
            const streamableHttp = await connectStreamableHttp(new URL('/mcp', endpoint.url), fetchFn);

            await streamableHttp.send(message);

            expect(requestLines(second)).toEqual(['POST /mcp']);
            expect(second.requests[0].body).toBe(JSON.stringify(message));
            expect(second.requests[0].headers).toEqual({ ...endpoint.requests[0].headers, host: second.url.host });
            expect(second.requests[0].headers).toMatchObject({ 'x-api-key': 'key-1', 'mcp-session-id': 'session-1' });
        });

        it('follows a 307 of the Streamable HTTP GET listen stream to another origin', async () => {
            const endpoint = await startServer(toSecond);
            const streamableHttp = await connectStreamableHttp(new URL('/mcp', endpoint.url));

            await streamableHttp.resumeStream('event-1');

            expect(requestLines(second)).toEqual(['GET /mcp']);
            expect(second.requests[0].headers).toEqual({ ...endpoint.requests[0].headers, host: second.url.host });
            expect(second.requests[0].headers).toMatchObject({ 'x-api-key': 'key-1', 'last-event-id': 'event-1' });
        });

        it('follows a 307 of the Streamable HTTP session DELETE to another origin', async () => {
            const endpoint = await startServer(toSecond);
            const streamableHttp = await connectStreamableHttp(new URL('/mcp', endpoint.url));

            await streamableHttp.terminateSession();

            expect(requestLines(second)).toEqual(['DELETE /mcp']);
            expect(second.requests[0].headers).toMatchObject({ 'x-api-key': 'key-1', 'mcp-session-id': 'session-1' });
            expect(streamableHttp.sessionId).toBeUndefined();
        });

        it("keeps a transport set to 'same-origin' as it is when another one with the same fetch is set to 'follow'", async () => {
            const endpoint = await startServer(toSecond);
            const following = await connectStreamableHttp(new URL('/mcp', endpoint.url), passThrough);
            const sameOrigin = new StreamableHTTPClientTransport(new URL('/mcp', endpoint.url), {
                ...options,
                redirectPolicy: 'same-origin',
                fetch: passThrough
            });
            await sameOrigin.start();

            await following.send(message);
            const error = await rejection(sameOrigin.send(message));
            await sameOrigin.close();

            expect(error.message).toContain(`Redirect to ${second.url.origin}/mcp not followed`);
            expect(requestLines(second)).toEqual(['POST /mcp']);
        });

        it("keeps another transport and a direct auth() call with the default fetch as they are when a transport is set to 'follow'", async () => {
            const endpoint = await startServer(toSecond);
            const following = await connectStreamableHttp(new URL('/mcp', endpoint.url));
            const byDefault = new StreamableHTTPClientTransport(new URL('/mcp', endpoint.url));
            await byDefault.start();
            const saved: unknown[] = [];
            const authProvider = createProvider(saved, discoveredAt(endpoint));

            await following.send(message);
            const sendError = await rejection(byDefault.send(message));
            const authError = await rejection(
                auth(authProvider, { serverUrl: new URL('/mcp', endpoint.url), authorizationCode: 'code-1' })
            );
            await byDefault.close();

            expect(sendError.message).toContain(`Redirect to ${second.url.origin}/mcp not followed`);
            expect(authError.message).toContain(`Redirect to ${second.url.origin}/token not followed`);
            expect(saved).toEqual([]);
            expect(requestLines(second)).toEqual(['POST /mcp']);
        });

        it('uses a redirect response that the fetch option returns for the Streamable HTTP GET listen stream as it is', async () => {
            const inits: (RequestInit | undefined)[] = [];
            const fetchFn: FetchLike = async (_url, init) => {
                inits.push(init);
                return new Response(null, { status: 307, headers: { location: '/mcp/' } });
            };
            const streamableHttp = await connectStreamableHttp(new URL('https://example.com/mcp'), fetchFn);

            const error = await rejection(streamableHttp.resumeStream('event-1'));

            expect(error).toBeInstanceOf(StreamableHTTPError);
            expect((error as StreamableHTTPError).code).toBe(307);
            expect(inits.map(init => Object.keys(init ?? {}))).toEqual([['method', 'headers', 'signal']]);
        });

        it.each([
            ['the default fetch', {}],
            ['the fetch option', { fetch: passThrough }],
            ['eventSourceInit.fetch', { eventSourceInit: { fetch: passThrough } }]
        ])('follows a 307 of the SSE listen stream to another origin with %s', async (_name, fetchOptions) => {
            const endpoint = await startServer(routes({ 'GET /sse': toSecond, 'POST /messages': accepted }));
            transport = new SSEClientTransport(new URL('/sse', endpoint.url), { ...options, ...fetchOptions });

            await transport.start();
            await transport.send(message);

            expect(requestLines(second)).toEqual(['GET /sse']);
            expect(second.requests[0].headers).toMatchObject({ 'x-api-key': 'key-1', accept: 'text/event-stream' });
            expect(requestLines(endpoint)).toEqual(['GET /sse', 'POST /messages']);
        });

        it('follows a 307 of an SSE POST to another origin with the same method, headers and body', async () => {
            const endpoint = await startServer(routes({ 'GET /sse': sseStream, 'POST /messages': toSecond }));
            transport = new SSEClientTransport(new URL('/sse', endpoint.url), options);
            await transport.start();

            await transport.send(message);

            expect(requestLines(second)).toEqual(['POST /messages']);
            expect(second.requests[0].body).toBe(JSON.stringify(message));
            expect(second.requests[0].headers).toEqual({ ...endpoint.requests[1].headers, host: second.url.host });
        });

        it.each([
            [
                'Streamable HTTP',
                (url: URL, authProvider: OAuthClientProvider) => new StreamableHTTPClientTransport(url, { ...options, authProvider })
            ],
            ['SSE', (url: URL, authProvider: OAuthClientProvider) => new SSEClientTransport(url, { ...options, authProvider })]
        ])('follows a 307 of the token request of the %s transport to another origin', async (_name, create) => {
            const endpoint = await startServer(toSecond);
            const saved: unknown[] = [];
            const authProvider = createProvider(saved, () => ({
                authorizationServerUrl: endpoint.url.origin,
                resourceMetadata: { resource: new URL('/mcp', endpoint.url).href, authorization_servers: [endpoint.url.origin] },
                authorizationServerMetadata: authorizationServerMetadata(endpoint.url)
            }));
            transport = create(new URL('/mcp', endpoint.url), authProvider);

            await transport.finishAuth('code-1');

            expect(saved).toMatchObject([{ access_token: 'access-1' }]);
            expect(requestLines(second)).toEqual(['POST /token']);
            expect(second.requests[0].headers).toEqual({ ...endpoint.requests[0].headers, host: second.url.host });
            expect(second.requests[0].headers).toMatchObject({ 'x-api-key': 'key-1' });
            expect(new URLSearchParams(second.requests[0].body).get('code')).toBe('code-1');
        });

        it('follows a 307 of the token request that a 403 with insufficient_scope starts to another origin', async () => {
            let scoped = false;
            const endpoint = await startServer(
                routes({
                    'POST /mcp': (request, res) => {
                        if (scoped) {
                            return accepted(request, res);
                        }
                        scoped = true;
                        res.writeHead(403, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="tools"' }).end();
                    },
                    'POST /token': toSecond
                })
            );
            const saved: unknown[] = [];
            const authProvider: OAuthClientProvider = {
                ...createProvider(saved, discoveredAt(endpoint)),
                tokens: () => ({ access_token: 'access-0', token_type: 'Bearer', refresh_token: 'refresh-1', issuer: endpoint.url.origin })
            };
            transport = new StreamableHTTPClientTransport(new URL('/mcp', endpoint.url), { ...options, authProvider });

            await transport.send(message);

            expect(saved).toMatchObject([{ access_token: 'access-1' }]);
            expect(requestLines(second)).toEqual(['POST /token']);
            expect(new URLSearchParams(second.requests[0].body).get('refresh_token')).toBe('refresh-1');
            expect(requestLines(endpoint)).toEqual(['POST /mcp', 'POST /token', 'POST /mcp']);
        });

        it('follows redirects of the metadata requests of a transport to another origin', async () => {
            const endpoint = await startServer(toSecond);
            second = await startServer(
                routes({
                    'GET /.well-known/oauth-protected-resource/mcp': json({
                        resource: new URL('/mcp', endpoint.url).href,
                        authorization_servers: [endpoint.url.origin]
                    }),
                    'GET /.well-known/oauth-authorization-server': json(authorizationServerMetadata(endpoint.url)),
                    'POST /token': json({ access_token: 'access-1', token_type: 'Bearer' })
                })
            );
            const saved: unknown[] = [];
            transport = new StreamableHTTPClientTransport(new URL('/mcp', endpoint.url), {
                ...options,
                authProvider: createProvider(saved)
            });

            await transport.finishAuth('code-1');

            expect(saved).toMatchObject([{ access_token: 'access-1' }]);
            expect(requestLines(second)).toEqual([
                'GET /.well-known/oauth-protected-resource/mcp',
                'GET /.well-known/oauth-authorization-server',
                'POST /token'
            ]);
        });
    });

    describe("with redirectPolicy set to a value other than 'follow'", () => {
        const values: [string, unknown][] = [
            ["'same-origin'", 'same-origin'],
            ["'other'", 'other'],
            ["'Follow'", 'Follow'],
            ["'follow' in an array", ['follow']],
            ["'follow' as a String object", new String('follow')],
            ['true', true],
            ['null', null]
        ];

        it.each(values)('does not follow a redirect of a Streamable HTTP POST to another origin with %s', async (_name, value) => {
            const endpoint = await startServer(redirectTo(307, new URL('/mcp', other.url).href));
            const transport = new StreamableHTTPClientTransport(new URL('/mcp', endpoint.url), { redirectPolicy: value as 'same-origin' });
            await transport.start();

            const error = await rejection(transport.send(message));
            await transport.close();

            expect(error.message).toContain(`Redirect to ${other.url.origin}/mcp not followed (redirectPolicy: 'same-origin')`);
            expect(other.requests).toEqual([]);
        });

        it.each(values)('does not follow a redirect of the SSE listen stream to another origin with %s', async (_name, value) => {
            const endpoint = await startServer(redirectTo(307, new URL('/sse', other.url).href));
            const transport = new SSEClientTransport(new URL('/sse', endpoint.url), { redirectPolicy: value as 'same-origin' });

            const error = await rejection(transport.start());
            await transport.close();

            expect(error.message).toContain(`Redirect to ${other.url.origin}/sse not followed (redirectPolicy: 'same-origin')`);
            expect(other.requests).toEqual([]);
        });
    });
});
