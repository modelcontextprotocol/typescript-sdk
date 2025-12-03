/**
 * Tests for FetchStreamableHTTPServerTransport
 *
 * These tests use native Web Standard Request/Response objects directly,
 * without spinning up HTTP servers. This makes tests faster and simpler.
 */

import {
    FetchStreamableHTTPServerTransport,
    EventStore,
    EventId,
    StreamId,
    SessionStore,
    SessionState
} from './fetchStreamableHttpServerTransport.js';
import { McpServer } from '../../server/mcp.js';
import { CallToolResult, JSONRPCMessage } from '../../types.js';
import { zodTestMatrix, type ZodMatrixEntry } from '../../__fixtures__/zodTestMatrix.js';

/**
 * Test transport configuration
 */
interface TestTransportConfig {
    sessionIdGenerator: (() => string) | undefined;
    enableJsonResponse?: boolean;
    eventStore?: EventStore;
    sessionStore?: SessionStore;
    onsessioninitialized?: (sessionId: string) => void | Promise<void>;
    onsessionclosed?: (sessionId: string) => void | Promise<void>;
    retryInterval?: number;
    allowedHosts?: string[];
    allowedOrigins?: string[];
    enableDnsRebindingProtection?: boolean;
}

/**
 * Common test messages
 */
const TEST_MESSAGES = {
    initialize: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
            clientInfo: { name: 'test-client', version: '1.0' },
            protocolVersion: '2025-03-26',
            capabilities: {}
        },
        id: 'init-1'
    } as JSONRPCMessage,

    toolsList: {
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 'tools-1'
    } as JSONRPCMessage
};

/**
 * Creates a POST request for the transport
 */
function createPostRequest(message: JSONRPCMessage | JSONRPCMessage[], sessionId?: string, extraHeaders?: Record<string, string>): Request {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Host: 'localhost:3000'
    };

    if (sessionId) {
        headers['mcp-session-id'] = sessionId;
        headers['mcp-protocol-version'] = '2025-03-26';
    }

    // Apply extraHeaders LAST to allow overriding defaults
    if (extraHeaders) {
        Object.assign(headers, extraHeaders);
    }

    return new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify(message)
    });
}

/**
 * Creates a GET request for SSE stream
 */
function createGetRequest(sessionId: string, extraHeaders?: Record<string, string>): Request {
    const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        Host: 'localhost:3000',
        'mcp-session-id': sessionId,
        ...extraHeaders
    };

    return new Request('http://localhost:3000/mcp', {
        method: 'GET',
        headers
    });
}

/**
 * Creates a DELETE request
 */
function createDeleteRequest(sessionId: string, extraHeaders?: Record<string, string>): Request {
    const headers: Record<string, string> = {
        Host: 'localhost:3000',
        'mcp-session-id': sessionId,
        ...extraHeaders
    };

    return new Request('http://localhost:3000/mcp', {
        method: 'DELETE',
        headers
    });
}

/**
 * Helper to read first SSE event from response
 */
async function readSSEEvent(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const { value } = await reader.read();
    return new TextDecoder().decode(value);
}

/**
 * Helper to read all SSE events from response until done
 */
async function readAllSSEEvents(response: Response): Promise<string[]> {
    const reader = response.body?.getReader();
    if (!reader) return [];

    const events: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value, { stream: true }));
    }

    return events;
}

function expectErrorResponse(data: unknown, expectedCode: number, expectedMessagePattern: RegExp): void {
    expect(data).toMatchObject({
        jsonrpc: '2.0',
        error: expect.objectContaining({
            code: expectedCode,
            message: expect.stringMatching(expectedMessagePattern)
        })
    });
}

