import { StartSSEOptions, StreamableHTTPClientTransport, StreamableHTTPReconnectionOptions } from './streamableHttp.js';
import { OAuthClientProvider, UnauthorizedError } from './auth.js';
import { JSONRPCMessage, JSONRPCRequest } from '../types.js';
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from '../server/auth/errors.js';

describe('StreamableHTTPClientTransport', () => {
    let transport: StreamableHTTPClientTransport;
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
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider: mockAuthProvider });
        jest.spyOn(global, 'fetch');
    });

    afterEach(async () => {
        await transport.close().catch(() => {});
        jest.clearAllMocks();
    });

    it('should send JSON-RPC messages via POST', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send(message);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                method: 'POST',
                headers: expect.any(Headers),
                body: JSON.stringify(message)
            })
        );
    });

    it('should send batch messages', async () => {
        const messages: JSONRPCMessage[] = [
            { jsonrpc: '2.0', method: 'test1', params: {}, id: 'id1' },
            { jsonrpc: '2.0', method: 'test2', params: {}, id: 'id2' }
        ];

        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: null
        });

        await transport.send(messages);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                method: 'POST',
                headers: expect.any(Headers),
                body: JSON.stringify(messages)
            })
        );
    });

    it('should store session ID received during initialization', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                clientInfo: { name: 'test-client', version: '1.0' },
                protocolVersion: '2025-03-26'
            },
            id: 'init-id'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session-id' })
        });

        await transport.send(message);

        // Send a second message that should include the session ID
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);

        // Check that second request included session ID header
        const calls = (global.fetch as jest.Mock).mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall[1].headers).toBeDefined();
        expect(lastCall[1].headers.get('mcp-session-id')).toBe('test-session-id');
    });

    it('should terminate session with DELETE request', async () => {
        // First, simulate getting a session ID
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                clientInfo: { name: 'test-client', version: '1.0' },
                protocolVersion: '2025-03-26'
            },
            id: 'init-id'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session-id' })
        });

        await transport.send(message);
        expect(transport.sessionId).toBe('test-session-id');

        // Now terminate the session
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers()
        });

        await transport.terminateSession();

        // Verify the DELETE request was sent with the session ID
        const calls = (global.fetch as jest.Mock).mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall[1].method).toBe('DELETE');
        expect(lastCall[1].headers.get('mcp-session-id')).toBe('test-session-id');

        // The session ID should be cleared after successful termination
        expect(transport.sessionId).toBeUndefined();
    });

    it("should handle 405 response when server doesn't support session termination", async () => {
        // First, simulate getting a session ID
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                clientInfo: { name: 'test-client', version: '1.0' },
                protocolVersion: '2025-03-26'
            },
            id: 'init-id'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session-id' })
        });

        await transport.send(message);

        // Now terminate the session, but server responds with 405
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status: 405,
            statusText: 'Method Not Allowed',
            headers: new Headers()
        });

        await expect(transport.terminateSession()).resolves.not.toThrow();
    });

    it('should handle 404 response when session expires', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: () => Promise.resolve('Session not found'),
            headers: new Headers()
        });

        const errorSpy = jest.fn();
        transport.onerror = errorSpy;

        await expect(transport.send(message)).rejects.toThrow('Error POSTing to endpoint (HTTP 404)');
        expect(errorSpy).toHaveBeenCalled();
    });

    it('should handle non-streaming JSON response', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        const responseMessage: JSONRPCMessage = {
            jsonrpc: '2.0',
            result: { success: true },
            id: 'test-id'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => Promise.resolve(responseMessage)
        });

        const messageSpy = jest.fn();
        transport.onmessage = messageSpy;

        await transport.send(message);

        expect(messageSpy).toHaveBeenCalledWith(responseMessage);
    });

    it('should attempt initial GET connection and handle 405 gracefully', async () => {
        // Mock the server not supporting GET for SSE (returning 405)
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status: 405,
            statusText: 'Method Not Allowed'
        });

        // We expect the 405 error to be caught and handled gracefully
        // This should not throw an error that breaks the transport
        await transport.start();
        await expect(transport['_startOrAuthSse']({})).resolves.not.toThrow('Failed to open SSE stream: Method Not Allowed');
        // Check that GET was attempted
        expect(global.fetch).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                method: 'GET',
                headers: expect.any(Headers)
            })
        );

        // Verify transport still works after 405
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should handle successful initial GET connection for SSE', async () => {
        // Set up readable stream for SSE events
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                // Send a server notification via SSE
                const event = 'event: message\ndata: {"jsonrpc": "2.0", "method": "serverNotification", "params": {}}\n\n';
                controller.enqueue(encoder.encode(event));
            }
        });

        // Mock successful GET connection
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: stream
        });

        const messageSpy = jest.fn();
        transport.onmessage = messageSpy;

        await transport.start();
        await transport['_startOrAuthSse']({});

        // Give time for the SSE event to be processed
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(messageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                jsonrpc: '2.0',
                method: 'serverNotification',
                params: {}
            })
        );
    });

    it('should handle multiple concurrent SSE streams', async () => {
        // Mock two POST requests that return SSE streams
        const makeStream = (id: string) => {
            const encoder = new TextEncoder();
            return new ReadableStream({
                start(controller) {
                    const event = `event: message\ndata: {"jsonrpc": "2.0", "result": {"id": "${id}"}, "id": "${id}"}\n\n`;
                    controller.enqueue(encoder.encode(event));
                }
            });
        };

        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: makeStream('request1')
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: makeStream('request2')
            });

        const messageSpy = jest.fn();
        transport.onmessage = messageSpy;

        // Send two concurrent requests
        await Promise.all([
            transport.send({ jsonrpc: '2.0', method: 'test1', params: {}, id: 'request1' }),
            transport.send({ jsonrpc: '2.0', method: 'test2', params: {}, id: 'request2' })
        ]);

        // Give time for SSE processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Both streams should have delivered their messages
        expect(messageSpy).toHaveBeenCalledTimes(2);

        // Verify received messages without assuming specific order
        expect(
            messageSpy.mock.calls.some(call => {
                const msg = call[0];
                return msg.id === 'request1' && msg.result?.id === 'request1';
            })
        ).toBe(true);

        expect(
            messageSpy.mock.calls.some(call => {
                const msg = call[0];
                return msg.id === 'request2' && msg.result?.id === 'request2';
            })
        ).toBe(true);
    });

    it('should support custom reconnection options', () => {
        // Create a transport with custom reconnection options
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            reconnectionOptions: {
                initialReconnectionDelay: 500,
                maxReconnectionDelay: 10000,
                reconnectionDelayGrowFactor: 2,
                maxRetries: 5
            }
        });

        // Verify options were set correctly (checking implementation details)
        // Access private properties for testing
        const transportInstance = transport as unknown as {
            _reconnectionOptions: StreamableHTTPReconnectionOptions;
        };
        expect(transportInstance._reconnectionOptions.initialReconnectionDelay).toBe(500);
        expect(transportInstance._reconnectionOptions.maxRetries).toBe(5);
    });

    it('should pass lastEventId when reconnecting', async () => {
        // Create a fresh transport
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));

        // Mock fetch to verify headers sent
        const fetchSpy = global.fetch as jest.Mock;
        fetchSpy.mockReset();
        fetchSpy.mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: new ReadableStream()
        });

        // Call the reconnect method directly with a lastEventId
        await transport.start();
        // Type assertion to access private method
        const transportWithPrivateMethods = transport as unknown as {
            _startOrAuthSse: (options: { resumptionToken?: string }) => Promise<void>;
        };
        await transportWithPrivateMethods._startOrAuthSse({ resumptionToken: 'test-event-id' });

        // Verify fetch was called with the lastEventId header
        expect(fetchSpy).toHaveBeenCalled();
        const fetchCall = fetchSpy.mock.calls[0];
        const headers = fetchCall[1].headers;
        expect(headers.get('last-event-id')).toBe('test-event-id');
    });

    it('should throw error when invalid content-type is received', async () => {
        // Clear any previous state from other tests
        jest.clearAllMocks();

        // Create a fresh transport instance
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));

        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('invalid text response'));
                controller.close();
            }
        });

        const errorSpy = jest.fn();
        transport.onerror = errorSpy;

        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/plain' }),
            body: stream
        });

        await transport.start();
        await expect(transport.send(message)).rejects.toThrow('Unexpected content type: text/plain');
        expect(errorSpy).toHaveBeenCalled();
    });

    it('uses custom fetch implementation if provided', async () => {
        // Create custom fetch
        const customFetch = jest
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
            .mockResolvedValueOnce(new Response(null, { status: 202 }));

        // Create transport instance
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            fetch: customFetch
        });

        await transport.start();
        await (transport as unknown as { _startOrAuthSse: (opts: StartSSEOptions) => Promise<void> })._startOrAuthSse({});

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: '1' } as JSONRPCMessage);

        // Verify custom fetch was used
        expect(customFetch).toHaveBeenCalled();

        // Global fetch should never have been called
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should always send specified custom headers', async () => {
        const requestInit = {
            headers: {
                'X-Custom-Header': 'CustomValue'
            }
        };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            requestInit: requestInit
        });

        let actualReqInit: RequestInit = {};

        (global.fetch as jest.Mock).mockImplementation(async (_url, reqInit) => {
            actualReqInit = reqInit;
            return new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        });

        await transport.start();

        await transport['_startOrAuthSse']({});
        expect((actualReqInit.headers as Headers).get('x-custom-header')).toBe('CustomValue');

        requestInit.headers['X-Custom-Header'] = 'SecondCustomValue';

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);
        expect((actualReqInit.headers as Headers).get('x-custom-header')).toBe('SecondCustomValue');

        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should always send specified custom headers (Headers class)', async () => {
        const requestInit = {
            headers: new Headers({
                'X-Custom-Header': 'CustomValue'
            })
        };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            requestInit: requestInit
        });

        let actualReqInit: RequestInit = {};

        (global.fetch as jest.Mock).mockImplementation(async (_url, reqInit) => {
            actualReqInit = reqInit;
            return new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        });

        await transport.start();

        await transport['_startOrAuthSse']({});
        expect((actualReqInit.headers as Headers).get('x-custom-header')).toBe('CustomValue');

        (requestInit.headers as Headers).set('X-Custom-Header', 'SecondCustomValue');

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);
        expect((actualReqInit.headers as Headers).get('x-custom-header')).toBe('SecondCustomValue');

        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should have exponential backoff with configurable maxRetries', () => {
        // This test verifies the maxRetries and backoff calculation directly

        // Create transport with specific options for testing
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            reconnectionOptions: {
                initialReconnectionDelay: 100,
                maxReconnectionDelay: 5000,
                reconnectionDelayGrowFactor: 2,
                maxRetries: 3
            }
        });

        // Get access to the internal implementation
        const getDelay = transport['_getNextReconnectionDelay'].bind(transport);

        // First retry - should use initial delay
        expect(getDelay(0)).toBe(100);

        // Second retry - should double (2^1 * 100 = 200)
        expect(getDelay(1)).toBe(200);

        // Third retry - should double again (2^2 * 100 = 400)
        expect(getDelay(2)).toBe(400);

        // Fourth retry - should double again (2^3 * 100 = 800)
        expect(getDelay(3)).toBe(800);

        // Tenth retry - should be capped at maxReconnectionDelay
        expect(getDelay(10)).toBe(5000);
    });

    it('attempts auth flow on 401 during POST request', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: new Headers()
            })
            .mockResolvedValue({
                ok: false,
                status: 404
            });

        await expect(transport.send(message)).rejects.toThrow(UnauthorizedError);
        expect(mockAuthProvider.redirectToAuthorization.mock.calls).toHaveLength(1);
    });

    describe('Reconnection Logic', () => {
        let transport: StreamableHTTPClientTransport;

        // Use fake timers to control setTimeout and make the test instant.
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        it('should reconnect a GET-initiated notification stream that fails', async () => {
            // ARRANGE
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 1,
                    maxReconnectionDelay: 1000, // Ensure it doesn't retry indefinitely
                    reconnectionDelayGrowFactor: 1 // No exponential backoff for simplicity
                }
            });

            const errorSpy = jest.fn();
            transport.onerror = errorSpy;

            const failingStream = new ReadableStream({
                start(controller) {
                    controller.error(new Error('Network failure'));
                }
            });

            const fetchMock = global.fetch as jest.Mock;
            // Mock the initial GET request, which will fail.
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: failingStream
            });
            // Mock the reconnection GET request, which will succeed.
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: new ReadableStream()
            });

            // ACT
            await transport.start();
            // Trigger the GET stream directly using the internal method for a clean test.
            await transport['_startOrAuthSse']({});
            await jest.advanceTimersByTimeAsync(20); // Trigger reconnection timeout

            // ASSERT
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('SSE stream disconnected: Error: Network failure')
                })
            );
            // THE KEY ASSERTION: A second fetch call proves reconnection was attempted.
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
            expect(fetchMock.mock.calls[1][1]?.method).toBe('GET');
        });

        it('should NOT reconnect a POST-initiated stream that fails', async () => {
            // ARRANGE
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 1,
                    maxReconnectionDelay: 1000, // Ensure it doesn't retry indefinitely
                    reconnectionDelayGrowFactor: 1 // No exponential backoff for simplicity
                }
            });

            const errorSpy = jest.fn();
            transport.onerror = errorSpy;

            const failingStream = new ReadableStream({
                start(controller) {
                    controller.error(new Error('Network failure'));
                }
            });

            const fetchMock = global.fetch as jest.Mock;
            // Mock the POST request. It returns a streaming content-type but a failing body.
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: failingStream
            });

            // A dummy request message to trigger the `send` logic.
            const requestMessage: JSONRPCRequest = {
                jsonrpc: '2.0',
                method: 'long_running_tool',
                id: 'request-1',
                params: {}
            };

            // ACT
            await transport.start();
            // Use the public `send` method to initiate a POST that gets a stream response.
            await transport.send(requestMessage);
            await jest.advanceTimersByTimeAsync(20); // Advance time to check for reconnections

            // ASSERT
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('SSE stream disconnected: Error: Network failure')
                })
            );
            // THE KEY ASSERTION: Fetch was only called ONCE. No reconnection was attempted.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
        });
    });

    it('invalidates all credentials on InvalidClientError during auth', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        mockAuthProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            refresh_token: 'test-refresh'
        });

        const unauthedResponse = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: new Headers()
        };
        (global.fetch as jest.Mock)
            // Initial connection
            .mockResolvedValueOnce(unauthedResponse)
            // Resource discovery, path aware
            .mockResolvedValueOnce(unauthedResponse)
            // Resource discovery, root
            .mockResolvedValueOnce(unauthedResponse)
            // OAuth metadata discovery
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'http://localhost:1234',
                    authorization_endpoint: 'http://localhost:1234/authorize',
                    token_endpoint: 'http://localhost:1234/token',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256']
                })
            })
            // Token refresh fails with InvalidClientError
            .mockResolvedValueOnce(
                Response.json(new InvalidClientError('Client authentication failed').toResponseObject(), { status: 400 })
            )
            // Fallback should fail to complete the flow
            .mockResolvedValue({
                ok: false,
                status: 404
            });

        await expect(transport.send(message)).rejects.toThrow(UnauthorizedError);
        expect(mockAuthProvider.invalidateCredentials).toHaveBeenCalledWith('all');
    });

    it('invalidates all credentials on UnauthorizedClientError during auth', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        mockAuthProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            refresh_token: 'test-refresh'
        });

        const unauthedResponse = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: new Headers()
        };
        (global.fetch as jest.Mock)
            // Initial connection
            .mockResolvedValueOnce(unauthedResponse)
            // Resource discovery, path aware
            .mockResolvedValueOnce(unauthedResponse)
            // Resource discovery, root
            .mockResolvedValueOnce(unauthedResponse)
            // OAuth metadata discovery
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'http://localhost:1234',
                    authorization_endpoint: 'http://localhost:1234/authorize',
                    token_endpoint: 'http://localhost:1234/token',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256']
                })
            })
            // Token refresh fails with UnauthorizedClientError
            .mockResolvedValueOnce(Response.json(new UnauthorizedClientError('Client not authorized').toResponseObject(), { status: 400 }))
            // Fallback should fail to complete the flow
            .mockResolvedValue({
                ok: false,
                status: 404
            });

        await expect(transport.send(message)).rejects.toThrow(UnauthorizedError);
        expect(mockAuthProvider.invalidateCredentials).toHaveBeenCalledWith('all');
    });

    it('invalidates tokens on InvalidGrantError during auth', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        mockAuthProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            refresh_token: 'test-refresh'
        });

        const unauthedResponse = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: new Headers()
        };
        (global.fetch as jest.Mock)
            // Initial connection
            .mockResolvedValueOnce(unauthedResponse)
            // Resource discovery, path aware
            .mockResolvedValueOnce(unauthedResponse)
            // Resource discovery, root
            .mockResolvedValueOnce(unauthedResponse)
            // OAuth metadata discovery
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'http://localhost:1234',
                    authorization_endpoint: 'http://localhost:1234/authorize',
                    token_endpoint: 'http://localhost:1234/token',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256']
                })
            })
            // Token refresh fails with InvalidGrantError
            .mockResolvedValueOnce(Response.json(new InvalidGrantError('Invalid refresh token').toResponseObject(), { status: 400 }))
            // Fallback should fail to complete the flow
            .mockResolvedValue({
                ok: false,
                status: 404
            });

        await expect(transport.send(message)).rejects.toThrow(UnauthorizedError);
        expect(mockAuthProvider.invalidateCredentials).toHaveBeenCalledWith('tokens');
    });

    describe('custom fetch in auth code paths', () => {
        it('uses custom fetch during auth flow on 401 - no global fetch fallback', async () => {
            const unauthedResponse = {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: new Headers()
            };

            // Create custom fetch
            const customFetch = jest
                .fn()
                // Initial connection
                .mockResolvedValueOnce(unauthedResponse)
                // Resource discovery
                .mockResolvedValueOnce(unauthedResponse)
                // OAuth metadata discovery
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        issuer: 'http://localhost:1234',
                        authorization_endpoint: 'http://localhost:1234/authorize',
                        token_endpoint: 'http://localhost:1234/token',
                        response_types_supported: ['code'],
                        code_challenge_methods_supported: ['S256']
                    })
                })
                // Token refresh fails with InvalidClientError
                .mockResolvedValueOnce(
                    Response.json(new InvalidClientError('Client authentication failed').toResponseObject(), { status: 400 })
                )
                // Fallback should fail to complete the flow
                .mockResolvedValue({
                    ok: false,
                    status: 404
                });

            // Create transport instance
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                authProvider: mockAuthProvider,
                fetch: customFetch
            });

            // Attempt to start - should trigger auth flow and eventually fail with UnauthorizedError
            await transport.start();
            await expect(
                (transport as unknown as { _startOrAuthSse: (opts: StartSSEOptions) => Promise<void> })._startOrAuthSse({})
            ).rejects.toThrow(UnauthorizedError);

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
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('uses custom fetch in finishAuth method - no global fetch fallback', async () => {
            // Create custom fetch
            const customFetch = jest
                .fn()
                // Protected resource metadata discovery
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        authorization_servers: ['http://localhost:1234'],
                        resource: 'http://localhost:1234/mcp'
                    })
                })
                // OAuth metadata discovery
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        issuer: 'http://localhost:1234',
                        authorization_endpoint: 'http://localhost:1234/authorize',
                        token_endpoint: 'http://localhost:1234/token',
                        response_types_supported: ['code'],
                        code_challenge_methods_supported: ['S256']
                    })
                })
                // Code exchange
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        access_token: 'new-access-token',
                        refresh_token: 'new-refresh-token',
                        token_type: 'Bearer',
                        expires_in: 3600
                    })
                });

            // Create transport instance
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                authProvider: mockAuthProvider,
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
            expect(mockAuthProvider.saveTokens).toHaveBeenCalledWith({
                access_token: 'new-access-token',
                token_type: 'Bearer',
                expires_in: 3600,
                refresh_token: 'new-refresh-token'
            });

            // Global fetch should never have been called
            expect(global.fetch).not.toHaveBeenCalled();
        });
    });

    describe('prevent infinite recursion when server returns 401 after successful auth', () => {
        it('should throw error when server returns 401 after successful auth', async () => {
            const message: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'test',
                params: {},
                id: 'test-id'
            };

            // Mock provider with refresh token to enable token refresh flow
            mockAuthProvider.tokens.mockResolvedValue({
                access_token: 'test-token',
                token_type: 'Bearer',
                refresh_token: 'refresh-token'
            });

            const unauthedResponse = {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: new Headers()
            };

            (global.fetch as jest.Mock)
                // First request - 401, triggers auth flow
                .mockResolvedValueOnce(unauthedResponse)
                // Resource discovery, path aware
                .mockResolvedValueOnce(unauthedResponse)
                // Resource discovery, root
                .mockResolvedValueOnce(unauthedResponse)
                // OAuth metadata discovery
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        issuer: 'http://localhost:1234',
                        authorization_endpoint: 'http://localhost:1234/authorize',
                        token_endpoint: 'http://localhost:1234/token',
                        response_types_supported: ['code'],
                        code_challenge_methods_supported: ['S256']
                    })
                })
                // Token refresh succeeds
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        access_token: 'new-access-token',
                        token_type: 'Bearer',
                        expires_in: 3600
                    })
                })
                // Retry the original request - still 401 (broken server)
                .mockResolvedValueOnce(unauthedResponse);

            await expect(transport.send(message)).rejects.toThrow('Server returned 401 after successful authentication');
            expect(mockAuthProvider.saveTokens).toHaveBeenCalledWith({
                access_token: 'new-access-token',
                token_type: 'Bearer',
                expires_in: 3600,
                refresh_token: 'refresh-token' // Refresh token is preserved
            });
        });
    });
});
