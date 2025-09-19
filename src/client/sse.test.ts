import { createServer, ServerResponse, type IncomingMessage, type Server } from 'http';
import { AddressInfo } from 'net';
import { JSONRPCMessage } from '../types.js';
import { SSEClientTransport } from './sse.js';
import { OAuthClientProvider, UnauthorizedError } from './auth.js';
import { OAuthTokens } from '../shared/auth.js';
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from '../server/auth/errors.js';

describe('SSEClientTransport', () => {
    let resourceServer: Server;
    let authServer: Server;
    let transport: SSEClientTransport;
    let resourceBaseUrl: URL;
    let authBaseUrl: URL;
    let lastServerRequest: IncomingMessage;
    let sendServerMessage: ((message: string) => void) | null = null;

    beforeEach(done => {
        // Reset state
        lastServerRequest = null as unknown as IncomingMessage;
        sendServerMessage = null;

        authServer = createServer((req, res) => {
            if (req.url === '/.well-known/oauth-authorization-server') {
                res.writeHead(200, {
                    'Content-Type': 'application/json'
                });
                res.end(
                    JSON.stringify({
                        issuer: 'https://auth.example.com',
                        authorization_endpoint: 'https://auth.example.com/authorize',
                        token_endpoint: 'https://auth.example.com/token',
                        registration_endpoint: 'https://auth.example.com/register',
                        response_types_supported: ['code'],
                        code_challenge_methods_supported: ['S256']
                    })
                );
                return;
            }
            res.writeHead(401).end();
        });

        // Create a test server that will receive the EventSource connection
        resourceServer = createServer((req, res) => {
            lastServerRequest = req;

            // Send SSE headers
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive'
            });

            // Send the endpoint event
            res.write('event: endpoint\n');
            res.write(`data: ${resourceBaseUrl.href}\n\n`);

            // Store reference to send function for tests
            sendServerMessage = (message: string) => {
                res.write(`data: ${message}\n\n`);
            };

            // Handle request body for POST endpoints
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => {
                    body += chunk;
                });
                req.on('end', () => {
                    (req as IncomingMessage & { body: string }).body = body;
                    res.end();
                });
            }
        });

        // Start server on random port
        resourceServer.listen(0, '127.0.0.1', () => {
            const addr = resourceServer.address() as AddressInfo;
            resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
            done();
        });

        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
        await transport.close();
        await resourceServer.close();
        await authServer.close();

        jest.clearAllMocks();
    });

    describe('connection handling', () => {
        it('establishes SSE connection and receives endpoint', async () => {
            transport = new SSEClientTransport(resourceBaseUrl);
            await transport.start();

            expect(lastServerRequest.headers.accept).toBe('text/event-stream');
            expect(lastServerRequest.method).toBe('GET');
        });

        it('rejects if server returns non-200 status', async () => {
            // Create a server that returns 403
            await resourceServer.close();

            resourceServer = createServer((req, res) => {
                res.writeHead(403);
                res.end();
            });

            await new Promise<void>(resolve => {
                resourceServer.listen(0, '127.0.0.1', () => {
                    const addr = resourceServer.address() as AddressInfo;
                    resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(resourceBaseUrl);
            await expect(transport.start()).rejects.toThrow();
        });

        it('closes EventSource connection on close()', async () => {
            transport = new SSEClientTransport(resourceBaseUrl);
            await transport.start();

            const closePromise = new Promise(resolve => {
                lastServerRequest.on('close', resolve);
            });

            await transport.close();
            await closePromise;
        });
    });

    describe('message handling', () => {
        it('receives and parses JSON-RPC messages', async () => {
            const receivedMessages: JSONRPCMessage[] = [];
            transport = new SSEClientTransport(resourceBaseUrl);
            transport.onmessage = msg => receivedMessages.push(msg);

            await transport.start();

            const testMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 'test-1',
                method: 'test',
                params: { foo: 'bar' }
            };

            sendServerMessage!(JSON.stringify(testMessage));

            // Wait for message processing
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(receivedMessages).toHaveLength(1);
            expect(receivedMessages[0]).toEqual(testMessage);
        });

        it('handles malformed JSON messages', async () => {
            const errors: Error[] = [];
            transport = new SSEClientTransport(resourceBaseUrl);
            transport.onerror = err => errors.push(err);

            await transport.start();

            sendServerMessage!('invalid json');

            // Wait for message processing
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(errors).toHaveLength(1);
            expect(errors[0].message).toMatch(/JSON/);
        });

        it('handles messages via POST requests', async () => {
            transport = new SSEClientTransport(resourceBaseUrl);
            await transport.start();

            const testMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 'test-1',
                method: 'test',
                params: { foo: 'bar' }
            };

            await transport.send(testMessage);

            // Wait for request processing
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(lastServerRequest.method).toBe('POST');
            expect(lastServerRequest.headers['content-type']).toBe('application/json');
            expect(JSON.parse((lastServerRequest as IncomingMessage & { body: string }).body)).toEqual(testMessage);
        });

        it('handles POST request failures', async () => {
            // Create a server that returns 500 for POST
            await resourceServer.close();

            resourceServer = createServer((req, res) => {
                if (req.method === 'GET') {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache, no-transform',
                        Connection: 'keep-alive'
                    });
                    res.write('event: endpoint\n');
                    res.write(`data: ${resourceBaseUrl.href}\n\n`);
                } else {
                    res.writeHead(500);
                    res.end('Internal error');
                }
            });

            await new Promise<void>(resolve => {
                resourceServer.listen(0, '127.0.0.1', () => {
                    const addr = resourceServer.address() as AddressInfo;
                    resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(resourceBaseUrl);
            await transport.start();

            const testMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 'test-1',
                method: 'test',
                params: {}
            };

            await expect(transport.send(testMessage)).rejects.toThrow(/500/);
        });
    });

    describe('header handling', () => {
        it('uses custom fetch implementation from EventSourceInit to add auth headers', async () => {
            const authToken = 'Bearer test-token';

            // Create a fetch wrapper that adds auth header
            const fetchWithAuth = (url: string | URL, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                headers.set('Authorization', authToken);
                return fetch(url.toString(), { ...init, headers });
            };

            transport = new SSEClientTransport(resourceBaseUrl, {
                eventSourceInit: {
                    fetch: fetchWithAuth
                }
            });

            await transport.start();

            // Verify the auth header was received by the server
            expect(lastServerRequest.headers.authorization).toBe(authToken);
        });

        it('uses custom fetch implementation from options', async () => {
            const authToken = 'Bearer custom-token';

            const fetchWithAuth = jest.fn((url: string | URL, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                headers.set('Authorization', authToken);
                return fetch(url.toString(), { ...init, headers });
            });

            transport = new SSEClientTransport(resourceBaseUrl, {
                fetch: fetchWithAuth
            });

            await transport.start();

            expect(lastServerRequest.headers.authorization).toBe(authToken);

            // Send a message to verify fetchWithAuth used for POST as well
            const message: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: '1',
                method: 'test',
                params: {}
            };

            await transport.send(message);

            expect(fetchWithAuth).toHaveBeenCalledTimes(2);
            expect(lastServerRequest.method).toBe('POST');
            expect(lastServerRequest.headers.authorization).toBe(authToken);
        });

        it('passes custom headers to fetch requests', async () => {
            const customHeaders = {
                Authorization: 'Bearer test-token',
                'X-Custom-Header': 'custom-value'
            };

            transport = new SSEClientTransport(resourceBaseUrl, {
                requestInit: {
                    headers: customHeaders
                }
            });

            await transport.start();

            // Store original fetch
            const originalFetch = global.fetch;

            try {
                // Mock fetch for the message sending test
                global.fetch = jest.fn().mockResolvedValue({
                    ok: true
                });

                const message: JSONRPCMessage = {
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'test',
                    params: {}
                };

                await transport.send(message);

                // Verify fetch was called with correct headers
                expect(global.fetch).toHaveBeenCalledWith(
                    expect.any(URL),
                    expect.objectContaining({
                        headers: expect.any(Headers)
                    })
                );

                const calledHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers;
                expect(calledHeaders.get('Authorization')).toBe(customHeaders.Authorization);
                expect(calledHeaders.get('X-Custom-Header')).toBe(customHeaders['X-Custom-Header']);
                expect(calledHeaders.get('content-type')).toBe('application/json');
            } finally {
                // Restore original fetch
                global.fetch = originalFetch;
            }
        });
    });

    describe('auth handling', () => {
        const authServerMetadataUrls = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'];

        let mockAuthProvider: jest.Mocked<OAuthClientProvider>;

        beforeEach(() => {
            mockAuthProvider = {
                get redirectUrl() {
                    return 'http://localhost/callback';
                },
                get clientMetadata() {
                    return { redirect_uris: ['http://localhost/callback'] };
                },
                clientInformation: jest.fn(() => ({ client_id: 'test-client-id', client_secret: 'test-client-secret' })),
                tokens: jest.fn(),
                saveTokens: jest.fn(),
                redirectToAuthorization: jest.fn(),
                saveCodeVerifier: jest.fn(),
                codeVerifier: jest.fn(),
                invalidateCredentials: jest.fn()
            };
        });

        it('attaches auth header from provider on SSE connection', async () => {
            mockAuthProvider.tokens.mockResolvedValue({
                access_token: 'test-token',
                token_type: 'Bearer'
            });

            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider
            });

            await transport.start();

            expect(lastServerRequest.headers.authorization).toBe('Bearer test-token');
            expect(mockAuthProvider.tokens).toHaveBeenCalled();
        });

        it('attaches custom header from provider on initial SSE connection', async () => {
            mockAuthProvider.tokens.mockResolvedValue({
                access_token: 'test-token',
                token_type: 'Bearer'
            });
            const customHeaders = {
                'X-Custom-Header': 'custom-value'
            };

            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider,
                requestInit: {
                    headers: customHeaders
                }
            });

            await transport.start();

            expect(lastServerRequest.headers.authorization).toBe('Bearer test-token');
            expect(lastServerRequest.headers['x-custom-header']).toBe('custom-value');
            expect(mockAuthProvider.tokens).toHaveBeenCalled();
        });

        it('attaches auth header from provider on POST requests', async () => {
            mockAuthProvider.tokens.mockResolvedValue({
                access_token: 'test-token',
                token_type: 'Bearer'
            });

            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider
            });

            await transport.start();

            const message: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: '1',
                method: 'test',
                params: {}
            };

            await transport.send(message);

            expect(lastServerRequest.headers.authorization).toBe('Bearer test-token');
            expect(mockAuthProvider.tokens).toHaveBeenCalled();
        });

        it('attempts auth flow on 401 during SSE connection', async () => {
            // Create server that returns 401s
            resourceServer.close();
            authServer.close();

            // Start auth server on random port
            await new Promise<void>(resolve => {
                authServer.listen(0, '127.0.0.1', () => {
                    const addr = authServer.address() as AddressInfo;
                    authBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            resourceServer = createServer((req, res) => {
                lastServerRequest = req;

                if (req.url === '/.well-known/oauth-protected-resource') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json'
                    }).end(
                        JSON.stringify({
                            resource: resourceBaseUrl.href,
                            authorization_servers: [`${authBaseUrl}`]
                        })
                    );
                    return;
                }

                if (req.url !== '/') {
                    res.writeHead(404).end();
                } else {
                    res.writeHead(401).end();
                }
            });

            await new Promise<void>(resolve => {
                resourceServer.listen(0, '127.0.0.1', () => {
                    const addr = resourceServer.address() as AddressInfo;
                    resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider
            });

            await expect(() => transport.start()).rejects.toThrow(UnauthorizedError);
            expect(mockAuthProvider.redirectToAuthorization.mock.calls).toHaveLength(1);
        });

        it('attempts auth flow on 401 during POST request', async () => {
            // Create server that accepts SSE but returns 401 on POST
            resourceServer.close();
            authServer.close();

            await new Promise<void>(resolve => {
                authServer.listen(0, '127.0.0.1', () => {
                    const addr = authServer.address() as AddressInfo;
                    authBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            resourceServer = createServer((req, res) => {
                lastServerRequest = req;

                switch (req.method) {
                    case 'GET':
                        if (req.url === '/.well-known/oauth-protected-resource') {
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            }).end(
                                JSON.stringify({
                                    resource: resourceBaseUrl.href,
                                    authorization_servers: [`${authBaseUrl}`]
                                })
                            );
                            return;
                        }

                        if (req.url !== '/') {
                            res.writeHead(404).end();
                            return;
                        }

                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache, no-transform',
                            Connection: 'keep-alive'
                        });
                        res.write('event: endpoint\n');
                        res.write(`data: ${resourceBaseUrl.href}\n\n`);
                        break;

                    case 'POST':
                        res.writeHead(401);
                        res.end();
                        break;
                }
            });

            await new Promise<void>(resolve => {
                resourceServer.listen(0, '127.0.0.1', () => {
                    const addr = resourceServer.address() as AddressInfo;
                    resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider
            });

            await transport.start();

            const message: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: '1',
                method: 'test',
                params: {}
            };

            await expect(() => transport.send(message)).rejects.toThrow(UnauthorizedError);
            expect(mockAuthProvider.redirectToAuthorization.mock.calls).toHaveLength(1);
        });

        it('respects custom headers when using auth provider', async () => {
            mockAuthProvider.tokens.mockResolvedValue({
                access_token: 'test-token',
                token_type: 'Bearer'
            });

            const customHeaders = {
                'X-Custom-Header': 'custom-value'
            };

            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider,
                requestInit: {
                    headers: customHeaders
                }
            });

            await transport.start();

            const message: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: '1',
                method: 'test',
                params: {}
            };

            await transport.send(message);

            expect(lastServerRequest.headers.authorization).toBe('Bearer test-token');
            expect(lastServerRequest.headers['x-custom-header']).toBe('custom-value');
        });

        it('refreshes expired token during SSE connection', async () => {
            // Mock tokens() to return expired token until saveTokens is called
            let currentTokens: OAuthTokens = {
                access_token: 'expired-token',
                token_type: 'Bearer',
                refresh_token: 'refresh-token'
            };
            mockAuthProvider.tokens.mockImplementation(() => currentTokens);
            mockAuthProvider.saveTokens.mockImplementation(tokens => {
                currentTokens = tokens;
            });

            // Create server that returns 401 for expired token, then accepts new token
            resourceServer.close();
            authServer.close();

            authServer = createServer((req, res) => {
                if (req.url && authServerMetadataUrls.includes(req.url)) {
                    res.writeHead(404).end();
                    return;
                }

                if (req.url === '/token' && req.method === 'POST') {
                    // Handle token refresh request
                    let body = '';
                    req.on('data', chunk => {
                        body += chunk;
                    });
                    req.on('end', () => {
                        const params = new URLSearchParams(body);
                        if (
                            params.get('grant_type') === 'refresh_token' &&
                            params.get('refresh_token') === 'refresh-token' &&
                            params.get('client_id') === 'test-client-id' &&
                            params.get('client_secret') === 'test-client-secret'
                        ) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({
                                    access_token: 'new-token',
                                    token_type: 'Bearer',
                                    refresh_token: 'new-refresh-token'
                                })
                            );
                        } else {
                            res.writeHead(400).end();
                        }
                    });
                    return;
                }

                res.writeHead(401).end();
            });

            // Start auth server on random port
            await new Promise<void>(resolve => {
                authServer.listen(0, '127.0.0.1', () => {
                    const addr = authServer.address() as AddressInfo;
                    authBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            let connectionAttempts = 0;
            resourceServer = createServer((req, res) => {
                lastServerRequest = req;

                if (req.url === '/.well-known/oauth-protected-resource') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json'
                    }).end(
                        JSON.stringify({
                            resource: resourceBaseUrl.href,
                            authorization_servers: [`${authBaseUrl}`]
                        })
                    );
                    return;
                }

                if (req.url !== '/') {
                    res.writeHead(404).end();
                    return;
                }

                const auth = req.headers.authorization;
                if (auth === 'Bearer expired-token') {
                    res.writeHead(401).end();
                    return;
                }

                if (auth === 'Bearer new-token') {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache, no-transform',
                        Connection: 'keep-alive'
                    });
                    res.write('event: endpoint\n');
                    res.write(`data: ${resourceBaseUrl.href}\n\n`);
                    connectionAttempts++;
                    return;
                }

                res.writeHead(401).end();
            });

            await new Promise<void>(resolve => {
                resourceServer.listen(0, '127.0.0.1', () => {
                    const addr = resourceServer.address() as AddressInfo;
                    resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider
            });

            await transport.start();

            expect(mockAuthProvider.saveTokens).toHaveBeenCalledWith({
                access_token: 'new-token',
                token_type: 'Bearer',
                refresh_token: 'new-refresh-token'
            });
            expect(connectionAttempts).toBe(1);
            expect(lastServerRequest.headers.authorization).toBe('Bearer new-token');
        });

        it('refreshes expired token during POST request', async () => {
            // Mock tokens() to return expired token until saveTokens is called
            let currentTokens: OAuthTokens = {
                access_token: 'expired-token',
                token_type: 'Bearer',
                refresh_token: 'refresh-token'
            };
            mockAuthProvider.tokens.mockImplementation(() => currentTokens);
            mockAuthProvider.saveTokens.mockImplementation(tokens => {
                currentTokens = tokens;
            });

            // Create server that returns 401 for expired token, then accepts new token
            resourceServer.close();
            authServer.close();

            authServer = createServer((req, res) => {
                if (req.url && authServerMetadataUrls.includes(req.url)) {
                    res.writeHead(404).end();
                    return;
                }

                if (req.url === '/token' && req.method === 'POST') {
                    // Handle token refresh request
                    let body = '';
                    req.on('data', chunk => {
                        body += chunk;
                    });
                    req.on('end', () => {
                        const params = new URLSearchParams(body);
                        if (
                            params.get('grant_type') === 'refresh_token' &&
                            params.get('refresh_token') === 'refresh-token' &&
                            params.get('client_id') === 'test-client-id' &&
                            params.get('client_secret') === 'test-client-secret'
                        ) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({
                                    access_token: 'new-token',
                                    token_type: 'Bearer',
                                    refresh_token: 'new-refresh-token'
                                })
                            );
                        } else {
                            res.writeHead(400).end();
                        }
                    });
                    return;
                }

                res.writeHead(401).end();
            });

            // Start auth server on random port
            await new Promise<void>(resolve => {
                authServer.listen(0, '127.0.0.1', () => {
                    const addr = authServer.address() as AddressInfo;
                    authBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            let postAttempts = 0;
            resourceServer = createServer((req, res) => {
                lastServerRequest = req;

                if (req.url === '/.well-known/oauth-protected-resource') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json'
                    }).end(
                        JSON.stringify({
                            resource: resourceBaseUrl.href,
                            authorization_servers: [`${authBaseUrl}`]
                        })
                    );
                    return;
                }

                switch (req.method) {
                    case 'GET':
                        if (req.url !== '/') {
                            res.writeHead(404).end();
                            return;
                        }

                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache, no-transform',
                            Connection: 'keep-alive'
                        });
                        res.write('event: endpoint\n');
                        res.write(`data: ${resourceBaseUrl.href}\n\n`);
                        break;

                    case 'POST': {
                        if (req.url !== '/') {
                            res.writeHead(404).end();
                            return;
                        }

                        const auth = req.headers.authorization;
                        if (auth === 'Bearer expired-token') {
                            res.writeHead(401).end();
                            return;
                        }

                        if (auth === 'Bearer new-token') {
                            res.writeHead(200).end();
                            postAttempts++;
                            return;
                        }

                        res.writeHead(401).end();
                        break;
                    }
                }
            });

            await new Promise<void>(resolve => {
                resourceServer.listen(0, '127.0.0.1', () => {
                    const addr = resourceServer.address() as AddressInfo;
                    resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider
            });

            await transport.start();

            const message: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: '1',
                method: 'test',
                params: {}
            };

            await transport.send(message);

            expect(mockAuthProvider.saveTokens).toHaveBeenCalledWith({
                access_token: 'new-token',
                token_type: 'Bearer',
                refresh_token: 'new-refresh-token'
            });
            expect(postAttempts).toBe(1);
            expect(lastServerRequest.headers.authorization).toBe('Bearer new-token');
        });

        it('redirects to authorization if refresh token flow fails', async () => {
            // Mock tokens() to return expired token until saveTokens is called
            let currentTokens: OAuthTokens = {
                access_token: 'expired-token',
                token_type: 'Bearer',
                refresh_token: 'refresh-token'
            };
            mockAuthProvider.tokens.mockImplementation(() => currentTokens);
            mockAuthProvider.saveTokens.mockImplementation(tokens => {
                currentTokens = tokens;
            });

            // Create server that returns 401 for all tokens
            resourceServer.close();
            authServer.close();

            authServer = createServer((req, res) => {
                if (req.url && authServerMetadataUrls.includes(req.url)) {
                    res.writeHead(404).end();
                    return;
                }

                if (req.url === '/token' && req.method === 'POST') {
                    // Handle token refresh request - always fail
                    res.writeHead(400).end();
                    return;
                }

                res.writeHead(401).end();
            });

            // Start auth server on random port
            await new Promise<void>(resolve => {
                authServer.listen(0, '127.0.0.1', () => {
                    const addr = authServer.address() as AddressInfo;
                    authBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            resourceServer = createServer((req, res) => {
                lastServerRequest = req;

                if (req.url === '/.well-known/oauth-protected-resource') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json'
                    }).end(
                        JSON.stringify({
                            resource: resourceBaseUrl.href,
                            authorization_servers: [`${authBaseUrl}`]
                        })
                    );
                    return;
                }

                if (req.url !== '/') {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(401).end();
            });

            await new Promise<void>(resolve => {
                resourceServer.listen(0, '127.0.0.1', () => {
                    const addr = resourceServer.address() as AddressInfo;
                    resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider
            });

            await expect(() => transport.start()).rejects.toThrow(UnauthorizedError);
            expect(mockAuthProvider.redirectToAuthorization).toHaveBeenCalled();
        });

        it('invalidates all credentials on InvalidClientError during token refresh', async () => {
            // Mock tokens() to return token with refresh token
            mockAuthProvider.tokens.mockResolvedValue({
                access_token: 'expired-token',
                token_type: 'Bearer',
                refresh_token: 'refresh-token'
            });

            let baseUrl = resourceBaseUrl;

            // Create server that returns InvalidClientError on token refresh
            const server = createServer((req, res) => {
                lastServerRequest = req;

                // Handle OAuth metadata discovery
                if (req.url === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            issuer: baseUrl.href,
                            authorization_endpoint: `${baseUrl.href}authorize`,
                            token_endpoint: `${baseUrl.href}token`,
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    );
                    return;
                }

                if (req.url === '/token' && req.method === 'POST') {
                    // Handle token refresh request - return InvalidClientError
                    const error = new InvalidClientError('Client authentication failed');
                    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify(error.toResponseObject()));
                    return;
                }

                if (req.url !== '/') {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(401).end();
            });

            await new Promise<void>(resolve => {
                server.listen(0, '127.0.0.1', () => {
                    const addr = server.address() as AddressInfo;
                    baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(baseUrl, {
                authProvider: mockAuthProvider
            });

            await expect(() => transport.start()).rejects.toThrow(InvalidClientError);
            expect(mockAuthProvider.invalidateCredentials).toHaveBeenCalledWith('all');
        });

        it('invalidates all credentials on UnauthorizedClientError during token refresh', async () => {
            // Mock tokens() to return token with refresh token
            mockAuthProvider.tokens.mockResolvedValue({
                access_token: 'expired-token',
                token_type: 'Bearer',
                refresh_token: 'refresh-token'
            });

            let baseUrl = resourceBaseUrl;

            const server = createServer((req, res) => {
                lastServerRequest = req;

                // Handle OAuth metadata discovery
                if (req.url === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            issuer: baseUrl.href,
                            authorization_endpoint: `${baseUrl.href}authorize`,
                            token_endpoint: `${baseUrl.href}token`,
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    );
                    return;
                }

                if (req.url === '/token' && req.method === 'POST') {
                    // Handle token refresh request - return UnauthorizedClientError
                    const error = new UnauthorizedClientError('Client not authorized');
                    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify(error.toResponseObject()));
                    return;
                }

                if (req.url !== '/') {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(401).end();
            });

            await new Promise<void>(resolve => {
                server.listen(0, '127.0.0.1', () => {
                    const addr = server.address() as AddressInfo;
                    baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(baseUrl, {
                authProvider: mockAuthProvider
            });

            await expect(() => transport.start()).rejects.toThrow(UnauthorizedClientError);
            expect(mockAuthProvider.invalidateCredentials).toHaveBeenCalledWith('all');
        });

        it('invalidates tokens on InvalidGrantError during token refresh', async () => {
            // Mock tokens() to return token with refresh token
            mockAuthProvider.tokens.mockResolvedValue({
                access_token: 'expired-token',
                token_type: 'Bearer',
                refresh_token: 'refresh-token'
            });
            let baseUrl = resourceBaseUrl;

            const server = createServer((req, res) => {
                lastServerRequest = req;

                // Handle OAuth metadata discovery
                if (req.url === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            issuer: baseUrl.href,
                            authorization_endpoint: `${baseUrl.href}authorize`,
                            token_endpoint: `${baseUrl.href}token`,
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    );
                    return;
                }

                if (req.url === '/token' && req.method === 'POST') {
                    // Handle token refresh request - return InvalidGrantError
                    const error = new InvalidGrantError('Invalid refresh token');
                    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify(error.toResponseObject()));
                    return;
                }

                if (req.url !== '/') {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(401).end();
            });

            await new Promise<void>(resolve => {
                server.listen(0, '127.0.0.1', () => {
                    const addr = server.address() as AddressInfo;
                    baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });

            transport = new SSEClientTransport(baseUrl, {
                authProvider: mockAuthProvider
            });

            await expect(() => transport.start()).rejects.toThrow(InvalidGrantError);
            expect(mockAuthProvider.invalidateCredentials).toHaveBeenCalledWith('tokens');
        });
    });

    describe('custom fetch in auth code paths', () => {
        let customFetch: jest.MockedFunction<typeof fetch>;
        let globalFetchSpy: jest.SpyInstance;
        let mockAuthProvider: jest.Mocked<OAuthClientProvider>;
        let resourceServerHandler: jest.Mock<
            void,
            [
                IncomingMessage,
                ServerResponse<IncomingMessage> & {
                    req: IncomingMessage;
                }
            ],
            void
        >;

        /**
         * Helper function to create a mock auth provider with configurable behavior
         */
        const createMockAuthProvider = (
            config: {
                hasTokens?: boolean;
                tokensExpired?: boolean;
                hasRefreshToken?: boolean;
                clientRegistered?: boolean;
                authorizationCode?: string;
            } = {}
        ): jest.Mocked<OAuthClientProvider> => {
            const tokens = config.hasTokens
                ? {
                      access_token: config.tokensExpired ? 'expired-token' : 'valid-token',
                      token_type: 'Bearer' as const,
                      ...(config.hasRefreshToken && { refresh_token: 'refresh-token' })
                  }
                : undefined;

            const clientInfo = config.clientRegistered
                ? {
                      client_id: 'test-client-id',
                      client_secret: 'test-client-secret'
                  }
                : undefined;

            return {
                get redirectUrl() {
                    return 'http://localhost/callback';
                },
                get clientMetadata() {
                    return {
                        redirect_uris: ['http://localhost/callback'],
                        client_name: 'Test Client'
                    };
                },
                clientInformation: jest.fn().mockResolvedValue(clientInfo),
                tokens: jest.fn().mockResolvedValue(tokens),
                saveTokens: jest.fn(),
                redirectToAuthorization: jest.fn(),
                saveCodeVerifier: jest.fn(),
                codeVerifier: jest.fn().mockResolvedValue('test-verifier'),
                invalidateCredentials: jest.fn()
            };
        };

        const createCustomFetchMockAuthServer = async () => {
            authServer = createServer((req, res) => {
                if (req.url === '/.well-known/oauth-authorization-server') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            issuer: `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`,
                            authorization_endpoint: `http://127.0.0.1:${(authServer.address() as AddressInfo).port}/authorize`,
                            token_endpoint: `http://127.0.0.1:${(authServer.address() as AddressInfo).port}/token`,
                            registration_endpoint: `http://127.0.0.1:${(authServer.address() as AddressInfo).port}/register`,
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    );
                    return;
                }

                if (req.url === '/token' && req.method === 'POST') {
                    // Handle token exchange request
                    let body = '';
                    req.on('data', chunk => {
                        body += chunk;
                    });
                    req.on('end', () => {
                        const params = new URLSearchParams(body);
                        if (
                            params.get('grant_type') === 'authorization_code' &&
                            params.get('code') === 'test-auth-code' &&
                            params.get('client_id') === 'test-client-id'
                        ) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({
                                    access_token: 'new-access-token',
                                    token_type: 'Bearer',
                                    expires_in: 3600,
                                    refresh_token: 'new-refresh-token'
                                })
                            );
                        } else {
                            res.writeHead(400).end();
                        }
                    });
                    return;
                }

                res.writeHead(404).end();
            });

            // Start auth server on random port
            await new Promise<void>(resolve => {
                authServer.listen(0, '127.0.0.1', () => {
                    const addr = authServer.address() as AddressInfo;
                    authBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });
        };

        const createCustomFetchMockResourceServer = async () => {
            // Set up resource server that provides OAuth metadata
            resourceServer = createServer((req, res) => {
                lastServerRequest = req;

                if (req.url === '/.well-known/oauth-protected-resource') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            resource: resourceBaseUrl.href,
                            authorization_servers: [authBaseUrl.href]
                        })
                    );
                    return;
                }

                resourceServerHandler(req, res);
            });

            // Start resource server on random port
            await new Promise<void>(resolve => {
                resourceServer.listen(0, '127.0.0.1', () => {
                    const addr = resourceServer.address() as AddressInfo;
                    resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                    resolve();
                });
            });
        };

        beforeEach(async () => {
            // Close existing servers to set up custom auth flow servers
            resourceServer.close();
            authServer.close();

            const originalFetch = fetch;

            // Create custom fetch spy that delegates to real fetch
            customFetch = jest.fn((url, init) => {
                return originalFetch(url.toString(), init);
            });

            // Spy on global fetch to detect unauthorized usage
            globalFetchSpy = jest.spyOn(global, 'fetch');

            // Create mock auth provider with default configuration
            mockAuthProvider = createMockAuthProvider({
                hasTokens: false,
                clientRegistered: true
            });

            // Set up auth server that handles OAuth discovery and token requests
            await createCustomFetchMockAuthServer();

            // Set up resource server
            resourceServerHandler = jest.fn(
                (
                    _req: IncomingMessage,
                    res: ServerResponse<IncomingMessage> & {
                        req: IncomingMessage;
                    }
                ) => {
                    res.writeHead(404).end();
                }
            );
            await createCustomFetchMockResourceServer();
        });

        afterEach(() => {
            globalFetchSpy.mockRestore();
        });

        it('uses custom fetch during auth flow on SSE connection 401 - no global fetch fallback', async () => {
            // Set up resource server that returns 401 on SSE connection and provides OAuth metadata
            resourceServerHandler.mockImplementation((req, res) => {
                if (req.url === '/') {
                    // Return 401 to trigger auth flow
                    res.writeHead(401, {
                        'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${resourceBaseUrl.href}.well-known/oauth-protected-resource"`
                    });
                    res.end();
                    return;
                }

                res.writeHead(404).end();
            });

            // Create transport with custom fetch and auth provider
            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider,
                fetch: customFetch
            });

            // Attempt to start - should trigger auth flow and eventually fail with UnauthorizedError
            await expect(transport.start()).rejects.toThrow(UnauthorizedError);

            // Verify custom fetch was used
            expect(customFetch).toHaveBeenCalled();

            // Verify specific OAuth endpoints were called with custom fetch
            const customFetchCalls = customFetch.mock.calls;
            const callUrls = customFetchCalls.map(([url]) => url.toString());

            // Should have called resource metadata discovery
            expect(callUrls.some(url => url.includes('/.well-known/oauth-protected-resource'))).toBe(true);

            // Should have called OAuth authorization server metadata discovery
            expect(callUrls.some(url => url.includes('/.well-known/oauth-authorization-server'))).toBe(true);

            // Verify auth provider was called to redirect to authorization
            expect(mockAuthProvider.redirectToAuthorization).toHaveBeenCalled();

            // Global fetch should never have been called
            expect(globalFetchSpy).not.toHaveBeenCalled();
        });

        it('uses custom fetch during auth flow on POST request 401 - no global fetch fallback', async () => {
            // Set up resource server that accepts SSE connection but returns 401 on POST
            resourceServerHandler.mockImplementation((req, res) => {
                switch (req.method) {
                    case 'GET':
                        if (req.url === '/') {
                            // Accept SSE connection
                            res.writeHead(200, {
                                'Content-Type': 'text/event-stream',
                                'Cache-Control': 'no-cache, no-transform',
                                Connection: 'keep-alive'
                            });
                            res.write('event: endpoint\n');
                            res.write(`data: ${resourceBaseUrl.href}\n\n`);
                            return;
                        }
                        break;

                    case 'POST':
                        if (req.url === '/') {
                            // Return 401 to trigger auth retry
                            res.writeHead(401, {
                                'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${resourceBaseUrl.href}.well-known/oauth-protected-resource"`
                            });
                            res.end();
                            return;
                        }
                        break;
                }

                res.writeHead(404).end();
            });

            // Create transport with custom fetch and auth provider
            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: mockAuthProvider,
                fetch: customFetch
            });

            // Start the transport (should succeed)
            await transport.start();

            // Send a message that should trigger 401 and auth retry
            const message: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: '1',
                method: 'test',
                params: {}
            };

            // Attempt to send message - should trigger auth flow and eventually fail
            await expect(transport.send(message)).rejects.toThrow(UnauthorizedError);

            // Verify custom fetch was used
            expect(customFetch).toHaveBeenCalled();

            // Verify specific OAuth endpoints were called with custom fetch
            const customFetchCalls = customFetch.mock.calls;
            const callUrls = customFetchCalls.map(([url]) => url.toString());

            // Should have called resource metadata discovery
            expect(callUrls.some(url => url.includes('/.well-known/oauth-protected-resource'))).toBe(true);

            // Should have called OAuth authorization server metadata discovery
            expect(callUrls.some(url => url.includes('/.well-known/oauth-authorization-server'))).toBe(true);

            // Should have attempted the POST request that triggered the 401
            const postCalls = customFetchCalls.filter(
                ([url, options]) => url.toString() === resourceBaseUrl.href && options?.method === 'POST'
            );
            expect(postCalls.length).toBeGreaterThan(0);

            // Verify auth provider was called to redirect to authorization
            expect(mockAuthProvider.redirectToAuthorization).toHaveBeenCalled();

            // Global fetch should never have been called
            expect(globalFetchSpy).not.toHaveBeenCalled();
        });

        it('uses custom fetch in finishAuth method - no global fetch fallback', async () => {
            // Create mock auth provider that expects to save tokens
            const authProviderWithCode = createMockAuthProvider({
                clientRegistered: true,
                authorizationCode: 'test-auth-code'
            });

            // Create transport with custom fetch and auth provider
            transport = new SSEClientTransport(resourceBaseUrl, {
                authProvider: authProviderWithCode,
                fetch: customFetch
            });

            // Call finishAuth with authorization code
            await transport.finishAuth('test-auth-code');

            // Verify custom fetch was used
            expect(customFetch).toHaveBeenCalled();

            // Verify specific OAuth endpoints were called with custom fetch
            const customFetchCalls = customFetch.mock.calls;
            const callUrls = customFetchCalls.map(([url]) => url.toString());

            // Should have called resource metadata discovery
            expect(callUrls.some(url => url.includes('/.well-known/oauth-protected-resource'))).toBe(true);

            // Should have called OAuth authorization server metadata discovery
            expect(callUrls.some(url => url.includes('/.well-known/oauth-authorization-server'))).toBe(true);

            // Should have called token endpoint for authorization code exchange
            const tokenCalls = customFetchCalls.filter(([url, options]) => url.toString().includes('/token') && options?.method === 'POST');
            expect(tokenCalls.length).toBeGreaterThan(0);

            // Verify tokens were saved
            expect(authProviderWithCode.saveTokens).toHaveBeenCalledWith({
                access_token: 'new-access-token',
                token_type: 'Bearer',
                expires_in: 3600,
                refresh_token: 'new-refresh-token'
            });

            // Global fetch should never have been called
            expect(globalFetchSpy).not.toHaveBeenCalled();
        });
    });
});
