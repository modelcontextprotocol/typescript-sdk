import { getEventListeners } from 'node:events';

import type { JSONRPCMessage, JSONRPCRequest, OAuthTokens } from '@modelcontextprotocol/core-internal';
import { OAuthError, OAuthErrorCode, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/core-internal';
import type { Mock, Mocked } from 'vitest';

import type { OAuthClientProvider } from '../../src/client/auth';
import { UnauthorizedError } from '../../src/client/auth';
import { Client } from '../../src/client/client';
import type { ReconnectionScheduler, StartSSEOptions, StreamableHTTPReconnectionOptions } from '../../src/client/streamableHttp';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';

describe('StreamableHTTPClientTransport', () => {
    let transport: StreamableHTTPClientTransport;
    let mockAuthProvider: Mocked<OAuthClientProvider>;

    beforeEach(() => {
        mockAuthProvider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            clientInformation: vi.fn(() => ({ client_id: 'test-client-id', client_secret: 'test-client-secret' })),
            tokens: vi.fn(),
            saveTokens: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn(),
            invalidateCredentials: vi.fn()
        };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider: mockAuthProvider });
        vi.spyOn(globalThis, 'fetch');
    });

    afterEach(async () => {
        await transport.close().catch(() => {});
        vi.clearAllMocks();
    });

    it('should send JSON-RPC messages via POST', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send(message);

        expect(globalThis.fetch).toHaveBeenCalledWith(
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

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: null
        });

        await transport.send(messages);

        expect(globalThis.fetch).toHaveBeenCalledWith(
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
                capabilities: {},
                protocolVersion: '2025-03-26'
            },
            id: 'init-id'
        };

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session-id' })
        });

        await transport.send(message);

        // Send a second message that should include the session ID
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);

        // Check that second request included session ID header
        const calls = (globalThis.fetch as Mock).mock.calls;
        const lastCall = calls.at(-1)!;
        expect(lastCall[1].headers).toBeDefined();
        expect(lastCall[1].headers.get('mcp-session-id')).toBe('test-session-id');
    });

    it('should not store session ID from an error response, then store it from a later successful initialize', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                clientInfo: { name: 'test-client', version: '1.0' },
                capabilities: {},
                protocolVersion: '2025-03-26'
            },
            id: 'init-id'
        };

        // A failed initialize (e.g. a legacy server rejecting a version probe) that carries a session ID
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            text: () => Promise.resolve('Bad Request'),
            headers: new Headers({ 'mcp-session-id': 'poisoned-session-id' })
        });

        await expect(transport.send(message)).rejects.toThrow();
        expect(transport.sessionId).toBeUndefined();

        // The fallback initialize succeeds and its session ID is captured
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'real-session-id' })
        });

        await transport.send(message);
        expect(transport.sessionId).toBe('real-session-id');
    });

    it('should not attach a session ID to an initialize POST, clear a stale ID on a sessionless handshake, and adopt a newly returned one', async () => {
        const initMessage: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                clientInfo: { name: 'test-client', version: '1.0' },
                capabilities: {},
                protocolVersion: '2025-03-26'
            },
            id: 'init-id'
        };

        const staleTransport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            sessionId: 'stale-session-id'
        });

        // Sessionless handshake: the response carries no session ID
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' })
        });

        await staleTransport.send(initMessage);

        const initCall = (globalThis.fetch as Mock).mock.calls.at(-1)!;
        expect(initCall[1].headers.get('mcp-session-id')).toBeNull();

        // The sessionless handshake cleared the stale ID, so an ordinary request carries none
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await staleTransport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'test-id' } as JSONRPCMessage);
        expect((globalThis.fetch as Mock).mock.calls.at(-1)![1].headers.get('mcp-session-id')).toBeNull();

        await staleTransport.close().catch(() => {});

        // When the handshake DOES return a new ID, subsequent requests carry it instead of the preset
        const replacedTransport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            sessionId: 'preset-session-id'
        });

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'new-session-id' })
        });

        await replacedTransport.send(initMessage);

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await replacedTransport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'test-id' } as JSONRPCMessage);
        expect((globalThis.fetch as Mock).mock.calls.at(-1)![1].headers.get('mcp-session-id')).toBe('new-session-id');

        await replacedTransport.close().catch(() => {});
    });

    it('should ignore a session ID on a successful non-initialize response', async () => {
        const sessionTransport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            sessionId: 'session-a'
        });

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers({ 'mcp-session-id': 'session-b' })
        });

        await sessionTransport.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' } as JSONRPCMessage);
        expect(sessionTransport.sessionId).toBe('session-a');

        await sessionTransport.close().catch(() => {});
    });

    it('should accept protocolVersion constructor option and include it in request headers', async () => {
        // When reconnecting with a preserved sessionId, users need to also preserve the
        // negotiated protocol version so the required mcp-protocol-version header is sent.
        const reconnectTransport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            sessionId: 'preserved-session-id',
            protocolVersion: '2025-11-25'
        });

        expect(reconnectTransport.sessionId).toBe('preserved-session-id');
        expect(reconnectTransport.protocolVersion).toBe('2025-11-25');

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await reconnectTransport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);

        const calls = (globalThis.fetch as Mock).mock.calls;
        const lastCall = calls.at(-1)!;
        expect(lastCall[1].headers.get('mcp-session-id')).toBe('preserved-session-id');
        expect(lastCall[1].headers.get('mcp-protocol-version')).toBe('2025-11-25');

        await reconnectTransport.close().catch(() => {});
    });

    it('should terminate session with DELETE request', async () => {
        // First, simulate getting a session ID
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                clientInfo: { name: 'test-client', version: '1.0' },
                capabilities: {},
                protocolVersion: '2025-03-26'
            },
            id: 'init-id'
        };

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session-id' })
        });

        await transport.send(message);
        expect(transport.sessionId).toBe('test-session-id');

        // Now terminate the session
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers()
        });

        await transport.terminateSession();

        // Verify the DELETE request was sent with the session ID
        const calls = (globalThis.fetch as Mock).mock.calls;
        const lastCall = calls.at(-1)!;
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
                capabilities: {},
                protocolVersion: '2025-03-26'
            },
            id: 'init-id'
        };

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session-id' })
        });

        await transport.send(message);

        // Now terminate the session, but server responds with 405
        (globalThis.fetch as Mock).mockResolvedValueOnce({
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

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: () => Promise.resolve('Session not found'),
            headers: new Headers()
        });

        const errorSpy = vi.fn();
        transport.onerror = errorSpy;

        await expect(transport.send(message)).rejects.toThrow(
            new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Error POSTing to endpoint: Session not found', {
                status: 404,
                statusText: 'Not Found',
                text: 'Session not found'
            })
        );
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

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => Promise.resolve(responseMessage)
        });

        const messageSpy = vi.fn();
        transport.onmessage = messageSpy;

        await transport.send(message);

        expect(messageSpy).toHaveBeenCalledWith(responseMessage);
    });

    it('should attempt initial GET connection and handle 405 gracefully', async () => {
        // Mock the server not supporting GET for SSE (returning 405)
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: false,
            status: 405,
            statusText: 'Method Not Allowed'
        });

        // We expect the 405 error to be caught and handled gracefully
        // This should not throw an error that breaks the transport
        await transport.start();
        await expect(transport['_startOrAuthSse']({})).resolves.not.toThrow('Failed to open SSE stream: Method Not Allowed');
        // Check that GET was attempted
        expect(globalThis.fetch).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                method: 'GET',
                headers: expect.any(Headers)
            })
        );

        // Verify transport still works after 405
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
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
        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: stream
        });

        const messageSpy = vi.fn();
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

        (globalThis.fetch as Mock)
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

        const messageSpy = vi.fn();
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

    it('declares hasPerRequestStream so the protocol layer routes 2026-era cancellation to stream-close', () => {
        // Spec basic/patterns/cancellation §Transport-Specific (2026-07-28):
        // closing the per-request SSE stream IS the cancel signal on
        // Streamable HTTP. Protocol.request() keys on this flag (plus the
        // negotiated era) to abort `requestSignal` instead of POSTing
        // `notifications/cancelled`.
        expect(transport.hasPerRequestStream).toBe(true);
    });

    it('should support custom reconnection options', () => {
        // Create a transport with custom reconnection options
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            reconnectionOptions: {
                initialReconnectionDelay: 500,
                maxReconnectionDelay: 10_000,
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
        const fetchSpy = globalThis.fetch as Mock;
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
        const fetchCall = fetchSpy.mock.calls[0]!;
        const headers = fetchCall[1].headers;
        expect(headers.get('last-event-id')).toBe('test-event-id');
    });

    it('should include requestInit options (credentials, mode, etc.) in GET SSE request', async () => {
        // Regression test for #895: POST and DELETE requests spread _requestInit but the
        // GET SSE request did not, so non-header options like credentials were dropped.
        vi.clearAllMocks();

        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            requestInit: { credentials: 'include', mode: 'cors' }
        });

        const fetchSpy = globalThis.fetch as Mock;
        fetchSpy.mockReset();
        fetchSpy.mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: new ReadableStream()
        });

        await transport.start();
        await (transport as unknown as { _startOrAuthSse: (opts: StartSSEOptions) => Promise<void> })._startOrAuthSse({});

        expect(fetchSpy).toHaveBeenCalled();
        const init = fetchSpy.mock.calls[0]![1];
        expect(init.method).toBe('GET');
        expect(init.credentials).toBe('include');
        expect(init.mode).toBe('cors');
    });

    it('should throw error when invalid content-type is received', async () => {
        // Clear any previous state from other tests
        vi.clearAllMocks();

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

        const errorSpy = vi.fn();
        transport.onerror = errorSpy;

        (globalThis.fetch as Mock).mockResolvedValueOnce({
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
        const customFetch = vi
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
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should always send specified custom headers', async () => {
        const requestInit = {
            headers: {
                Authorization: 'Bearer test-token',
                'X-Custom-Header': 'CustomValue'
            }
        };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            requestInit: requestInit
        });

        let actualReqInit: RequestInit = {};

        (globalThis.fetch as Mock).mockImplementation(async (_url, reqInit) => {
            actualReqInit = reqInit;
            return new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        });

        await transport.start();

        await transport['_startOrAuthSse']({});
        expect((actualReqInit.headers as Headers).get('authorization')).toBe('Bearer test-token');
        expect((actualReqInit.headers as Headers).get('x-custom-header')).toBe('CustomValue');

        requestInit.headers['X-Custom-Header'] = 'SecondCustomValue';

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);
        expect((actualReqInit.headers as Headers).get('x-custom-header')).toBe('SecondCustomValue');

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should always send specified custom headers (Headers class)', async () => {
        const requestInit = {
            headers: new Headers({
                Authorization: 'Bearer test-token',
                'X-Custom-Header': 'CustomValue'
            })
        };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            requestInit: requestInit
        });

        let actualReqInit: RequestInit = {};

        (globalThis.fetch as Mock).mockImplementation(async (_url, reqInit) => {
            actualReqInit = reqInit;
            return new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        });

        await transport.start();

        await transport['_startOrAuthSse']({});
        expect((actualReqInit.headers as Headers).get('authorization')).toBe('Bearer test-token');
        expect((actualReqInit.headers as Headers).get('x-custom-header')).toBe('CustomValue');

        (requestInit.headers as Headers).set('X-Custom-Header', 'SecondCustomValue');

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);
        expect((actualReqInit.headers as Headers).get('x-custom-header')).toBe('SecondCustomValue');

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should always send specified custom headers (array of tuples)', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            requestInit: {
                headers: [
                    ['Authorization', 'Bearer test-token'],
                    ['X-Custom-Header', 'CustomValue']
                ]
            }
        });

        let actualReqInit: RequestInit = {};

        (globalThis.fetch as Mock).mockImplementation(async (_url, reqInit) => {
            actualReqInit = reqInit;
            return new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        });

        await transport.start();

        await transport['_startOrAuthSse']({});
        expect((actualReqInit.headers as Headers).get('authorization')).toBe('Bearer test-token');
        expect((actualReqInit.headers as Headers).get('x-custom-header')).toBe('CustomValue');
    });

    it('should append custom Accept header to required types on POST requests', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            requestInit: {
                headers: {
                    Accept: 'application/vnd.example.v1+json'
                }
            }
        });

        let actualReqInit: RequestInit = {};

        (globalThis.fetch as Mock).mockImplementation(async (_url, reqInit) => {
            actualReqInit = reqInit;
            return new Response(JSON.stringify({ jsonrpc: '2.0', result: {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        });

        await transport.start();

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);
        expect((actualReqInit.headers as Headers).get('accept')).toBe(
            'application/vnd.example.v1+json, application/json, text/event-stream'
        );
    });

    it('should append custom Accept header to required types on GET SSE requests', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            requestInit: {
                headers: {
                    Accept: 'application/json'
                }
            }
        });

        let actualReqInit: RequestInit = {};

        (globalThis.fetch as Mock).mockImplementation(async (_url, reqInit) => {
            actualReqInit = reqInit;
            return new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        });

        await transport.start();

        await transport['_startOrAuthSse']({});
        expect((actualReqInit.headers as Headers).get('accept')).toBe('application/json, text/event-stream');
    });

    it('should set default Accept header when none provided', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));

        let actualReqInit: RequestInit = {};

        (globalThis.fetch as Mock).mockImplementation(async (_url, reqInit) => {
            actualReqInit = reqInit;
            return new Response(JSON.stringify({ jsonrpc: '2.0', result: {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        });

        await transport.start();

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);
        expect((actualReqInit.headers as Headers).get('accept')).toBe('application/json, text/event-stream');
    });

    it('should not duplicate Accept media types when user-provided value overlaps required types', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            requestInit: {
                headers: {
                    Accept: 'application/json'
                }
            }
        });

        let actualReqInit: RequestInit = {};

        (globalThis.fetch as Mock).mockImplementation(async (_url, reqInit) => {
            actualReqInit = reqInit;
            return new Response(JSON.stringify({ jsonrpc: '2.0', result: {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        });

        await transport.start();

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {} } as JSONRPCMessage);
        expect((actualReqInit.headers as Headers).get('accept')).toBe('application/json, text/event-stream');
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

        (globalThis.fetch as Mock)
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: new Headers(),
                text: async () => {
                    throw 'dont read my body';
                }
            })
            .mockResolvedValue({
                ok: false,
                status: 404,
                text: async () => {
                    throw 'dont read my body';
                }
            });

        await expect(transport.send(message)).rejects.toThrow(UnauthorizedError);
        expect(mockAuthProvider.redirectToAuthorization.mock.calls).toHaveLength(1);
    });

    it('silently refreshes and retries when a POST returns 401 invalid_token', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
                name: 'power-bi-query',
                arguments: {}
            },
            id: 'tool-use-1'
        };
        const resourceMetadataUrl = 'http://localhost:1234/.well-known/oauth-protected-resource/mcp';
        let currentTokens: OAuthTokens = {
            access_token: 'expired-access-token',
            token_type: 'Bearer',
            refresh_token: 'refresh-token'
        };

        mockAuthProvider.tokens.mockImplementation(() => currentTokens);
        mockAuthProvider.saveTokens.mockImplementation(tokens => {
            currentTokens = tokens;
        });

        const fetchMock = globalThis.fetch as Mock;
        fetchMock.mockImplementation(async (url, init) => {
            const urlString = url.toString();

            if (urlString === 'http://localhost:1234/mcp' && init?.method === 'POST') {
                const headers = new Headers(init.headers);
                const authorization = headers.get('authorization');

                if (authorization === 'Bearer expired-access-token') {
                    return new Response('expired', {
                        status: 401,
                        statusText: 'Unauthorized',
                        headers: {
                            'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="The access token expired"`
                        }
                    });
                }

                if (authorization === 'Bearer new-access-token') {
                    return new Response(null, { status: 202 });
                }

                return new Response('unexpected bearer', { status: 401, statusText: 'Unauthorized' });
            }

            if (urlString === resourceMetadataUrl) {
                return Response.json({
                    resource: 'http://localhost:1234/mcp',
                    authorization_servers: ['http://localhost:1234']
                });
            }

            if (urlString === 'http://localhost:1234/.well-known/oauth-authorization-server') {
                return Response.json({
                    issuer: 'http://localhost:1234',
                    authorization_endpoint: 'http://localhost:1234/authorize',
                    token_endpoint: 'http://localhost:1234/token',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256']
                });
            }

            if (urlString === 'http://localhost:1234/token' && init?.method === 'POST') {
                const params = new URLSearchParams(init.body as string);
                expect(params.get('grant_type')).toBe('refresh_token');
                expect(params.get('refresh_token')).toBe('refresh-token');

                return Response.json({
                    access_token: 'new-access-token',
                    token_type: 'Bearer',
                    refresh_token: 'new-refresh-token'
                });
            }

            return new Response('not found', { status: 404 });
        });

        await transport.send(message);

        const mcpPostCalls = fetchMock.mock.calls.filter(
            ([url, init]) => url.toString() === 'http://localhost:1234/mcp' && init?.method === 'POST'
        );
        expect(mcpPostCalls).toHaveLength(2);
        const firstPost = mcpPostCalls[0]!;
        const secondPost = mcpPostCalls[1]!;
        expect(new Headers(firstPost[1]?.headers).get('authorization')).toBe('Bearer expired-access-token');
        expect(new Headers(secondPost[1]?.headers).get('authorization')).toBe('Bearer new-access-token');
        expect(firstPost[1]?.body).toBe(JSON.stringify(message));
        expect(secondPost[1]?.body).toBe(JSON.stringify(message));
        expect(mockAuthProvider.saveTokens).toHaveBeenCalledWith(
            expect.objectContaining({
                access_token: 'new-access-token',
                token_type: 'Bearer',
                refresh_token: 'new-refresh-token'
            }),
            expect.anything()
        );
        expect(mockAuthProvider.redirectToAuthorization).not.toHaveBeenCalled();
    });

    it('attempts upscoping on 403 with WWW-Authenticate header', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        const fetchMock = globalThis.fetch as Mock;
        fetchMock
            // First call: returns 403 with insufficient_scope
            .mockResolvedValueOnce({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                headers: new Headers({
                    'WWW-Authenticate':
                        'Bearer error="insufficient_scope", scope="new_scope", resource_metadata="http://example.com/resource"'
                }),
                text: () => Promise.resolve('Insufficient scope')
            })
            // Second call: successful after upscoping
            .mockResolvedValueOnce({
                ok: true,
                status: 202,
                headers: new Headers()
            });

        // Spy on the imported auth function and mock successful authorization
        const authModule = await import('../../src/client/auth');
        const authSpy = vi.spyOn(authModule, 'auth');
        authSpy.mockResolvedValue('AUTHORIZED');

        await transport.send(message);

        // Verify fetch was called twice
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Verify auth was called with the union scope (no prior scope → just the
        // challenged scope) and forced fresh authorization (no prior token scope
        // means the union is a strict superset of the empty grant).
        expect(authSpy).toHaveBeenCalledWith(
            mockAuthProvider,
            expect.objectContaining({
                scope: 'new_scope',
                forceReauthorization: true,
                resourceMetadataUrl: new URL('http://example.com/resource')
            })
        );

        authSpy.mockRestore();
    });

    it('caps step-up retries per send (bounded counter)', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        // Mock fetch calls to always return 403 with insufficient_scope
        const fetchMock = globalThis.fetch as Mock;
        fetchMock.mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: new Headers({
                'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="new_scope"'
            }),
            text: () => Promise.resolve('Insufficient scope')
        });

        // Spy on the imported auth function and mock successful authorization
        const authModule = await import('../../src/client/auth');
        const authSpy = vi.spyOn(authModule as typeof import('../../src/client/auth'), 'auth');
        authSpy.mockResolvedValue('AUTHORIZED');

        // First send: one step-up retry (default cap = 1), then fails.
        await expect(transport.send(message)).rejects.toThrow(/403 insufficient_scope after step-up re-authorization/);

        expect(fetchMock).toHaveBeenCalledTimes(2); // Initial call + one retry after auth
        expect(authSpy).toHaveBeenCalledTimes(1); // Auth called once

        // Second send: counter is per-send-chain, not transport-wide — a fresh
        // send tries step-up once again (cross-request tracking is host
        // responsibility).
        fetchMock.mockClear();
        authSpy.mockClear();
        await expect(transport.send(message)).rejects.toThrow(/403 insufficient_scope after step-up re-authorization/);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(authSpy).toHaveBeenCalledTimes(1);

        authSpy.mockRestore();
    });

    it('step-up scope is the union of transport-tracked, token-granted, and challenged scopes', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            authProvider: mockAuthProvider,
            maxStepUpRetries: 2
        });
        mockAuthProvider.tokens.mockResolvedValue({ access_token: 't', token_type: 'Bearer', scope: 'a b' });

        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: {}, id: 'test-id' };
        const fetchMock = globalThis.fetch as Mock;
        fetchMock
            .mockResolvedValueOnce({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                headers: new Headers({ 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="b c"' }),
                text: () => Promise.resolve('')
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                headers: new Headers({ 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="d"' }),
                text: () => Promise.resolve('')
            })
            .mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        const authModule = await import('../../src/client/auth');
        const authSpy = vi.spyOn(authModule, 'auth');
        authSpy.mockResolvedValue('AUTHORIZED');

        await transport.send(message);

        expect(authSpy).toHaveBeenCalledTimes(2);
        // First step-up: union(undefined, token 'a b', challenge 'b c') = 'a b c'
        expect(authSpy.mock.calls[0]![1].scope?.split(' ').sort()).toEqual(['a', 'b', 'c']);
        // Second step-up: union(tracked 'a b c', token 'a b', challenge 'd') = 'a b c d'
        expect(authSpy.mock.calls[1]![1].scope?.split(' ').sort()).toEqual(['a', 'b', 'c', 'd']);

        authSpy.mockRestore();
    });

    it("throws InsufficientScopeError on 403 when onInsufficientScope is 'throw'", async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            authProvider: mockAuthProvider,
            onInsufficientScope: 'throw'
        });
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: {}, id: 'test-id' };

        (globalThis.fetch as Mock).mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: new Headers({
                'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="files:write", error_description="needs write"'
            }),
            text: () => Promise.resolve('Insufficient scope')
        });

        const authModule = await import('../../src/client/auth');
        const authSpy = vi.spyOn(authModule, 'auth');
        const { InsufficientScopeError } = await import('../../src/client/authErrors');

        const sendPromise = transport.send(message);
        await expect(sendPromise).rejects.toBeInstanceOf(InsufficientScopeError);
        await expect(sendPromise).rejects.toMatchObject({
            requiredScope: 'files:write',
            errorDescription: 'needs write'
        });
        expect(authSpy).not.toHaveBeenCalled();

        authSpy.mockRestore();
    });

    describe('Reconnection Logic', () => {
        let transport: StreamableHTTPClientTransport;

        // Use fake timers to control setTimeout and make the test instant.
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());

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

            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const failingStream = new ReadableStream({
                start(controller) {
                    controller.error(new Error('Network failure'));
                }
            });

            const fetchMock = globalThis.fetch as Mock;
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
            await vi.advanceTimersByTimeAsync(20); // Trigger reconnection timeout

            // ASSERT
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('SSE stream disconnected: Error: Network failure')
                })
            );
            // THE KEY ASSERTION: A second fetch call proves reconnection was attempted.
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[0]![1]?.method).toBe('GET');
            expect(fetchMock.mock.calls[1]![1]?.method).toBe('GET');
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

            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const failingStream = new ReadableStream({
                start(controller) {
                    controller.error(new Error('Network failure'));
                }
            });

            const fetchMock = globalThis.fetch as Mock;
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
            await vi.advanceTimersByTimeAsync(20); // Advance time to check for reconnections

            // ASSERT
            // THE KEY ASSERTION: Fetch was only called ONCE. No reconnection was attempted.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST');
        });

        it('should reconnect a POST-initiated stream after receiving a priming event', async () => {
            // ARRANGE
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 1,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });

            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            // Create a stream that sends a priming event (with ID) then closes
            const streamWithPrimingEvent = new ReadableStream({
                start(controller) {
                    // Send a priming event with an ID - this enables reconnection
                    controller.enqueue(
                        new TextEncoder().encode('id: event-123\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n')
                    );
                    // Then close the stream (simulating server disconnect)
                    controller.close();
                }
            });

            const fetchMock = globalThis.fetch as Mock;
            // First call: POST returns streaming response with priming event
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: streamWithPrimingEvent
            });
            // Second call: GET reconnection - return 405 to stop further reconnection
            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 405,
                headers: new Headers()
            });

            const requestMessage: JSONRPCRequest = {
                jsonrpc: '2.0',
                method: 'long_running_tool',
                id: 'request-1',
                params: {}
            };

            // ACT
            await transport.start();
            await transport.send(requestMessage);
            // Wait for stream to process and reconnection to be scheduled
            await vi.advanceTimersByTimeAsync(50);

            // ASSERT
            // Verify we performed at least one POST for the initial stream.
            expect(fetchMock).toHaveBeenCalled();
            const postCall = fetchMock.mock.calls.find(call => call[1]?.method === 'POST');
            expect(postCall).toBeDefined();
        });

        it('should NOT reconnect a POST stream when response was received', async () => {
            // ARRANGE
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 1,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });

            // Create a stream that sends:
            // 1. Priming event with ID (enables potential reconnection)
            // 2. The actual response (should prevent reconnection)
            // 3. Then closes
            const streamWithResponse = new ReadableStream({
                start(controller) {
                    // Priming event with ID
                    controller.enqueue(new TextEncoder().encode('id: priming-123\ndata: \n\n'));
                    // The actual response to the request
                    controller.enqueue(
                        new TextEncoder().encode('id: response-456\ndata: {"jsonrpc":"2.0","result":{"tools":[]},"id":"request-1"}\n\n')
                    );
                    // Stream closes normally
                    controller.close();
                }
            });

            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: streamWithResponse
            });

            const requestMessage: JSONRPCRequest = {
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 'request-1',
                params: {}
            };

            // ACT
            await transport.start();
            await transport.send(requestMessage);
            await vi.advanceTimersByTimeAsync(50);

            // ASSERT
            // THE KEY ASSERTION: Fetch was called ONCE only - no reconnection!
            // The response was received, so no need to reconnect.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST');
        });

        it('per-request requestSignal abort: no onerror, no reconnect (McpSubscription.close())', async () => {
            // ARRANGE — a POST stream that has been primed with an SSE event id
            // (server-side resumability), so without the per-request abort
            // guard the transport WOULD schedule a GET+Last-Event-ID reconnect.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 1,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            let streamController!: ReadableStreamDefaultController<Uint8Array>;
            const primedStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                    // Priming event with an id — would arm POST-stream resumability.
                    controller.enqueue(new TextEncoder().encode('id: ev-1\ndata: \n\n'));
                }
            });
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
                // Propagate abort to the stream the way fetch does.
                init.signal?.addEventListener('abort', () => streamController.error(init.signal?.reason), { once: true });
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: primedStream
                });
            });

            const requestAbort = new AbortController();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'subscriptions/listen', id: 'listen-1', params: {} },
                { requestSignal: requestAbort.signal }
            );
            await vi.advanceTimersByTimeAsync(5);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // ACT — McpSubscription.close() aborts the per-request signal.
            requestAbort.abort();
            await vi.advanceTimersByTimeAsync(50);

            // ASSERT — intentional per-request abort: no onerror, no reconnect.
            expect(errorSpy).not.toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('per-request requestSignal abort while a reconnect is scheduled: the pending reconnect never fires (#2615)', async () => {
            // ARRANGE — a POST stream that is primed (SSE event id) and then
            // closes gracefully WITHOUT delivering the response, so the
            // transport schedules a GET+Last-Event-ID reconnect. The abort
            // lands in the window between "reconnect scheduled" and "reconnect
            // fires" — the shape a request timeout produces.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 5,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const primedClosingStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('id: ev-1\ndata: \n\n'));
                    controller.close();
                }
            });
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: primedClosingStream
            });

            const requestAbort = new AbortController();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} },
                { requestSignal: requestAbort.signal }
            );
            // Let the stream close and the reconnect get scheduled (delay 10ms).
            await vi.advanceTimersByTimeAsync(5);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // ACT — the request settles (timeout/cancel) before the reconnect fires.
            requestAbort.abort();
            await vi.advanceTimersByTimeAsync(100);

            // ASSERT — the scheduled reconnect saw the aborted requestSignal
            // and bailed: no GET resume, no onerror.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('resumptionToken send: requestSignal abort while the resume GET is in flight surfaces no spurious onerror (#2615)', async () => {
            // ARRANGE — a request re-issued with options.resumptionToken
            // short-circuits send() into a GET+Last-Event-ID resume. The
            // server hangs on that GET (the exact scenario request timeouts
            // exist for), so the settlement abort lands MID-FETCH — not in
            // the scheduled-reconnect window the sibling test covers.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockImplementation(
                (_url, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
                    })
            );

            const requestAbort = new AbortController();
            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} },
                { resumptionToken: 'evt-42', requestSignal: requestAbort.signal, onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(5);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // ACT — the request settles (timeout/cancel) while the resume GET
            // is still in flight; the fetch rejects with an AbortError.
            requestAbort.abort();
            await vi.advanceTimersByTimeAsync(100);

            // ASSERT — a deliberate per-request teardown is a clean shutdown:
            // no transport error, and no stream-end callback (the contract
            // excludes deliberate requestSignal aborts).
            expect(errorSpy).not.toHaveBeenCalled();
            expect(onStreamEnd).not.toHaveBeenCalled();
        });

        it('resumptionToken send: a genuine resume GET failure surfaces onerror exactly once (no double-report)', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const failure = new TypeError('fetch failed');
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockRejectedValueOnce(failure);

            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} },
                { resumptionToken: 'evt-42', onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(5);

            // _startOrAuthSse's own catch reports the failure; the send()
            // short-circuit must not report it a second time.
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(failure);

            // A genuine open failure is TERMINAL for the resumed stream (no
            // reconnect is ever scheduled for an initial-open failure) and
            // send() already resolved fire-and-forget — the stream-end
            // callback is the caller's only per-request settlement signal.
            expect(onStreamEnd).toHaveBeenCalledTimes(1);
        });

        it('a ReconnectionScheduler that throws on reschedule still settles the caller via onRequestStreamEnd', async () => {
            let schedulerCalls = 0;
            const scheduler: ReconnectionScheduler = reconnect => {
                schedulerCalls++;
                if (schedulerCalls === 1) {
                    const handle = setTimeout(reconnect, 1);
                    return () => clearTimeout(handle);
                }
                // The reschedule after a failed leg: platform denies the task.
                throw new Error('platform denied background task');
            };
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 5,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                },
                reconnectionScheduler: scheduler
            });
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const fetchMock = globalThis.fetch as Mock;
            // POST: primed SSE stream, graceful close without a response.
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('id: ev-1\ndata: \n\n'));
                        controller.close();
                    }
                })
            });
            // The reconnect leg fails genuinely, forcing a reschedule.
            fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} },
                { onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(10);

            // The failed leg reported once, the scheduler throw reported once,
            // and — because no further attempt could be armed — the chain is
            // terminally dead, so the caller was settled.
            expect(schedulerCalls).toBe(2);
            expect(errorSpy).toHaveBeenCalledWith(new TypeError('fetch failed'));
            expect(errorSpy).toHaveBeenCalledWith(new Error('platform denied background task'));
            expect(onStreamEnd).toHaveBeenCalledTimes(1);
        });

        it('close() disarms EVERY pending scheduled reconnect, not just the last-scheduled chain', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10_000,
                    maxRetries: 2,
                    maxReconnectionDelay: 30_000,
                    reconnectionDelayGrowFactor: 1
                }
            });
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            // Every POST returns a primed SSE stream that closes gracefully
            // without a response — each send spawns its own reconnect chain.
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockImplementation(async () => ({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('id: ev-1\ndata: \n\n'));
                        controller.close();
                    }
                })
            }));

            await transport.start();
            await transport.send({ jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} });
            await transport.send({ jsonrpc: '2.0', method: 'long_running_tool', id: 'request-2', params: {} });
            await vi.advanceTimersByTimeAsync(5);

            // Two chains, two pending scheduled attempts.
            expect(vi.getTimerCount()).toBe(2);

            // ACT — close must disarm BOTH, not only the last-written one.
            await transport.close();

            expect(vi.getTimerCount()).toBe(0);
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('a settled request disarms its own pending scheduled reconnect immediately', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10_000,
                    maxRetries: 2,
                    maxReconnectionDelay: 30_000,
                    reconnectionDelayGrowFactor: 1
                }
            });
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('id: ev-1\ndata: \n\n'));
                        controller.close();
                    }
                })
            });

            const requestAbort = new AbortController();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} },
                { requestSignal: requestAbort.signal }
            );
            await vi.advanceTimersByTimeAsync(5);
            expect(vi.getTimerCount()).toBe(1);

            // ACT — the request settles during the backoff window: the armed
            // timer is released immediately, not left to bail at fire time.
            requestAbort.abort();
            expect(vi.getTimerCount()).toBe(0);

            await vi.advanceTimersByTimeAsync(60_000);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('resume leg that drops before its first event reschedules with the ORIGINAL resumption token', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 2,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const fetchMock = globalThis.fetch as Mock;
            // GET#1 (the resume): closes gracefully with ZERO events, so the
            // leg produces no lastEventId of its own.
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.close();
                    }
                })
            });
            // GET#2 (the rebuilt leg): hangs, keeping the count deterministic.
            fetchMock.mockImplementation(() => new Promise(() => {}));

            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} },
                { resumptionToken: 'evt-42' }
            );
            await vi.advanceTimersByTimeAsync(5);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // Fire the scheduled rebuild.
            await vi.advanceTimersByTimeAsync(15);
            expect(fetchMock).toHaveBeenCalledTimes(2);

            // The rebuilt GET must still carry the token this resume was
            // opened with — without the fallback it degrades into a
            // token-less standalone GET and loses the replay position.
            const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
            expect((secondInit.headers as Headers).get('last-event-id')).toBe('evt-42');
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('resumptionToken send: forwards onresumptiontoken so the resumed stream reports newer event IDs', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            // The resumed GET replays a newer event carrying the response.
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode('id: evt-43\ndata: {"jsonrpc":"2.0","id":"request-1","result":{}}\n\n')
                        );
                        controller.close();
                    }
                })
            });

            const tokens: string[] = [];
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} },
                { resumptionToken: 'evt-42', onresumptiontoken: token => tokens.push(token) }
            );
            await vi.advanceTimersByTimeAsync(5);

            // The caller's persistence hook saw the newer event ID.
            expect(tokens).toEqual(['evt-43']);
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('resumptionToken send: forwards onRequestStreamEnd so a terminal non-resumable outcome settles the caller', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            // 405 on the resume GET: terminal, non-resumable — the stream-end
            // callback must fire so the caller can settle.
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 405,
                statusText: 'Method Not Allowed',
                headers: new Headers(),
                text: async () => ''
            });

            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} },
                { resumptionToken: 'evt-42', onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(5);

            expect(onStreamEnd).toHaveBeenCalledTimes(1);
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('202-initialized standalone GET: a genuine failure surfaces onerror exactly once (no double-report)', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const failure = new TypeError('fetch failed');
            const fetchMock = globalThis.fetch as Mock;
            // The notifications/initialized POST is 202-accepted...
            fetchMock.mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers(), text: async () => '' });
            // ...and the standalone GET it triggers fails genuinely.
            fetchMock.mockRejectedValueOnce(failure);

            await transport.start();
            await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            await vi.advanceTimersByTimeAsync(5);
            expect(fetchMock).toHaveBeenCalledTimes(2);

            // _startOrAuthSse's own catch reports the failure; the 202 branch
            // must not report it a second time.
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(failure);
        });

        it('202-initialized standalone GET: transport.close() while the GET is in flight surfaces no spurious onerror', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers(), text: async () => '' });
            // The standalone GET hangs until its signal aborts.
            fetchMock.mockImplementationOnce(
                (_url, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
                    })
            );

            await transport.start();
            await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            await vi.advanceTimersByTimeAsync(5);
            expect(fetchMock).toHaveBeenCalledTimes(2);

            // ACT — deliberate shutdown while the standalone GET is in flight.
            await transport.close();
            await vi.advanceTimersByTimeAsync(5);

            // ASSERT — a clean shutdown, not a transport error.
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('notification POST: transport.close() while the POST is in flight surfaces no spurious onerror', async () => {
            // Notification sends carry no requestSignal, so the POST's fetch
            // signal is the transport-lifetime signal alone — close() landing
            // mid-POST must read as a clean shutdown, not a transport error.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockImplementationOnce(
                (_url, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
                    })
            );

            await transport.start();
            let sendError: unknown;
            const pending = transport.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }).catch(error => {
                sendError = error;
            });
            await vi.advanceTimersByTimeAsync(5);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // ACT — deliberate shutdown while the POST is in flight.
            await transport.close();
            await pending;

            // ASSERT — the rethrow is kept (send() rejects so callers settle),
            // but no onerror fires for a deliberate shutdown.
            expect(sendError).toBeInstanceOf(DOMException);
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('terminateSession: transport.close() while the DELETE is in flight surfaces no spurious onerror', async () => {
            // The session-termination DELETE runs on the transport-lifetime
            // signal alone — close() landing mid-flight must read as a clean
            // shutdown, not a transport error. (A sessionId is required or
            // terminateSession() no-ops without fetching.)
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { sessionId: 'session-1' });
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockImplementationOnce(
                (_url, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
                    })
            );

            await transport.start();
            let terminateError: unknown;
            const pending = transport.terminateSession().catch(error => {
                terminateError = error;
            });
            await vi.advanceTimersByTimeAsync(5);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // ACT — deliberate shutdown while the DELETE is in flight.
            await transport.close();
            await pending;

            // ASSERT — the rethrow is kept (terminateSession() rejects so the
            // caller sees the outcome), but no onerror fires.
            expect(terminateError).toBeInstanceOf(DOMException);
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('failed reconnect leg surfaces onerror exactly once (no double-report), then retries', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 5,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const failure = new TypeError('fetch failed');
            const fetchMock = globalThis.fetch as Mock;
            // POST stream: primed (SSE event id), then a graceful close
            // without the response — schedules a GET reconnect at +10ms.
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('id: ev-1\ndata: \n\n'));
                        controller.close();
                    }
                })
            });
            // The reconnect GET fails genuinely.
            fetchMock.mockRejectedValueOnce(failure);
            // The retried leg after it hangs, so the count stays deterministic.
            fetchMock.mockImplementation(() => new Promise(() => {}));

            await transport.start();
            await transport.send({ jsonrpc: '2.0', method: 'long_running_tool', id: 'request-1', params: {} });
            // Let the stream close and the reconnect get scheduled...
            await vi.advanceTimersByTimeAsync(5);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            // ...then fire the reconnect leg and let it fail.
            await vi.advanceTimersByTimeAsync(10);
            expect(fetchMock).toHaveBeenCalledTimes(2);

            // _startOrAuthSse's own catch is the single reporting site — the
            // reconnect scheduler must not report the same failure again.
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(failure);

            // The retry itself still happens (attempt 2 fires the next GET).
            await vi.advanceTimersByTimeAsync(15);
            expect(fetchMock).toHaveBeenCalledTimes(3);
            expect(errorSpy).toHaveBeenCalledTimes(1);
        });

        it('onRequestStreamEnd fires when the per-request POST stream ends gracefully without reconnecting', async () => {
            // ARRANGE — a POST stream with NO priming event id (so the
            // graceful-close path does NOT schedule a reconnect): the
            // per-request stream simply ends.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            let streamController!: ReadableStreamDefaultController<Uint8Array>;
            const unprimedStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                    // An ack frame with no SSE event id — does NOT arm POST-stream resumability.
                    controller.enqueue(
                        new TextEncoder().encode(
                            'data: {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{}}\n\n'
                        )
                    );
                }
            });
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockImplementationOnce(() =>
                Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: unprimedStream
                })
            );

            const requestAbort = new AbortController();
            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'subscriptions/listen', id: 'listen:0', params: {} },
                { requestSignal: requestAbort.signal, onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(5);
            expect(onStreamEnd).not.toHaveBeenCalled();

            // ACT — server gracefully closes the SSE stream.
            streamController.close();
            await vi.advanceTimersByTimeAsync(5);

            // ASSERT — non-deliberate stream end without reconnecting:
            // onRequestStreamEnd fired exactly once; no further fetches.
            expect(onStreamEnd).toHaveBeenCalledTimes(1);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('onRequestStreamEnd does NOT fire on a deliberate per-request abort', async () => {
            // Same shape as the no-onerror/no-reconnect test, but assert the
            // stream-end callback is NEVER invoked when `requestSignal` was the
            // abort source.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            let streamController!: ReadableStreamDefaultController<Uint8Array>;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                }
            });
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
                init.signal?.addEventListener('abort', () => streamController.error(init.signal?.reason), { once: true });
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: stream
                });
            });

            const requestAbort = new AbortController();
            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'subscriptions/listen', id: 'listen:0', params: {} },
                { requestSignal: requestAbort.signal, onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(5);

            // ACT — deliberate per-request abort.
            requestAbort.abort();
            await vi.advanceTimersByTimeAsync(50);

            // ASSERT — deliberate abort: onRequestStreamEnd never fires.
            expect(onStreamEnd).not.toHaveBeenCalled();
        });

        it('onRequestStreamEnd fires when reconnection attempts are exhausted (maxRetries reached)', async () => {
            // ARRANGE — a primed POST stream (so a non-deliberate close
            // schedules a GET resume); every GET resume fails; maxRetries 1
            // means the second schedule hits the exhausted branch.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 5,
                    maxRetries: 1,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            let streamController!: ReadableStreamDefaultController<Uint8Array>;
            const primedStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                    controller.enqueue(new TextEncoder().encode('id: ev-1\ndata: \n\n'));
                }
            });
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: primedStream
            });
            // The GET resume fails with a 5xx → reconnect catch reschedules → exhausted.
            fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'unavailable', headers: new Headers() });

            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'subscriptions/listen', id: 'listen:0', params: {} },
                { requestSignal: new AbortController().signal, onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(5);
            expect(onStreamEnd).not.toHaveBeenCalled();

            // ACT — server closes the primed POST stream non-deliberately.
            streamController.close();
            await vi.advanceTimersByTimeAsync(100);

            // ASSERT — exhausted: onRequestStreamEnd fired exactly once (the
            // max-retries branch); the exhausted onerror surfaced.
            expect(onStreamEnd).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('Maximum reconnection attempts') })
            );
        });

        it('onRequestStreamEnd fires when the per-request POST stream ERRORS without reconnecting', async () => {
            // ARRANGE — a POST stream with NO priming event id; the body
            // errors (network drop). The error-branch `else` (no reconnect,
            // not intentional-abort) must fire onRequestStreamEnd.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            const failingStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            'data: {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{}}\n\n'
                        )
                    );
                    queueMicrotask(() => controller.error(new Error('network drop')));
                }
            });
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: failingStream
            });

            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'subscriptions/listen', id: 'listen:0', params: {} },
                { requestSignal: new AbortController().signal, onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(50);

            // ASSERT — error-branch fired exactly once; no reconnection
            // attempted (POST stream wasn't primed).
            expect(onStreamEnd).toHaveBeenCalledTimes(1);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('onRequestStreamEnd does NOT fire on transport.close()', async () => {
            // The transport-wide abort is the OTHER deliberate teardown
            // (`isIntentionalAbort()` checks both signals): a per-request
            // stream-end callback must not fire when close() tore the stream
            // down — `_onclose` is the settle path for that.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            let streamController!: ReadableStreamDefaultController<Uint8Array>;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                    controller.enqueue(new TextEncoder().encode('id: ev-1\ndata: \n\n'));
                }
            });
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
                init.signal?.addEventListener('abort', () => streamController.error(init.signal?.reason), { once: true });
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: stream
                });
            });

            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'subscriptions/listen', id: 'listen:0', params: {} },
                { requestSignal: new AbortController().signal, onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(5);

            // ACT — transport-wide close.
            await transport.close();
            await vi.advanceTimersByTimeAsync(50);

            // ASSERT — deliberate transport close: onRequestStreamEnd never fires.
            expect(onStreamEnd).not.toHaveBeenCalled();
        });

        it('onRequestStreamEnd fires when a primed POST→GET resume hits 405 (non-resumable terminal)', async () => {
            // R1 regression: against a server that stamps SSE event ids on the
            // listen POST stream but returns 405 on the GET resume,
            // `_startOrAuthSse` resolved without a stream and nothing fired —
            // the subscription dead-ended silently. The 405 is now a terminal
            // per-request stream-end. ALSO asserts the GET resume carried the
            // per-request `requestSignal` (the close-after-reconnect path).
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 5,
                    maxRetries: 3,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });
            let streamController!: ReadableStreamDefaultController<Uint8Array>;
            const primedStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                    controller.enqueue(new TextEncoder().encode('id: ev-1\ndata: \n\n'));
                }
            });
            const fetchMock = globalThis.fetch as Mock;
            let getSignal: AbortSignal | null | undefined;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: primedStream
            });
            fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
                getSignal = init.signal;
                return Promise.resolve({ ok: false, status: 405, headers: new Headers() });
            });

            const requestAbort = new AbortController();
            const onStreamEnd = vi.fn();
            await transport.start();
            await transport.send(
                { jsonrpc: '2.0', method: 'subscriptions/listen', id: 'listen:0', params: {} },
                { requestSignal: requestAbort.signal, onRequestStreamEnd: onStreamEnd }
            );
            await vi.advanceTimersByTimeAsync(5);

            // ACT — server closes the primed POST stream → schedules a GET resume → 405.
            streamController.close();
            await vi.advanceTimersByTimeAsync(50);

            // ASSERT — onRequestStreamEnd fired exactly once on the 405; the
            // resume was a single GET (no further retries — 405 resolves).
            expect(onStreamEnd).toHaveBeenCalledTimes(1);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[1]![1]?.method).toBe('GET');
            // requestSignal threaded through the GET reconnect: aborting the
            // per-request signal aborts the resume's fetch signal.
            expect(getSignal).toBeDefined();
            expect(getSignal?.aborted).toBe(false);
            requestAbort.abort();
            expect(getSignal?.aborted).toBe(true);
        });

        it('per-request requestSignal abort BEFORE response headers: no misleading onerror; send() still rejects', async () => {
            // ARRANGE — fetch is in flight (pending promise) when the
            // requestSignal aborts; fetch rejects with AbortError before the
            // SSE stream handler ever runs. _send's catch must apply the same
            // intentional-abort guard as _handleSseStream.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
            const errorSpy = vi.fn();
            transport.onerror = errorSpy;
            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockImplementationOnce(
                (_url, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
                    })
            );

            const requestAbort = new AbortController();
            await transport.start();
            const sent = transport.send(
                { jsonrpc: '2.0', method: 'subscriptions/listen', id: 'listen-1', params: {} },
                { requestSignal: requestAbort.signal }
            );
            // Let _send reach the in-flight fetch.
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // ACT — abort before headers.
            requestAbort.abort(new Error('intentional'));

            // ASSERT — send() rejects (so listen()'s send-catch settles), but no onerror.
            await expect(sent).rejects.toThrow();
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('anySignal fallback removes the sibling listener (no leak on the transport-lifetime signal)', async () => {
            // ARRANGE — force the manual fallback path (Node 20.0–20.2).
            const nativeAny = AbortSignal.any;
            (AbortSignal as { any?: unknown }).any = undefined;
            try {
                transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
                const fetchMock = globalThis.fetch as Mock;
                fetchMock.mockResolvedValue({ ok: true, status: 202, headers: new Headers() });
                await transport.start();

                const transportSignal = (transport as unknown as { _abortController: AbortController })._abortController.signal;
                const addSpy = vi.spyOn(transportSignal, 'addEventListener');
                const removeSpy = vi.spyOn(transportSignal, 'removeEventListener');

                // ACT — N sends each with a fresh request-scoped signal that
                // aborts after the send completes (the McpSubscription.close()
                // pattern). Each send registers one fallback listener on the
                // transport-lifetime signal; aborting the request-scoped
                // signal must remove it.
                for (let i = 0; i < 5; i++) {
                    const requestAbort = new AbortController();
                    await transport.send(
                        { jsonrpc: '2.0', method: 'subscriptions/listen', id: `listen-${i}`, params: {} },
                        { requestSignal: requestAbort.signal }
                    );
                    requestAbort.abort();
                }

                // ASSERT — every listener registered on the transport-lifetime
                // signal was removed; nothing accrues per send().
                expect(addSpy.mock.calls.length).toBeGreaterThan(0);
                expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);
            } finally {
                (AbortSignal as { any?: unknown }).any = nativeAny;
            }
        });

        it('should NOT reconnect a POST stream when error response was received', async () => {
            // ARRANGE
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 1,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });

            const messageSpy = vi.fn();
            transport.onmessage = messageSpy;

            // Create a stream that sends:
            // 1. Priming event with ID (enables potential reconnection)
            // 2. An error response (should also prevent reconnection, just like success)
            // 3. Then closes
            const streamWithErrorResponse = new ReadableStream({
                start(controller) {
                    // Priming event with ID
                    controller.enqueue(new TextEncoder().encode('id: priming-123\ndata: \n\n'));
                    // An error response to the request (tool not found, for example)
                    controller.enqueue(
                        new TextEncoder().encode(
                            'id: error-456\ndata: {"jsonrpc":"2.0","error":{"code":-32602,"message":"Tool not found"},"id":"request-1"}\n\n'
                        )
                    );
                    // Stream closes normally
                    controller.close();
                }
            });

            const fetchMock = global.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: streamWithErrorResponse
            });

            const requestMessage: JSONRPCRequest = {
                jsonrpc: '2.0',
                method: 'tools/call',
                id: 'request-1',
                params: { name: 'nonexistent-tool' }
            };

            // ACT
            await transport.start();
            await transport.send(requestMessage);
            await vi.advanceTimersByTimeAsync(50);

            // ASSERT
            // THE KEY ASSERTION: Fetch was called ONCE only - no reconnection!
            // The error response was received, so no need to reconnect.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST');

            // Verify the error response was delivered to the message handler
            expect(messageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    error: expect.objectContaining({
                        code: -32602,
                        message: 'Tool not found'
                    }),
                    id: 'request-1'
                })
            );
        });

        it('should not attempt reconnection after close() is called', async () => {
            // ARRANGE
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 100,
                    maxRetries: 3,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });

            // Stream with priming event + notification (no response) that closes
            // This triggers reconnection scheduling
            const streamWithPriming = new ReadableStream({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode('id: event-123\ndata: {"jsonrpc":"2.0","method":"notifications/test","params":{}}\n\n')
                    );
                    controller.close();
                }
            });

            const fetchMock = globalThis.fetch as Mock;

            // POST request returns streaming response
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: streamWithPriming
            });

            // ACT
            await transport.start();
            await transport.send({ jsonrpc: '2.0', method: 'test', id: '1', params: {} });

            // Wait a tick to let stream processing complete and schedule reconnection
            await vi.advanceTimersByTimeAsync(10);

            // Now close() - reconnection timeout is pending (scheduled for 100ms)
            await transport.close();

            // Advance past reconnection delay
            await vi.advanceTimersByTimeAsync(200);

            // ASSERT
            // Only 1 call: the initial POST. No reconnection attempts after close().
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST');
        });

        it('should not throw JSON parse error on priming events with empty data', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));

            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            const resumptionTokenSpy = vi.fn();

            // Create a stream that sends a priming event (ID only, empty data) then a real message
            const streamWithPrimingEvent = new ReadableStream({
                start(controller) {
                    // Send a priming event with ID but empty data - this should NOT cause a JSON parse error
                    controller.enqueue(new TextEncoder().encode('id: priming-123\ndata: \n\n'));
                    // Send a real message
                    controller.enqueue(
                        new TextEncoder().encode('id: msg-456\ndata: {"jsonrpc":"2.0","result":{"tools":[]},"id":"req-1"}\n\n')
                    );
                    controller.close();
                }
            });

            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: streamWithPrimingEvent
            });

            await transport.start();
            transport.send(
                {
                    jsonrpc: '2.0',
                    method: 'tools/list',
                    id: 'req-1',
                    params: {}
                },
                { resumptionToken: undefined, onresumptiontoken: resumptionTokenSpy }
            );

            await vi.advanceTimersByTimeAsync(50);

            // No JSON parse errors should have occurred
            expect(errorSpy).not.toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('Unexpected end of JSON') })
            );
            // Resumption token callback may be invoked, but the primary assertion
            // here is that no JSON parse errors occurred for the priming event.
        });
    });

    it('invalidates all credentials on OAuthErrorCode.InvalidClient during auth', async () => {
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
            headers: new Headers(),
            text: async () => {
                throw 'dont read my body';
            }
        };
        (globalThis.fetch as Mock)
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
            // Token refresh fails with OAuthErrorCode.InvalidClient
            .mockResolvedValueOnce(
                Response.json(new OAuthError(OAuthErrorCode.InvalidClient, 'Client authentication failed').toResponseObject(), {
                    status: 400
                })
            )
            // Fallback should fail to complete the flow
            .mockResolvedValue({
                ok: false,
                status: 404
            });

        // Ensure the auth flow completes without unhandled rejections for this
        // error type; token invalidation behavior is covered in dedicated tests.
        await transport.send(message).catch(() => {});
    });

    it('invalidates all credentials on OAuthErrorCode.UnauthorizedClient during auth', async () => {
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
            headers: new Headers(),
            text: async () => {
                throw 'dont read my body';
            }
        };
        (globalThis.fetch as Mock)
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
            // Token refresh fails with OAuthErrorCode.UnauthorizedClient
            .mockResolvedValueOnce(
                Response.json(new OAuthError(OAuthErrorCode.UnauthorizedClient, 'Client not authorized').toResponseObject(), {
                    status: 400
                })
            )
            // Fallback should fail to complete the flow
            .mockResolvedValue({
                ok: false,
                status: 404,
                text: async () => {
                    throw 'dont read my body';
                }
            });

        // As above, just ensure the auth flow completes without unhandled
        // rejections in this scenario.
        await transport.send(message).catch(() => {});
    });

    it('invalidates tokens on OAuthErrorCode.InvalidGrant during auth', async () => {
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
            headers: new Headers(),
            text: async () => {
                throw 'dont read my body';
            }
        };
        (globalThis.fetch as Mock)
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
            // Token refresh fails with OAuthErrorCode.InvalidGrant
            .mockResolvedValueOnce(
                Response.json(new OAuthError(OAuthErrorCode.InvalidGrant, 'Invalid refresh token').toResponseObject(), { status: 400 })
            )
            // Fallback should fail to complete the flow
            .mockResolvedValue({
                ok: false,
                status: 404,
                text: async () => {
                    throw 'dont read my body';
                }
            });

        // Behavior for OAuthErrorCode.InvalidGrant during auth is covered in dedicated OAuth
        // unit tests and SSE transport tests. Here we just assert that the call
        // path completes without unhandled rejections.
        await transport.send(message).catch(() => {});
    });

    describe('custom fetch in auth code paths', () => {
        it('uses custom fetch during auth flow on 401 - no global fetch fallback', async () => {
            const unauthedResponse = {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: new Headers(),
                text: async () => {
                    throw 'dont read my body';
                }
            };

            // Create custom fetch
            const customFetch = vi
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
                // Token refresh fails with OAuthErrorCode.InvalidClient
                .mockResolvedValueOnce(
                    Response.json(new OAuthError(OAuthErrorCode.InvalidClient, 'Client authentication failed').toResponseObject(), {
                        status: 400
                    })
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
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });

        it('uses custom fetch in finishAuth method - no global fetch fallback', async () => {
            // Create custom fetch
            const customFetch = vi
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
            expect(mockAuthProvider.saveTokens).toHaveBeenCalledWith(
                expect.objectContaining({
                    access_token: 'new-access-token',
                    token_type: 'Bearer',
                    expires_in: 3600,
                    refresh_token: 'new-refresh-token'
                }),
                expect.anything()
            );

            // Global fetch should never have been called
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });
    });

    describe('SSE retry field handling', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            (globalThis.fetch as Mock).mockReset();
        });
        afterEach(() => vi.useRealTimers());

        it('should use server-provided retry value for reconnection delay', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 100,
                    maxReconnectionDelay: 5000,
                    reconnectionDelayGrowFactor: 2,
                    maxRetries: 3
                }
            });

            // Create a stream that sends a retry field
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    // Send SSE event with retry field
                    const event =
                        'retry: 3000\nevent: message\nid: evt-1\ndata: {"jsonrpc": "2.0", "method": "notification", "params": {}}\n\n';
                    controller.enqueue(encoder.encode(event));
                    // Close stream to trigger reconnection
                    controller.close();
                }
            });

            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: stream
            });

            // Second request for reconnection
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: new ReadableStream()
            });

            await transport.start();
            await transport['_startOrAuthSse']({});

            // Wait for stream to close and reconnection to be scheduled
            await vi.advanceTimersByTimeAsync(100);

            // Verify the server retry value was captured
            const transportInternal = transport as unknown as { _serverRetryMs?: number };
            expect(transportInternal._serverRetryMs).toBe(3000);

            // Verify the delay calculation uses server retry value
            const getDelay = transport['_getNextReconnectionDelay'].bind(transport);
            expect(getDelay(0)).toBe(3000); // Should use server value, not 100ms initial
            expect(getDelay(5)).toBe(3000); // Should still use server value for any attempt
        });

        it('should fall back to exponential backoff when no server retry value', () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 100,
                    maxReconnectionDelay: 5000,
                    reconnectionDelayGrowFactor: 2,
                    maxRetries: 3
                }
            });

            // Without any SSE stream, _serverRetryMs should be undefined
            const transportInternal = transport as unknown as { _serverRetryMs?: number };
            expect(transportInternal._serverRetryMs).toBeUndefined();

            // Should use exponential backoff
            const getDelay = transport['_getNextReconnectionDelay'].bind(transport);
            expect(getDelay(0)).toBe(100); // 100 * 2^0
            expect(getDelay(1)).toBe(200); // 100 * 2^1
            expect(getDelay(2)).toBe(400); // 100 * 2^2
            expect(getDelay(10)).toBe(5000); // capped at max
        });

        it('should reconnect on graceful stream close', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1,
                    maxRetries: 1
                }
            });

            // Create a stream that closes gracefully after sending an event with ID
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    // Send priming event with ID and retry field
                    const event = 'id: evt-1\nretry: 100\ndata: \n\n';
                    controller.enqueue(encoder.encode(event));
                    // Graceful close
                    controller.close();
                }
            });

            const fetchMock = globalThis.fetch as Mock;
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: stream
            });

            // Second request for reconnection
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: new ReadableStream()
            });

            await transport.start();
            await transport['_startOrAuthSse']({});

            // Wait for stream to process and close
            await vi.advanceTimersByTimeAsync(50);

            // Wait for reconnection delay (100ms from retry field)
            await vi.advanceTimersByTimeAsync(150);

            // Should have attempted reconnection
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[0]![1]?.method).toBe('GET');
            expect(fetchMock.mock.calls[1]![1]?.method).toBe('GET');

            // Second call should include Last-Event-ID
            const secondCallHeaders = fetchMock.mock.calls[1]![1]?.headers;
            expect(secondCallHeaders?.get('last-event-id')).toBe('evt-1');
        });
    });

    describe('Reconnection Logic with maxRetries 0', () => {
        let transport: StreamableHTTPClientTransport;

        // Use fake timers to control setTimeout and make the test instant.
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());

        it('should not schedule any reconnection attempts when maxRetries is 0', async () => {
            // ARRANGE
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 0, // This should disable retries completely
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });

            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            // ACT - directly call _scheduleReconnection which is the code path the fix affects
            transport['_scheduleReconnection']({});

            // ASSERT - should immediately report max retries exceeded, not schedule a retry
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Maximum reconnection attempts (0) exceeded.'
                })
            );

            // Verify no reconnection was scheduled
            expect(transport['_pendingReconnectCancels'].size).toBe(0);
        });

        it('should schedule reconnection when maxRetries is greater than 0', async () => {
            // ARRANGE
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxRetries: 1, // Allow 1 retry
                    maxReconnectionDelay: 1000,
                    reconnectionDelayGrowFactor: 1
                }
            });

            const errorSpy = vi.fn();
            transport.onerror = errorSpy;

            // ACT - call _scheduleReconnection with attemptCount 0
            transport['_scheduleReconnection']({});

            // ASSERT - should schedule a reconnection, not report error yet
            expect(errorSpy).not.toHaveBeenCalled();
            expect(transport['_pendingReconnectCancels'].size).toBe(1);

            // Clean up the pending reconnection to avoid test pollution
            for (const entry of transport['_pendingReconnectCancels']) {
                entry.cancel();
            }
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
                headers: new Headers(),
                text: async () => {
                    throw 'dont read my body';
                }
            };

            (globalThis.fetch as Mock)
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

            const error = await transport.send(message).catch(e => e);
            expect(error).toBeInstanceOf(SdkHttpError);
            expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpAuthentication);
            expect((error as SdkHttpError).status).toBe(401);
            expect((error as SdkHttpError).statusText).toBe('Unauthorized');
            expect(mockAuthProvider.saveTokens).toHaveBeenCalledWith(
                expect.objectContaining({
                    access_token: 'new-access-token',
                    token_type: 'Bearer',
                    expires_in: 3600,
                    refresh_token: 'refresh-token' // Refresh token is preserved
                }),
                expect.anything()
            );
        });
    });

    describe('reconnectionScheduler', () => {
        const reconnectionOptions: StreamableHTTPReconnectionOptions = {
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 5000,
            reconnectionDelayGrowFactor: 2,
            maxRetries: 3
        };

        function triggerReconnection(t: StreamableHTTPClientTransport): void {
            (t as unknown as { _scheduleReconnection(opts: StartSSEOptions, attempt?: number): void })._scheduleReconnection({}, 0);
        }

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('invokes the custom scheduler with reconnect, delay, and attemptCount', () => {
            const scheduler = vi.fn<ReconnectionScheduler>();
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: scheduler
            });

            triggerReconnection(transport);

            expect(scheduler).toHaveBeenCalledTimes(1);
            expect(scheduler).toHaveBeenCalledWith(expect.any(Function), 1000, 0);
        });

        it('falls back to setTimeout when no scheduler is provided', () => {
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions
            });

            triggerReconnection(transport);

            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
        });

        it('does not use setTimeout when a custom scheduler is provided', () => {
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: vi.fn()
            });

            triggerReconnection(transport);

            expect(setTimeoutSpy).not.toHaveBeenCalled();
        });

        it('calls the returned cancel function on close()', async () => {
            const cancel = vi.fn();
            const scheduler: ReconnectionScheduler = vi.fn(() => cancel);
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: scheduler
            });

            triggerReconnection(transport);
            expect(cancel).not.toHaveBeenCalled();

            await transport.close();
            expect(cancel).toHaveBeenCalledTimes(1);
        });

        it('tolerates schedulers that return void (no cancel function)', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: () => {
                    /* no return */
                }
            });

            triggerReconnection(transport);
            await expect(transport.close()).resolves.toBeUndefined();
        });

        it('clears the default setTimeout on close() when no scheduler is provided', async () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions
            });

            triggerReconnection(transport);
            await transport.close();

            expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
        });

        it('ignores a late-firing reconnect after close()', async () => {
            let capturedReconnect: (() => void) | undefined;
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: reconnect => {
                    capturedReconnect = reconnect;
                }
            });
            const onerror = vi.fn();
            transport.onerror = onerror;

            await transport.start();
            triggerReconnection(transport);
            await transport.close();

            capturedReconnect?.();
            await vi.runAllTimersAsync();

            expect(onerror).not.toHaveBeenCalled();
        });

        it('still aborts and fires onclose if the cancel function throws', async () => {
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: () => () => {
                    throw new Error('cancel failed');
                }
            });
            const onclose = vi.fn();
            transport.onclose = onclose;

            await transport.start();
            triggerReconnection(transport);
            const abortController = transport['_abortController'];

            await expect(transport.close()).rejects.toThrow('cancel failed');
            expect(abortController?.signal.aborted).toBe(true);
            expect(onclose).toHaveBeenCalledTimes(1);
        });

        it('a throwing cancel does not skip cancelling sibling chains on close()', async () => {
            const cancel1 = vi.fn(() => {
                throw new Error('cancel 1 failed');
            });
            const cancel2 = vi.fn();
            const cancels = [cancel1, cancel2];
            let scheduleCount = 0;
            const scheduler: ReconnectionScheduler = vi.fn(() => cancels[scheduleCount++]);
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: scheduler
            });
            const onclose = vi.fn();
            transport.onclose = onclose;

            await transport.start();
            // Two independent pending chains, each with its own cancel.
            triggerReconnection(transport);
            triggerReconnection(transport);
            const abortController = transport['_abortController'];

            // The FIRST cancel error still propagates, but only after every
            // sibling chain has been disarmed too.
            await expect(transport.close()).rejects.toThrow('cancel 1 failed');
            expect(cancel1).toHaveBeenCalledTimes(1);
            expect(cancel2).toHaveBeenCalledTimes(1);
            expect(abortController?.signal.aborted).toBe(true);
            expect(onclose).toHaveBeenCalledTimes(1);
            expect(transport['_pendingReconnectCancels'].size).toBe(0);
        });

        it("runs a pending chain's cancel at most once across close() and request settlement", async () => {
            const cancel = vi.fn();
            const scheduler: ReconnectionScheduler = vi.fn(() => cancel);
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: scheduler
            });

            await transport.start();
            // A per-request chain in its backoff window: the settlement
            // listener is armed on the request-scoped signal.
            const requestAbort = new AbortController();
            (transport as unknown as { _scheduleReconnection(opts: StartSSEOptions, attempt?: number): void })._scheduleReconnection(
                { requestSignal: requestAbort.signal },
                0
            );

            await transport.close();
            expect(cancel).toHaveBeenCalledTimes(1);

            // close() -> onclose -> Protocol._onclose rejects the pending
            // request -> its .finally() aborts the request-scoped signal.
            // The chain's settlement listener must have been released by
            // close(), so the cancel does NOT run a second time.
            requestAbort.abort();
            expect(cancel).toHaveBeenCalledTimes(1);
        });

        it('a throwing cancel at request settlement reports through onerror instead of escaping the abort dispatch', async () => {
            // Regression: the settlement listener invoked the user-supplied
            // cancel with try/finally but no catch. An exception thrown in an
            // AbortSignal 'abort' listener is NOT delivered to the abort()
            // caller — abort() returns normally and Node reports the
            // exception as an uncaughtException, terminating the process by
            // default. The protocol funnel aborts requestSignal on EVERY
            // settlement (success, timeout, caller abort, maxTotalTimeout),
            // so a throwing custom-scheduler cancel would kill the process on
            // the common path.
            const cancelError = new Error('cancel failed at settlement');
            const scheduler: ReconnectionScheduler = vi.fn(() => () => {
                throw cancelError;
            });
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: scheduler
            });
            const onerror = vi.fn();
            transport.onerror = onerror;

            await transport.start();
            const requestAbort = new AbortController();
            (transport as unknown as { _scheduleReconnection(opts: StartSSEOptions, attempt?: number): void })._scheduleReconnection(
                { requestSignal: requestAbort.signal },
                0
            );

            // The request settles: the funnel aborts its request-scoped
            // signal. The throwing cancel must be routed to onerror, not
            // escape the EventTarget dispatch.
            requestAbort.abort();

            expect(onerror).toHaveBeenCalledTimes(1);
            expect(onerror).toHaveBeenCalledWith(cancelError);
            // The finally disarm still ran: no stale Set entry survives.
            expect(transport['_pendingReconnectCancels'].size).toBe(0);
        });

        it('a first-schedule scheduler throw on graceful close reports the raw error exactly once', async () => {
            // Regression: the graceful-close settlement tail ran inside the
            // same try as the stream read loop. A scheduler that throws on
            // the FIRST schedule of a gap landed in the generic catch, got
            // mislabeled "SSE stream disconnected", and the catch re-drove
            // the tail: two onerror reports for one scheduler failure.
            const scheduleError = new Error('platform denied background task');
            const scheduler: ReconnectionScheduler = vi.fn(() => {
                throw scheduleError;
            });
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: scheduler
            });
            const onerror = vi.fn();
            transport.onerror = onerror;
            const onRequestStreamEnd = vi.fn();
            await transport.start();

            // A primed POST stream that closes gracefully without a response:
            // the graceful tail schedules the first reconnect attempt.
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('id: evt-1\ndata: \n\n'));
                    controller.close();
                }
            });
            transport['_handleSseStream'](stream, { onRequestStreamEnd }, false);
            await vi.advanceTimersByTimeAsync(50);

            expect(scheduler).toHaveBeenCalledTimes(1);
            expect(onerror).toHaveBeenCalledTimes(1);
            expect(onerror).toHaveBeenCalledWith(scheduleError);
            expect(onRequestStreamEnd).toHaveBeenCalledTimes(1);
        });

        it('a first-schedule scheduler throw on the ERROR path reports the raw error, matching the graceful path', async () => {
            // Regression: the error-path first-schedule catch wrapped the
            // scheduler throw as `Failed to reconnect: <message>`, discarding
            // the original error object, while the graceful-close tail and
            // the reschedule catch both report the raw error — inconsistent
            // shape for the same failure class.
            const scheduleError = new Error('platform denied background task');
            const scheduler: ReconnectionScheduler = vi.fn(() => {
                throw scheduleError;
            });
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: scheduler
            });
            const onerror = vi.fn();
            transport.onerror = onerror;
            const onRequestStreamEnd = vi.fn();
            await transport.start();

            // A reconnectable stream that ERRORS mid-read: the catch path
            // schedules the first reconnect attempt, and the scheduler throws.
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.error(new Error('network dropped'));
                }
            });
            transport['_handleSseStream'](stream, { onRequestStreamEnd }, true);
            await vi.advanceTimersByTimeAsync(50);

            expect(scheduler).toHaveBeenCalledTimes(1);
            // The stream error reports once ("SSE stream disconnected"), and
            // the scheduler failure reports RAW — same identity, no wrapper.
            expect(onerror.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([scheduleError]));
            expect(onRequestStreamEnd).toHaveBeenCalledTimes(1);
        });

        it('a throwing onRequestStreamEnd on graceful close is invoked once and never escapes processStream', async () => {
            // Regression: with the settlement tail inside the read-loop try,
            // a throwing caller-supplied onRequestStreamEnd was caught, the
            // catch re-invoked the SAME callback, and its second throw
            // escaped the fire-and-forget processStream() promise as an
            // unhandledRejection.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions
            });
            const onerror = vi.fn();
            transport.onerror = onerror;
            const callbackError = new Error('stream end failed');
            const onRequestStreamEnd = vi.fn(() => {
                throw callbackError;
            });
            await transport.start();

            // A POST stream with no priming event ends gracefully: the tail
            // takes the no-reconnect branch and fires the stream-end callback.
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.close();
                }
            });
            transport['_handleSseStream'](stream, { onRequestStreamEnd }, false);
            await vi.advanceTimersByTimeAsync(50);

            expect(onRequestStreamEnd).toHaveBeenCalledTimes(1);
            expect(onerror).toHaveBeenCalledTimes(1);
            expect(onerror).toHaveBeenCalledWith(callbackError);
        });

        it('a throwing onRequestStreamEnd in the reschedule-throw branch routes to onerror, not an unhandledRejection', async () => {
            // Regression: the reconnect closure's scheduleError branch fires
            // the caller's stream-end callback inside a floating promise
            // chain (`_startOrAuthSse(options).catch(...)`) — a throwing
            // callback rejected that chain with nothing attached,
            // terminating the process by default.
            const scheduleError = new Error('platform denied background task');
            let scheduleCalls = 0;
            let capturedReconnect: (() => void) | undefined;
            const scheduler: ReconnectionScheduler = vi.fn(reconnect => {
                scheduleCalls++;
                if (scheduleCalls > 1) {
                    throw scheduleError;
                }
                capturedReconnect = reconnect;
                return () => {};
            });
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions,
                reconnectionScheduler: scheduler
            });
            const onerror = vi.fn();
            transport.onerror = onerror;
            const callbackError = new Error('stream end failed');
            const onRequestStreamEnd = vi.fn(() => {
                throw callbackError;
            });
            await transport.start();

            // First schedule arms; the leg's fetch then fails, so the catch
            // reschedules — and the second schedule throws.
            (globalThis.fetch as Mock).mockRejectedValue(new Error('network down'));
            (transport as unknown as { _scheduleReconnection(opts: StartSSEOptions, attempt?: number): void })._scheduleReconnection(
                { onRequestStreamEnd },
                0
            );
            capturedReconnect!();
            await vi.advanceTimersByTimeAsync(50);

            expect(onRequestStreamEnd).toHaveBeenCalledTimes(1);
            // onerror: the leg's open failure, the scheduler error, and the
            // contained callback error — nothing escaped the floating chain.
            expect(onerror.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([scheduleError, callbackError]));
        });

        it('a throwing onRequestStreamEnd in the resumptionToken short-circuit routes to onerror, not an unhandledRejection', async () => {
            // Regression: the short-circuit's catch fires the stream-end
            // callback inside a floating promise chain; a throwing callback
            // became an unhandledRejection.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions
            });
            const onerror = vi.fn();
            transport.onerror = onerror;
            const callbackError = new Error('stream end failed');
            const onRequestStreamEnd = vi.fn(() => {
                throw callbackError;
            });
            await transport.start();

            // A genuine open failure (not an abort) on the resumed GET fires
            // the stream-end callback from the short-circuit's catch.
            (globalThis.fetch as Mock).mockRejectedValue(new Error('network down'));
            await transport.send({ jsonrpc: '2.0', method: 'ping', id: 'r-1' }, { resumptionToken: 'evt-0', onRequestStreamEnd });
            await vi.advanceTimersByTimeAsync(50);

            expect(onRequestStreamEnd).toHaveBeenCalledTimes(1);
            expect(onerror.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([callbackError]));
        });

        it('a throwing onresumptiontoken does not lose the event or misattribute a stream disconnect', async () => {
            // Regression: the caller's persistence hook was invoked bare in
            // the read loop. A throw (e.g. QuotaExceededError from the
            // documented storage write) exited into the generic catch: a
            // misattributed "SSE stream disconnected" onerror, the
            // response-bearing event's payload lost unreplayably, and a
            // reconnect chain re-entered at attempt 0 with the request never
            // marked complete.
            transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
                reconnectionOptions
            });
            const onerror = vi.fn();
            transport.onerror = onerror;
            const onmessage = vi.fn();
            transport.onmessage = onmessage;
            const quotaError = new Error('QuotaExceededError: storage full');
            const onresumptiontoken = vi.fn(() => {
                throw quotaError;
            });
            await transport.start();

            // One event carrying BOTH the id (hook throws) and the response.
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('id: evt-1\ndata: {"jsonrpc":"2.0","id":"r-1","result":{}}\n\n'));
                    controller.close();
                }
            });
            transport['_handleSseStream'](stream, { onresumptiontoken }, false);
            await vi.advanceTimersByTimeAsync(50);

            // The hook's failure is reported once, correctly attributed…
            expect(onerror).toHaveBeenCalledTimes(1);
            expect(onerror).toHaveBeenCalledWith(quotaError);
            // …the response still dispatches…
            expect(onmessage).toHaveBeenCalledTimes(1);
            // …and no bogus reconnect chain starts (response received).
            expect(transport['_pendingReconnectCancels'].size).toBe(0);
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });
    });
});