describe.each(zodTestMatrix)('$zodVersionLabel', (entry: ZodMatrixEntry) => {
    const { z } = entry;

    /**
     * Helper to create transport with connected MCP server
     */
    async function createTestTransport(config: TestTransportConfig = { sessionIdGenerator: () => crypto.randomUUID() }): Promise<{
        transport: FetchStreamableHTTPServerTransport;
        mcpServer: McpServer;
    }> {
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

        mcpServer.tool(
            'greet',
            'A simple greeting tool',
            { name: z.string().describe('Name to greet') },
            async ({ name }): Promise<CallToolResult> => {
                return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
            }
        );

        const transport = new FetchStreamableHTTPServerTransport({
            sessionIdGenerator: config.sessionIdGenerator,
            enableJsonResponse: config.enableJsonResponse ?? false,
            eventStore: config.eventStore,
            sessionStore: config.sessionStore,
            onsessioninitialized: config.onsessioninitialized,
            onsessionclosed: config.onsessionclosed,
            retryInterval: config.retryInterval,
            allowedHosts: config.allowedHosts,
            allowedOrigins: config.allowedOrigins,
            enableDnsRebindingProtection: config.enableDnsRebindingProtection
        });

        await mcpServer.connect(transport);

        return { transport, mcpServer };
    }

    describe('FetchStreamableHTTPServerTransport', () => {
        let mcpServer: McpServer;
        let transport: FetchStreamableHTTPServerTransport;
        let sessionId: string;

        beforeEach(async () => {
            const result = await createTestTransport();
            transport = result.transport;
            mcpServer = result.mcpServer;
        });

        afterEach(async () => {
            await transport.close();
        });

        async function initializeSession(): Promise<string> {
            const request = createPostRequest(TEST_MESSAGES.initialize);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            const newSessionId = response.headers.get('mcp-session-id');
            expect(newSessionId).toBeDefined();
            return newSessionId as string;
        }

        it('should initialize server and generate session ID', async () => {
            sessionId = await initializeSession();
            expect(sessionId).toBeDefined();
        });

        it('should reject second initialization request', async () => {
            sessionId = await initializeSession();

            // Try to initialize again
            const request = createPostRequest(TEST_MESSAGES.initialize, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(400);
            const body = await response.json();
            expect(body.error.message).toContain('already initialized');
        });

        it('should reject batch initialize request', async () => {
            const request = createPostRequest([TEST_MESSAGES.initialize, TEST_MESSAGES.toolsList]);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(400);
            const body = await response.json();
            expect(body.error.message).toContain('Only one initialization request');
        });

        it('should handle post requests via sse response correctly', async () => {
            sessionId = await initializeSession();

            const request = createPostRequest(TEST_MESSAGES.toolsList, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');

            const text = await readSSEEvent(response);
            expect(text).toContain('data:');
            expect(text).toContain('"tools"');
        });

        it('should call a tool and return the result', async () => {
            sessionId = await initializeSession();

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'World' }
                },
                id: 'call-1'
            };

            const request = createPostRequest(toolCallMessage, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.substring(5));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: {
                    content: [
                        {
                            type: 'text',
                            text: 'Hello, World!'
                        }
                    ]
                },
                id: 'call-1'
            });
        });

        it('should pass request info to tool callback', async () => {
            // Create a new transport with a tool that captures request info
            let capturedHeaders: Record<string, string | string[] | undefined> | undefined;

            const customMcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });
            customMcpServer.tool(
                'capture-headers',
                'Captures request headers',
                {},
                async (_args, { requestInfo }): Promise<CallToolResult> => {
                    capturedHeaders = requestInfo?.headers;
                    return { content: [{ type: 'text', text: 'captured' }] };
                }
            );

            const customTransport = new FetchStreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID()
            });
            await customMcpServer.connect(customTransport);

            // Initialize
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await customTransport.handleRequest(initRequest);
            const customSessionId = initResponse.headers.get('mcp-session-id')!;

            // Call the tool with custom headers
            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'capture-headers', arguments: {} },
                id: 'call-1'
            };

            const request = createPostRequest(toolCallMessage, customSessionId, { 'x-custom-header': 'test-value' });
            const response = await customTransport.handleRequest(request);

            // Wait for the tool to execute by reading the SSE response
            await readSSEEvent(response);

            expect(capturedHeaders).toBeDefined();
            expect(capturedHeaders!['x-custom-header']).toBe('test-value');

            await customTransport.close();
        });

        it('should reject requests without a valid session ID', async () => {
            sessionId = await initializeSession();

            // Make request without session ID
            const request = createPostRequest(TEST_MESSAGES.toolsList);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(400);
            const body = await response.json();
            expect(body.error.message).toContain('Mcp-Session-Id header is required');
        });

        it('should reject invalid session ID', async () => {
            sessionId = await initializeSession();

            const request = createPostRequest(TEST_MESSAGES.toolsList, 'invalid-session-id');
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(404);
            const body = await response.json();
            expect(body.error.message).toBe('Session not found');
        });

        it('should establish standalone SSE stream and receive server-initiated messages', async () => {
            sessionId = await initializeSession();

            const request = createGetRequest(sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');
        });

        it('should not close GET SSE stream after sending multiple server notifications', async () => {
            sessionId = await initializeSession();

            const request = createGetRequest(sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');

            // Send multiple notifications
            await mcpServer.sendLoggingMessage({ level: 'info', data: 'test1' });
            await mcpServer.sendLoggingMessage({ level: 'info', data: 'test2' });

            // Stream should still be open (readable)
            expect(response.body).not.toBeNull();
        });

        it('should reject second SSE stream for the same session', async () => {
            sessionId = await initializeSession();

            // First SSE stream
            const request1 = createGetRequest(sessionId);
            const response1 = await transport.handleRequest(request1);
            expect(response1.status).toBe(200);

            // Second SSE stream should fail
            const request2 = createGetRequest(sessionId);
            const response2 = await transport.handleRequest(request2);
            expect(response2.status).toBe(409);
        });

        it('should reject GET requests without Accept: text/event-stream header', async () => {
            sessionId = await initializeSession();

            const request = new Request('http://localhost:3000/mcp', {
                method: 'GET',
                headers: {
                    Host: 'localhost:3000',
                    'mcp-session-id': sessionId,
                    Accept: 'application/json'
                }
            });

            const response = await transport.handleRequest(request);
            expect(response.status).toBe(406);
        });

        it('should reject POST requests without proper Accept header', async () => {
            const request = new Request('http://localhost:3000/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Host: 'localhost:3000',
                    Accept: 'application/json' // Missing text/event-stream
                },
                body: JSON.stringify(TEST_MESSAGES.initialize)
            });

            const response = await transport.handleRequest(request);
            expect(response.status).toBe(406);
        });

        it('should reject unsupported Content-Type', async () => {
            const request = new Request('http://localhost:3000/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    Host: 'localhost:3000',
                    Accept: 'application/json, text/event-stream'
                },
                body: 'not json'
            });

            const response = await transport.handleRequest(request);
            expect(response.status).toBe(415);
        });

        it('should handle JSON-RPC batch notification messages with 202 response', async () => {
            sessionId = await initializeSession();

            const notifications: JSONRPCMessage[] = [
                { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '1', reason: 'test' } },
                { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '2', reason: 'test' } }
            ];

            const request = createPostRequest(notifications, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(202);
        });

        it('should handle batch request messages with SSE stream for responses', async () => {
            sessionId = await initializeSession();

            const batch: JSONRPCMessage[] = [
                { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'batch-1' },
                { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'batch-2' }
            ];

            const request = createPostRequest(batch, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');
        });

        it('should properly handle invalid JSON data', async () => {
            const request = new Request('http://localhost:3000/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Host: 'localhost:3000',
                    Accept: 'application/json, text/event-stream'
                },
                body: 'not valid json'
            });

            const response = await transport.handleRequest(request);
            expect(response.status).toBe(400);

            const body = await response.json();
            expect(body.error.message).toContain('Parse error');
        });

        it('should return 400 error for invalid JSON-RPC messages', async () => {
            const request = new Request('http://localhost:3000/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Host: 'localhost:3000',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({ invalid: 'message' })
            });

            const response = await transport.handleRequest(request);
            expect(response.status).toBe(400);
        });

        it('should reject requests to uninitialized server', async () => {
            // Create fresh transport without initializing
            const { transport: freshTransport } = await createTestTransport();

            const request = createPostRequest(TEST_MESSAGES.toolsList, 'some-session-id');
            const response = await freshTransport.handleRequest(request);

            // Server returns 400 when not initialized (in-memory mode without sessionStore)
            expect(response.status).toBe(400);
            const body = await response.json();
            expect(body.error.message).toContain('Server not initialized');
            await freshTransport.close();
        });

        it('should send response messages to the connection that sent the request', async () => {
            sessionId = await initializeSession();

            const request = createPostRequest(TEST_MESSAGES.toolsList, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            expect(text).toContain('"tools"');
        });

        it('should keep stream open after sending server notifications', async () => {
            sessionId = await initializeSession();

            const request = createGetRequest(sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);

            // Send a notification
            await mcpServer.sendLoggingMessage({ level: 'info', data: 'test notification' });

            // Stream should still be readable
            expect(response.body?.locked).toBe(false);
        });

        it('should properly handle DELETE requests and close session', async () => {
            sessionId = await initializeSession();

            const request = createDeleteRequest(sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
        });

        it('should reject DELETE requests with invalid session ID', async () => {
            sessionId = await initializeSession();

            const request = createDeleteRequest('invalid-session-id');
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(404);
        });

        describe('protocol version header validation', () => {
            it('should accept requests with matching protocol version', async () => {
                sessionId = await initializeSession();

                const request = createPostRequest(TEST_MESSAGES.toolsList, sessionId, {
                    'mcp-protocol-version': '2025-03-26'
                });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(200);
            });

            it('should accept requests without protocol version header', async () => {
                sessionId = await initializeSession();

                // Create request without mcp-protocol-version header
                const request = new Request('http://localhost:3000/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'localhost:3000',
                        'mcp-session-id': sessionId
                    },
                    body: JSON.stringify(TEST_MESSAGES.toolsList)
                });

                const response = await transport.handleRequest(request);
                expect(response.status).toBe(200);
            });

            it('should reject requests with unsupported protocol version', async () => {
                sessionId = await initializeSession();

                const request = createPostRequest(TEST_MESSAGES.toolsList, sessionId, {
                    'mcp-protocol-version': '9999-99-99'
                });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(400);
                const body = await response.json();
                expectErrorResponse(body, -32000, /Unsupported protocol version/);
            });

            it('should accept when protocol version differs from negotiated version', async () => {
                sessionId = await initializeSession();

                // Use a different but supported version
                const request = createPostRequest(TEST_MESSAGES.toolsList, sessionId, {
                    'mcp-protocol-version': '2024-11-05'
                });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(200);
            });

            it('should handle protocol version validation for GET requests', async () => {
                sessionId = await initializeSession();

                const request = new Request('http://localhost:3000/mcp', {
                    method: 'GET',
                    headers: {
                        Accept: 'text/event-stream',
                        Host: 'localhost:3000',
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': '9999-99-99'
                    }
                });

                const response = await transport.handleRequest(request);
                expect(response.status).toBe(400);
            });

            it('should handle protocol version validation for DELETE requests', async () => {
                sessionId = await initializeSession();

                const request = new Request('http://localhost:3000/mcp', {
                    method: 'DELETE',
                    headers: {
                        Host: 'localhost:3000',
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': '9999-99-99'
                    }
                });

                const response = await transport.handleRequest(request);
                expect(response.status).toBe(400);
            });
        });
    });

    // Test JSON Response Mode
    describe('FetchStreamableHTTPServerTransport with JSON Response Mode', () => {
        let transport: FetchStreamableHTTPServerTransport;
        let sessionId: string;

        beforeEach(async () => {
            const result = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                enableJsonResponse: true
            });
            transport = result.transport;

            // Initialize and get session ID
            const request = createPostRequest(TEST_MESSAGES.initialize);
            const response = await transport.handleRequest(request);
            sessionId = response.headers.get('mcp-session-id')!;
        });

        afterEach(async () => {
            await transport.close();
        });

        it('should return JSON response for a single request', async () => {
            const request = createPostRequest(TEST_MESSAGES.toolsList, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/json');

            const body = await response.json();
            expect(body).toMatchObject({
                jsonrpc: '2.0',
                result: { tools: expect.any(Array) },
                id: 'tools-1'
            });
        });

        it('should return JSON response for batch requests', async () => {
            const batch: JSONRPCMessage[] = [
                { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'batch-1' },
                { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'batch-2' }
            ];

            const request = createPostRequest(batch, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/json');

            const body = await response.json();
            expect(Array.isArray(body)).toBe(true);
            expect(body).toHaveLength(2);
        });
    });

    // Test stateless mode
    describe('FetchStreamableHTTPServerTransport in stateless mode', () => {
        let transport: FetchStreamableHTTPServerTransport;

        beforeEach(async () => {
            const result = await createTestTransport({ sessionIdGenerator: undefined });
            transport = result.transport;
        });

        afterEach(async () => {
            await transport.close();
        });

        it('should operate without session ID validation', async () => {
            // Initialize without session ID generator
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);

            expect(initResponse.status).toBe(200);
            expect(initResponse.headers.get('mcp-session-id')).toBeNull();

            // Subsequent requests should work without session ID
            const request = createPostRequest(TEST_MESSAGES.toolsList);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
        });

        it('should handle POST requests with various session IDs in stateless mode', async () => {
            // Initialize
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            await transport.handleRequest(initRequest);

            // Request with random session ID should work
            const request = createPostRequest(TEST_MESSAGES.toolsList, 'any-random-id');
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
        });

        it('should reject second SSE stream even in stateless mode', async () => {
            // Initialize
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            await transport.handleRequest(initRequest);

            // First SSE stream
            const request1 = createGetRequest('any-session');
            const response1 = await transport.handleRequest(request1);
            expect(response1.status).toBe(200);

            // Second SSE stream should still fail (transport limitation)
            const request2 = createGetRequest('any-session');
            const response2 = await transport.handleRequest(request2);
            expect(response2.status).toBe(409);
        });
    });

    // Test resumability with EventStore
    describe('FetchStreamableHTTPServerTransport with resumability', () => {
        let transport: FetchStreamableHTTPServerTransport;
        let mcpServer: McpServer;
        let eventStore: EventStore;
        let sessionId: string;

        beforeEach(async () => {
            // Create a simple in-memory event store
            const storedEvents = new Map<StreamId, Array<{ id: EventId; message: JSONRPCMessage }>>();

            eventStore = {
                storeEvent: async (streamId: StreamId, message: JSONRPCMessage): Promise<EventId> => {
                    const events = storedEvents.get(streamId) || [];
                    const eventId = `event-${events.length + 1}` as EventId;
                    events.push({ id: eventId, message });
                    storedEvents.set(streamId, events);
                    return eventId;
                },
                replayEventsAfter: async (lastEventId: EventId, { send }): Promise<StreamId> => {
                    // Find the stream that has this eventId
                    for (const [streamId, events] of storedEvents) {
                        let replay = false;
                        for (const event of events) {
                            if (replay) {
                                await send(event.id, event.message);
                            }
                            if (event.id === lastEventId) {
                                replay = true;
                            }
                        }
                        if (replay) {
                            return streamId;
                        }
                    }
                    return 'unknown-stream' as StreamId;
                }
            };

            const result = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                eventStore
            });
            transport = result.transport;
            mcpServer = result.mcpServer;

            // Initialize
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            sessionId = initResponse.headers.get('mcp-session-id')!;
        });

        afterEach(async () => {
            await transport.close();
        });

        it('should store and include event IDs in server SSE messages', async () => {
            const request = createPostRequest(TEST_MESSAGES.toolsList, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            // Should have an id: line for the event
            expect(text).toMatch(/id:/);
        });

        it('should store and replay MCP server tool notifications', async () => {
            // Open SSE stream
            const sseRequest = createGetRequest(sessionId);
            const sseResponse = await transport.handleRequest(sseRequest);
            expect(sseResponse.status).toBe(200);

            // Send a notification
            await mcpServer.sendLoggingMessage({ level: 'info', data: 'test notification' });

            // The event should be stored - we can verify by checking the stream has data
            const reader = sseResponse.body?.getReader();
            if (reader) {
                const { value } = await reader.read();
                const text = new TextDecoder().decode(value);
                expect(text).toContain('id:');
            }
        });
    });

    // Test POST SSE priming events
    describe('FetchStreamableHTTPServerTransport POST SSE priming events', () => {
        it('should send priming event with retry field on POST SSE stream', async () => {
            // Priming events require an eventStore to be configured
            const eventStore: EventStore = {
                storeEvent: async () => 'event-1' as EventId,
                replayEventsAfter: async () => 'stream-1' as StreamId
            };

            const { transport } = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                retryInterval: 5000,
                eventStore
            });

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            const request = createPostRequest(TEST_MESSAGES.toolsList, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            expect(text).toContain('retry: 5000');

            await transport.close();
        });

        it('should send priming event without retry field when retryInterval is not configured', async () => {
            const { transport } = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID()
            });

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            const request = createPostRequest(TEST_MESSAGES.toolsList, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            expect(text).not.toContain('retry:');

            await transport.close();
        });

        it('should close POST SSE stream when extra.closeSSEStream is called', async () => {
            // Create a simple event store to enable closeSSEStream
            const eventStore: EventStore = {
                storeEvent: async () => 'event-1' as EventId,
                replayEventsAfter: async () => 'stream-1' as StreamId
            };

            const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

            mcpServer.tool('close-stream', 'Closes the SSE stream', {}, async (_args, extra): Promise<CallToolResult> => {
                // Call closeSSEStream after a short delay
                setTimeout(() => {
                    extra.closeSSEStream?.();
                }, 50);
                return { content: [{ type: 'text', text: 'closing' }] };
            });

            const transport = new FetchStreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                eventStore
            });
            await mcpServer.connect(transport);

            // Initialize
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            // Call the tool
            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'close-stream', arguments: {} },
                id: 'call-1'
            };

            const request = createPostRequest(toolCallMessage, sessionId);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);

            // Wait for close to be called and stream to end
            await new Promise(resolve => setTimeout(resolve, 100));

            await transport.close();
        });

        it('should provide closeSSEStream callback in extra when eventStore is configured', async () => {
            const eventStore: EventStore = {
                storeEvent: async () => 'event-1' as EventId,
                replayEventsAfter: async () => 'stream-1' as StreamId
            };

            const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

            let hasCloseSSEStream = false;

            mcpServer.tool('check-callback', 'Checks for closeSSEStream callback', {}, async (_args, extra): Promise<CallToolResult> => {
                hasCloseSSEStream = typeof extra.closeSSEStream === 'function';
                return { content: [{ type: 'text', text: 'checked' }] };
            });

            const transport = new FetchStreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                eventStore
            });
            await mcpServer.connect(transport);

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'check-callback', arguments: {} },
                id: 'call-1'
            };

            const request = createPostRequest(toolCallMessage, sessionId);
            const response = await transport.handleRequest(request);

            // Wait for the tool to execute by reading all SSE events
            // (with eventStore, a priming event is sent first, then the tool response)
            await readAllSSEEvents(response);

            expect(hasCloseSSEStream).toBe(true);

            await transport.close();
        });

        it('should NOT provide closeSSEStream callback when eventStore is NOT configured', async () => {
            const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

            let hasCloseSSEStream = false;

            mcpServer.tool('check-callback', 'Checks for closeSSEStream callback', {}, async (_args, extra): Promise<CallToolResult> => {
                hasCloseSSEStream = typeof extra.closeSSEStream === 'function';
                return { content: [{ type: 'text', text: 'checked' }] };
            });

            const transport = new FetchStreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID()
                // No eventStore
            });
            await mcpServer.connect(transport);

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'check-callback', arguments: {} },
                id: 'call-1'
            };

            const request = createPostRequest(toolCallMessage, sessionId);
            await transport.handleRequest(request);

            expect(hasCloseSSEStream).toBe(false);

            await transport.close();
        });
    });

    // Test onsessionclosed callback
    describe('FetchStreamableHTTPServerTransport onsessionclosed callback', () => {
        it('should call onsessionclosed callback when session is closed via DELETE', async () => {
            let closedSessionId: string | undefined;

            const { transport } = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessionclosed: id => {
                    closedSessionId = id;
                }
            });

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            const deleteRequest = createDeleteRequest(sessionId);
            await transport.handleRequest(deleteRequest);

            expect(closedSessionId).toBe(sessionId);

            await transport.close();
        });

        it('should not call onsessionclosed callback when not provided', async () => {
            const { transport } = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID()
            });

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            const deleteRequest = createDeleteRequest(sessionId);
            const response = await transport.handleRequest(deleteRequest);

            expect(response.status).toBe(200);

            await transport.close();
        });

        it('should not call onsessionclosed callback for invalid session DELETE', async () => {
            let callbackCalled = false;

            const { transport } = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessionclosed: () => {
                    callbackCalled = true;
                }
            });

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            await transport.handleRequest(initRequest);

            const deleteRequest = createDeleteRequest('invalid-session');
            await transport.handleRequest(deleteRequest);

            expect(callbackCalled).toBe(false);

            await transport.close();
        });
    });

    // Test async callbacks
    describe('FetchStreamableHTTPServerTransport async callbacks', () => {
        it('should support async onsessioninitialized callback', async () => {
            let initializedSessionId: string | undefined;

            const { transport } = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: async id => {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    initializedSessionId = id;
                }
            });

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            expect(initializedSessionId).toBe(sessionId);

            await transport.close();
        });

        it('should support sync onsessioninitialized callback (backwards compatibility)', async () => {
            let initializedSessionId: string | undefined;

            const { transport } = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: id => {
                    initializedSessionId = id;
                }
            });

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            expect(initializedSessionId).toBe(sessionId);

            await transport.close();
        });

        it('should support async onsessionclosed callback', async () => {
            let closedSessionId: string | undefined;

            const { transport } = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessionclosed: async id => {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    closedSessionId = id;
                }
            });

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            const deleteRequest = createDeleteRequest(sessionId);
            await transport.handleRequest(deleteRequest);

            expect(closedSessionId).toBe(sessionId);

            await transport.close();
        });
    });

    // Test DNS rebinding protection
    describe('FetchStreamableHTTPServerTransport DNS rebinding protection', () => {
        describe('Host header validation', () => {
            it('should accept requests with allowed host headers', async () => {
                const { transport } = await createTestTransport({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['localhost:3000'],
                    enableDnsRebindingProtection: true
                });

                const request = new Request('http://localhost:3000/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'localhost:3000'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                const response = await transport.handleRequest(request);
                expect(response.status).toBe(200);

                await transport.close();
            });

            it('should reject requests with disallowed host headers', async () => {
                const { transport } = await createTestTransport({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['localhost:3000'],
                    enableDnsRebindingProtection: true
                });

                const request = new Request('http://evil.com/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                const response = await transport.handleRequest(request);
                expect(response.status).toBe(403);

                const body = await response.json();
                expect(body.error.message).toContain('Invalid Host header');

                await transport.close();
            });

            it('should reject GET requests with disallowed host headers', async () => {
                const { transport } = await createTestTransport({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['localhost:3000'],
                    enableDnsRebindingProtection: true
                });

                // First initialize
                const initRequest = new Request('http://localhost:3000/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'localhost:3000'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });
                await transport.handleRequest(initRequest);

                // Then try GET with evil host
                const request = new Request('http://evil.com/mcp', {
                    method: 'GET',
                    headers: {
                        Accept: 'text/event-stream',
                        Host: 'evil.com'
                    }
                });

                const response = await transport.handleRequest(request);
                expect(response.status).toBe(403);

                await transport.close();
            });
        });

        describe('Origin header validation', () => {
            it('should accept requests with allowed origin headers', async () => {
                const { transport } = await createTestTransport({
                    sessionIdGenerator: undefined,
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: true
                });

                const request = new Request('http://localhost:3000/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'localhost:3000',
                        Origin: 'http://localhost:3000'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                const response = await transport.handleRequest(request);
                expect(response.status).toBe(200);

                await transport.close();
            });

            it('should reject requests with disallowed origin headers', async () => {
                const { transport } = await createTestTransport({
                    sessionIdGenerator: undefined,
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: true
                });

                const request = new Request('http://localhost:3000/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'localhost:3000',
                        Origin: 'http://evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                const response = await transport.handleRequest(request);
                expect(response.status).toBe(403);

                const body = await response.json();
                expect(body.error.message).toContain('Invalid Origin header');

                await transport.close();
            });
        });

        describe('enableDnsRebindingProtection option', () => {
            it('should skip all validations when enableDnsRebindingProtection is false', async () => {
                const { transport } = await createTestTransport({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['localhost:3000'],
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: false
                });

                const request = new Request('http://evil.com/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'evil.com',
                        Origin: 'http://evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                const response = await transport.handleRequest(request);
                expect(response.status).toBe(200);

                await transport.close();
            });
        });

        describe('Combined validations', () => {
            it('should validate both host and origin when both are configured', async () => {
                const { transport } = await createTestTransport({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['localhost:3000'],
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: true
                });

                // Test with invalid origin
                const request1 = new Request('http://localhost:3000/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'localhost:3000',
                        Origin: 'http://evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                const response1 = await transport.handleRequest(request1);
                expect(response1.status).toBe(403);
                const body1 = await response1.json();
                expect(body1.error.message).toBe('Invalid Origin header: http://evil.com');

                // Test with valid origin
                const request2 = new Request('http://localhost:3000/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'localhost:3000',
                        Origin: 'http://localhost:3000'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                const response2 = await transport.handleRequest(request2);
                expect(response2.status).toBe(200);

                await transport.close();
            });
        });
    });

    /**
     * Tests for SessionStore functionality (distributed/serverless mode)
     */
    describe('FetchStreamableHTTPServerTransport with SessionStore', () => {
        /**
         * Creates an in-memory session store for testing
         */
        function createInMemorySessionStore(): SessionStore & { sessions: Map<string, SessionState> } {
            const sessions = new Map<string, SessionState>();
            return {
                sessions,
                get: async (sessionId: string) => sessions.get(sessionId),
                save: async (sessionId: string, state: SessionState) => {
                    sessions.set(sessionId, state);
                },
                delete: async (sessionId: string) => {
                    sessions.delete(sessionId);
                }
            };
        }

        it('should save session state to store on initialization', async () => {
            const sessionStore = createInMemorySessionStore();
            const { transport } = await createTestTransport({
                sessionIdGenerator: () => 'test-session-123',
                sessionStore
            });

            const request = createPostRequest(TEST_MESSAGES.initialize);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);

            // Verify session was saved to store
            const savedSession = await sessionStore.get('test-session-123');
            expect(savedSession).toBeDefined();
            expect(savedSession?.initialized).toBe(true);
            expect(savedSession?.protocolVersion).toBeDefined();
            expect(savedSession?.createdAt).toBeGreaterThan(0);

            await transport.close();
        });

        it('should validate session from store for subsequent requests', async () => {
            const sessionStore = createInMemorySessionStore();
            const { transport } = await createTestTransport({
                sessionIdGenerator: () => 'test-session-456',
                sessionStore
            });

            // Initialize the session
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            expect(initResponse.status).toBe(200);
            const sessionId = initResponse.headers.get('mcp-session-id');

            // Make a subsequent request with valid session ID
            const listRequest = createPostRequest(TEST_MESSAGES.toolsList, sessionId!);
            const listResponse = await transport.handleRequest(listRequest);
            expect(listResponse.status).toBe(200);

            await transport.close();
        });

        it('should reject requests with invalid session ID when using session store', async () => {
            const sessionStore = createInMemorySessionStore();
            const { transport } = await createTestTransport({
                sessionIdGenerator: () => 'test-session-789',
                sessionStore
            });

            // Initialize the session first
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            expect(initResponse.status).toBe(200);

            // Try to make a request with invalid session ID
            const request = createPostRequest(TEST_MESSAGES.toolsList, 'invalid-session-id');
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(404);
            const body = await response.json();
            expect(body.error.message).toBe('Session not found');

            await transport.close();
        });

        it('should delete session from store on DELETE request', async () => {
            const sessionStore = createInMemorySessionStore();
            const { transport } = await createTestTransport({
                sessionIdGenerator: () => 'test-session-delete',
                sessionStore
            });

            // Initialize the session
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            expect(initResponse.status).toBe(200);
            const sessionId = initResponse.headers.get('mcp-session-id');

            // Verify session exists in store
            expect(await sessionStore.get(sessionId!)).toBeDefined();

            // Delete the session
            const deleteRequest = createDeleteRequest(sessionId!);
            const deleteResponse = await transport.handleRequest(deleteRequest);
            expect(deleteResponse.status).toBe(200);

            // Verify session was deleted from store
            expect(await sessionStore.get(sessionId!)).toBeUndefined();

            await transport.close();
        });

        it('should allow new transport instances to validate existing sessions (serverless mode)', async () => {
            // This test simulates serverless behavior where each request
            // is handled by a fresh transport instance
            const sessionStore = createInMemorySessionStore();

            // First, initialize using one transport instance
            const { transport: transport1 } = await createTestTransport({
                sessionIdGenerator: () => 'serverless-session-123',
                sessionStore
            });

            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport1.handleRequest(initRequest);
            expect(initResponse.status).toBe(200);
            const sessionId = initResponse.headers.get('mcp-session-id');

            // Close the first transport
            await transport1.close();

            // Create a NEW transport instance with same sessionStore (simulates new serverless invocation)
            const { transport: transport2 } = await createTestTransport({
                sessionIdGenerator: () => crypto.randomUUID(), // Different generator, doesn't matter
                sessionStore // Same session store
            });

            // The new transport should be able to validate the existing session from the store
            const listRequest = createPostRequest(TEST_MESSAGES.toolsList, sessionId!);
            const listResponse = await transport2.handleRequest(listRequest);

            expect(listResponse.status).toBe(200);

            await transport2.close();
        });

        it('should work with GET SSE stream when session is hydrated from store', async () => {
            const sessionStore = createInMemorySessionStore();
            const { transport } = await createTestTransport({
                sessionIdGenerator: () => 'sse-session-123',
                sessionStore
            });

            // Initialize session
            const initRequest = createPostRequest(TEST_MESSAGES.initialize);
            const initResponse = await transport.handleRequest(initRequest);
            expect(initResponse.status).toBe(200);
            const sessionId = initResponse.headers.get('mcp-session-id');

            // Open SSE stream with session ID
            const sseRequest = createGetRequest(sessionId!);
            const sseResponse = await transport.handleRequest(sseRequest);

            expect(sseResponse.status).toBe(200);
            expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');

            await transport.close();
        });
    });
});