/**
 * End-to-end regression for #2615: on a legacy (2025-11-25) session, the
 * transport's request-scoped SSE reconnect chain (GET + Last-Event-ID
 * resumption) must stop once the originating request settles via timeout.
 * Before the fix, the chain kept resuming forever (every successful resume
 * resets the retry counter), and a late resumed GET carrying the original
 * JSON-RPC response surfaced as "Received a response for an unknown message
 * ID".
 */
describe('legacy era (2025-11-25): request timeout stops the SSE reconnect chain (#2615)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    const encoder = new TextEncoder();
    const sseResponse = (chunks: string[]) => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            }
        })
    });
    const jsonResponse = (message: JSONRPCMessage) => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => message,
        text: async () => JSON.stringify(message)
    });
    const accepted = () => ({ ok: true, status: 202, headers: new Headers(), text: async () => '' });
    const methodNotAllowed = () => ({
        ok: false,
        status: 405,
        statusText: 'Method Not Allowed',
        headers: new Headers(),
        text: async () => ''
    });

    it('stops resuming once the request times out; the late response never surfaces as an unknown message ID', async () => {
        let pingId: string | number | undefined;
        let eventSeq = 0;
        let settled = false;
        let resumesAfterSettle = 0;
        const cancelledPosts: JSONRPCMessage[] = [];

        const fetchMock = globalThis.fetch as Mock;
        fetchMock.mockImplementation(async (_url, init: RequestInit) => {
            if (init.method === 'GET') {
                const lastEventId = (init.headers as Headers).get('last-event-id');
                // Standalone notification stream: not offered by this server.
                if (lastEventId === null) {
                    return methodNotAllowed();
                }
                // Request-scoped resume. Once the request has settled, hand
                // back the late original response — before the fix this is
                // the resumed GET that surfaced "unknown message ID".
                if (settled) {
                    resumesAfterSettle++;
                    return sseResponse([`id: evt-${++eventSeq}\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(pingId)},"result":{}}\n\n`]);
                }
                // Keep the chain alive: a priming event id, then a graceful
                // close without the response (the server expects the client
                // to resume via GET + Last-Event-ID).
                return sseResponse([`id: evt-${++eventSeq}\ndata: \n\n`]);
            }
            const message = JSON.parse(init.body as string) as JSONRPCMessage;
            if ('method' in message) {
                if (message.method === 'initialize' && 'id' in message) {
                    return jsonResponse({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: '2025-11-25',
                            capabilities: {},
                            serverInfo: { name: 'legacy-server', version: '1.0.0' }
                        }
                    });
                }
                if (message.method === 'notifications/cancelled') {
                    cancelledPosts.push(message);
                    return accepted();
                }
                if (message.method === 'ping' && 'id' in message) {
                    pingId = message.id;
                    // SSE response: retry hint + priming event id, then a
                    // graceful close without the response.
                    return sseResponse([`retry: 10\nid: evt-${++eventSeq}\ndata: \n\n`]);
                }
            }
            return accepted();
        });

        const transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            reconnectionOptions: {
                initialReconnectionDelay: 10,
                maxRetries: 2,
                maxReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1
            }
        });
        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const errors: Error[] = [];
        client.onerror = error => errors.push(error);

        await client.connect(transport);

        const resumeGetCount = () =>
            fetchMock.mock.calls.filter(call => call[1]?.method === 'GET' && (call[1].headers as Headers).get('last-event-id') !== null)
                .length;

        let settledError: unknown;
        const pending = client.ping({ timeout: 100 }).catch(error => {
            settled = true;
            settledError = error;
        });

        // Let the reconnect chain run a few resume cycles before the timeout.
        await vi.advanceTimersByTimeAsync(50);
        expect(resumeGetCount()).toBeGreaterThan(0);
        expect(settled).toBe(false);

        // Cross the request timeout.
        await vi.advanceTimersByTimeAsync(100);
        await pending;
        expect(settled).toBe(true);
        expect(String(settledError)).toContain('Request timed out');

        // The legacy wire cancel signal is unchanged: exactly one
        // notifications/cancelled POST.
        expect(cancelledPosts).toHaveLength(1);

        // Give an orphaned chain ample time to keep resuming (before the fix
        // it reconnected forever — each successful resume resets the retry
        // counter, so maxRetries never binds).
        await vi.advanceTimersByTimeAsync(2000);

        // THE KEY ASSERTIONS: no resumed GET after the request settled, and
        // the late response never surfaced as an unknown message ID.
        expect(resumesAfterSettle).toBe(0);
        expect(errors.map(e => e.message)).not.toContainEqual(expect.stringContaining('unknown message ID'));

        await client.close();
    });

    it('cancellation POST still hits the wire when the original request was issued with a resumptionToken', async () => {
        // Regression for the cancel-path resumption leak: transport.send()
        // with a resumptionToken short-circuits into a GET+Last-Event-ID
        // resume WITHOUT posting the message. If the request's own
        // resumptionToken were forwarded into the notifications/cancelled
        // send, the cancellation would be silently swallowed (no POST) and a
        // fresh SSE reconnect chain — without the request-scoped abort signal
        // — would be spawned in its place.
        let eventSeq = 0;
        const cancelledPosts: JSONRPCMessage[] = [];

        const fetchMock = globalThis.fetch as Mock;
        fetchMock.mockImplementation(async (_url, init: RequestInit) => {
            if (init.method === 'GET') {
                const lastEventId = (init.headers as Headers).get('last-event-id');
                // Standalone notification stream: not offered by this server.
                if (lastEventId === null) {
                    return methodNotAllowed();
                }
                // Request-scoped resume: a priming event id, then a graceful
                // close without the response, so the chain keeps resuming
                // until the client tears it down.
                return sseResponse([`retry: 10\nid: evt-${++eventSeq}\ndata: \n\n`]);
            }
            const message = JSON.parse(init.body as string) as JSONRPCMessage;
            if ('method' in message) {
                if (message.method === 'initialize' && 'id' in message) {
                    return jsonResponse({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: '2025-11-25',
                            capabilities: {},
                            serverInfo: { name: 'legacy-server', version: '1.0.0' }
                        }
                    });
                }
                if (message.method === 'notifications/cancelled') {
                    cancelledPosts.push(message);
                    return accepted();
                }
            }
            return accepted();
        });

        const transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            reconnectionOptions: {
                initialReconnectionDelay: 10,
                maxRetries: 2,
                maxReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1
            }
        });
        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const errors: Error[] = [];
        client.onerror = error => errors.push(error);

        await client.connect(transport);

        const resumeGetCount = () =>
            fetchMock.mock.calls.filter(call => call[1]?.method === 'GET' && (call[1].headers as Headers).get('last-event-id') !== null)
                .length;

        // Issue the request WITH a resumption token: the transport resumes the
        // request's stream via GET + Last-Event-ID instead of POSTing it.
        let settled = false;
        const pending = client.ping({ timeout: 100, resumptionToken: 'evt-0' }).catch(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(50);
        expect(resumeGetCount()).toBeGreaterThan(0);
        expect(settled).toBe(false);

        // Cross the request timeout.
        await vi.advanceTimersByTimeAsync(100);
        await pending;
        expect(settled).toBe(true);

        // THE KEY ASSERTION: the cancellation actually reached the wire as a
        // POST — it was not swallowed into another GET resume. Note this is
        // best-effort on the SDK's own transport: the POST carries the
        // re-issued request's fresh JSON-RPC id, which never reached the
        // server here (the send itself short-circuited into a GET resume), so
        // the server cannot correlate it and a resumed request can only be
        // torn down locally (the requestSignal abort). The POST is kept
        // because custom per-request-stream transports that POST the
        // re-issued body normally DO give the server a correlatable id.
        expect(cancelledPosts).toHaveLength(1);

        // And no fresh (unguarded) reconnect chain was spawned by the
        // cancellation send: once the request settled, the resume GET count
        // stays flat.
        const resumesAtSettle = resumeGetCount();
        await vi.advanceTimersByTimeAsync(2000);
        expect(resumeGetCount()).toBe(resumesAtSettle);

        // The settlement abort landed on a deliberately-resumed request: a
        // clean teardown, so no error — spurious AbortError included — may
        // surface through client.onerror.
        expect(errors).toEqual([]);

        await client.close();
    });
});

/**
 * Regression for the Node 20.0-20.2 `anySignal` fallback: it removes its
 * listener pair only when one of its input signals fires, so composing a
 * FRESH transport+request signal per SSE reconnect leg strands one closure
 * pair per gracefully-completed leg on BOTH input signals until the request
 * settles (MaxListenersExceededWarning after ~11 polling cycles). The
 * composite must be built once per request chain and reused by every rebuilt
 * leg.
 */
describe('anySignal fallback (Node 20.0-20.2): reconnect legs reuse one composite per request chain', () => {
    const originalAny = AbortSignal.any;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(globalThis, 'fetch');
        // Simulate Node 20.0-20.2, where `AbortSignal.any` is unavailable and
        // the manual fallback combinator must be used.
        (AbortSignal as { any?: typeof AbortSignal.any }).any = undefined;
    });

    afterEach(() => {
        (AbortSignal as { any?: typeof AbortSignal.any }).any = originalAny;
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('does not accrue abort listeners on the request or transport signal across resume legs', async () => {
        const encoder = new TextEncoder();
        let eventSeq = 0;
        const fetchMock = globalThis.fetch as Mock;
        fetchMock.mockImplementation(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    // A priming event id, then a graceful close without a
                    // response: the documented SSE polling pattern — each leg
                    // completes with NEITHER input signal aborting.
                    controller.enqueue(encoder.encode(`id: evt-${++eventSeq}\ndata: \n\n`));
                    controller.close();
                }
            })
        }));

        const transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), {
            reconnectionOptions: {
                initialReconnectionDelay: 10,
                maxRetries: 2,
                maxReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1
            }
        });
        await transport.start();

        const requestAbort = new AbortController();
        await transport['_startOrAuthSse']({ resumptionToken: 'evt-0', requestSignal: requestAbort.signal });

        // Let the chain run several full polling cycles (stream close +
        // backoff + resume GET).
        for (let cycle = 0; cycle < 5; cycle++) {
            await vi.advanceTimersByTimeAsync(20);
        }
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);

        const transportSignal = transport['_abortController']!.signal;
        // One composite per request chain: exactly one fallback listener pair
        // total, no matter how many legs have completed. (Between legs the
        // pending attempt's settlement listener is also disarmed, so the
        // fallback's listener is the only one left on the request signal.)
        const requestListeners = getEventListeners(requestAbort.signal, 'abort');
        const transportListeners = getEventListeners(transportSignal, 'abort');
        expect(requestListeners.length).toBeLessThanOrEqual(2);
        expect(transportListeners.length).toBeLessThanOrEqual(2);

        await transport.close();
    });
});
