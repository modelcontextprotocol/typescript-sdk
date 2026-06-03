import { randomUUID } from 'node:crypto';

import type { CallToolResult, JSONRPCErrorResponse, JSONRPCMessage } from '@modelcontextprotocol/core';
import { DRAFT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/core';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp.js';
import type { EventId, EventStore, StreamId } from '../../src/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp.js';

/**
 * Common test messages
 */
const TEST_MESSAGES = {
    initialize: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
            clientInfo: { name: 'test-client', version: '1.0' },
            protocolVersion: '2025-11-25',
            capabilities: {}
        },
        id: 'init-1'
    } as JSONRPCMessage,

    initializeOldVersion: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
            clientInfo: { name: 'test-client', version: '1.0' },
            protocolVersion: '2025-06-18',
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
 * Helper to create a Web Standard Request
 */
function createRequest(
    method: string,
    body?: JSONRPCMessage | JSONRPCMessage[],
    options?: {
        sessionId?: string;
        accept?: string;
        contentType?: string;
        extraHeaders?: Record<string, string>;
    }
): Request {
    const headers: Record<string, string> = {};

    if (options?.accept) {
        headers['Accept'] = options.accept;
    } else if (method === 'POST') {
        headers['Accept'] = 'application/json, text/event-stream';
    } else if (method === 'GET') {
        headers['Accept'] = 'text/event-stream';
    }

    if (options?.contentType) {
        headers['Content-Type'] = options.contentType;
    } else if (body) {
        headers['Content-Type'] = 'application/json';
    }

    if (options?.sessionId) {
        headers['mcp-session-id'] = options.sessionId;
        headers['mcp-protocol-version'] = '2025-11-25';
    }

    if (options?.extraHeaders) {
        Object.assign(headers, options.extraHeaders);
    }

    return new Request('http://localhost/mcp', {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
}

/**
 * Helper to extract text from SSE response
 */
async function readSSEEvent(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    const { value } = await reader!.read();
    return new TextDecoder().decode(value);
}

/**
 * Helper to parse SSE data line
 */
function parseSSEData(text: string): unknown {
    const eventLines = text.split('\n');
    const dataLine = eventLines.find(line => line.startsWith('data:'));
    if (!dataLine) {
        throw new Error('No data line found in SSE event');
    }
    return JSON.parse(dataLine.slice(5).trim());
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

describe('Zod v4', () => {
    describe('HTTPServerTransport', () => {
        let transport: WebStandardStreamableHTTPServerTransport;
        let mcpServer: McpServer;
        let sessionId: string;

        beforeEach(async () => {
            mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

            mcpServer.registerTool(
                'greet',
                {
                    description: 'A simple greeting tool',
                    inputSchema: z.object({ name: z.string().describe('Name to greet') })
                },
                async ({ name }): Promise<CallToolResult> => {
                    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
                }
            );

            transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID()
            });

            await mcpServer.connect(transport);
        });

        afterEach(async () => {
            await transport.close();
        });

        async function initializeServer(): Promise<string> {
            const request = createRequest('POST', TEST_MESSAGES.initialize);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            const newSessionId = response.headers.get('mcp-session-id');
            expect(newSessionId).toBeDefined();
            return newSessionId as string;
        }

        describe('Initialization', () => {
            it('should initialize server and generate session ID', async () => {
                const request = createRequest('POST', TEST_MESSAGES.initialize);
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(200);
                expect(response.headers.get('content-type')).toBe('text/event-stream');
                expect(response.headers.get('mcp-session-id')).toBeDefined();
            });

            it('should reject second initialization request', async () => {
                sessionId = await initializeServer();
                expect(sessionId).toBeDefined();

                const secondInitMessage = {
                    ...TEST_MESSAGES.initialize,
                    id: 'second-init'
                };

                const request = createRequest('POST', secondInitMessage);
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(400);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_600, /Server already initialized/);
            });

            it('should reject batch initialize request', async () => {
                const batchInitMessages: JSONRPCMessage[] = [
                    TEST_MESSAGES.initialize,
                    {
                        jsonrpc: '2.0',
                        method: 'initialize',
                        params: {
                            clientInfo: { name: 'test-client-2', version: '1.0' },
                            protocolVersion: '2025-03-26'
                        },
                        id: 'init-2'
                    }
                ];

                const request = createRequest('POST', batchInitMessages);
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(400);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_600, /Only one initialization request is allowed/);
            });
        });

        describe('POST Requests', () => {
            it('should handle post requests via SSE response correctly', async () => {
                sessionId = await initializeServer();

                const request = createRequest('POST', TEST_MESSAGES.toolsList, { sessionId });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(200);

                const text = await readSSEEvent(response);
                const eventData = parseSSEData(text);

                expect(eventData).toMatchObject({
                    jsonrpc: '2.0',
                    result: expect.objectContaining({
                        tools: expect.arrayContaining([
                            expect.objectContaining({
                                name: 'greet',
                                description: 'A simple greeting tool'
                            })
                        ])
                    }),
                    id: 'tools-1'
                });
            });

            it('should call a tool and return the result', async () => {
                sessionId = await initializeServer();

                const toolCallMessage: JSONRPCMessage = {
                    jsonrpc: '2.0',
                    method: 'tools/call',
                    params: {
                        name: 'greet',
                        arguments: {
                            name: 'Test User'
                        }
                    },
                    id: 'call-1'
                };

                const request = createRequest('POST', toolCallMessage, { sessionId });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(200);

                const text = await readSSEEvent(response);
                const eventData = parseSSEData(text);

                expect(eventData).toMatchObject({
                    jsonrpc: '2.0',
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: 'Hello, Test User!'
                            }
                        ]
                    },
                    id: 'call-1'
                });
            });

            it('should reject requests without a valid session ID', async () => {
                const request = createRequest('POST', TEST_MESSAGES.toolsList);
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(400);
                const errorData = (await response.json()) as JSONRPCErrorResponse;
                expectErrorResponse(errorData, -32_000, /Bad Request/);
                expect(errorData.id).toBeNull();
            });

            it('should reject invalid session ID', async () => {
                await initializeServer();

                const request = createRequest('POST', TEST_MESSAGES.toolsList, { sessionId: 'invalid-session-id' });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(404);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_001, /Session not found/);
            });

            it('should reject request with wrong Accept header', async () => {
                const request = createRequest('POST', TEST_MESSAGES.initialize, { accept: 'application/json' });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(406);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_000, /Not Acceptable/);
            });

            it('should reject request with wrong Content-Type header', async () => {
                const request = new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        Accept: 'application/json, text/event-stream',
                        'Content-Type': 'text/plain'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(415);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_000, /Unsupported Media Type/);
            });

            it('should reject invalid JSON', async () => {
                const request = new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        Accept: 'application/json, text/event-stream',
                        'Content-Type': 'application/json'
                    },
                    body: 'not valid json'
                });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(400);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_700, /Parse error.*Invalid JSON/);
            });

            it('should accept notifications without session and return 202', async () => {
                sessionId = await initializeServer();

                const notification: JSONRPCMessage = {
                    jsonrpc: '2.0',
                    method: 'notifications/initialized'
                };

                const request = createRequest('POST', notification, { sessionId });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(202);
            });
        });

        describe('GET Requests (SSE Stream)', () => {
            it('should establish standalone SSE stream', async () => {
                sessionId = await initializeServer();

                const request = createRequest('GET', undefined, { sessionId });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(200);
                expect(response.headers.get('content-type')).toBe('text/event-stream');
                expect(response.headers.get('mcp-session-id')).toBe(sessionId);
            });

            it('should reject GET without Accept: text/event-stream', async () => {
                sessionId = await initializeServer();

                const request = createRequest('GET', undefined, { sessionId, accept: 'application/json' });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(406);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_000, /Not Acceptable/);
            });

            it('should reject second standalone SSE stream', async () => {
                sessionId = await initializeServer();

                // First SSE stream
                const request1 = createRequest('GET', undefined, { sessionId });
                const response1 = await transport.handleRequest(request1);
                expect(response1.status).toBe(200);

                // Second SSE stream should be rejected
                const request2 = createRequest('GET', undefined, { sessionId });
                const response2 = await transport.handleRequest(request2);

                expect(response2.status).toBe(409);
                const errorData = await response2.json();
                expectErrorResponse(errorData, -32_000, /Conflict/);
            });
        });

        describe('DELETE Requests', () => {
            it('should handle DELETE to close session', async () => {
                sessionId = await initializeServer();

                const request = createRequest('DELETE', undefined, { sessionId });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(200);
            });

            it('should reject DELETE without valid session', async () => {
                await initializeServer();

                const request = createRequest('DELETE', undefined, { sessionId: 'invalid-session' });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(404);
            });
        });

        describe('Unsupported Methods', () => {
            it('should reject PUT requests', async () => {
                const request = new Request('http://localhost/mcp', { method: 'PUT' });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(405);
                expect(response.headers.get('Allow')).toBe('GET, POST, DELETE');
            });

            it('should reject PATCH requests', async () => {
                const request = new Request('http://localhost/mcp', { method: 'PATCH' });
                const response = await transport.handleRequest(request);

                expect(response.status).toBe(405);
            });
        });
    });

    describe('HTTPServerTransport - Stateless Mode', () => {
        let transport: WebStandardStreamableHTTPServerTransport;
        let mcpServer: McpServer;

        beforeEach(async () => {
            mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

            mcpServer.registerTool(
                'echo',
                { description: 'Echo tool', inputSchema: z.object({ message: z.string() }) },
                async ({ message }): Promise<CallToolResult> => {
                    return { content: [{ type: 'text', text: message }] };
                }
            );

            transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });

            await mcpServer.connect(transport);
        });

        afterEach(async () => {
            await transport.close();
        });

        it('should work without session management', async () => {
            const request = createRequest('POST', TEST_MESSAGES.initialize);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            expect(response.headers.get('mcp-session-id')).toBeNull();
        });

        it('should not require session ID on subsequent requests', async () => {
            // Initialize
            const initRequest = createRequest('POST', TEST_MESSAGES.initialize);
            await transport.handleRequest(initRequest);

            // Subsequent request without session ID should work
            const request = createRequest('POST', TEST_MESSAGES.toolsList);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
        });
    });

    describe('HTTPServerTransport - JSON Response Mode', () => {
        let transport: WebStandardStreamableHTTPServerTransport;
        let mcpServer: McpServer;
        let sessionId: string;

        beforeEach(async () => {
            mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

            mcpServer.registerTool(
                'greet',
                { description: 'Greeting tool', inputSchema: z.object({ name: z.string() }) },
                async ({ name }): Promise<CallToolResult> => {
                    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
                }
            );

            transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: true
            });

            await mcpServer.connect(transport);
        });

        afterEach(async () => {
            await transport.close();
        });

        async function initializeServer(): Promise<string> {
            const request = createRequest('POST', TEST_MESSAGES.initialize);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            const newSessionId = response.headers.get('mcp-session-id');
            expect(newSessionId).toBeDefined();
            return newSessionId as string;
        }

        it('should return JSON response instead of SSE', async () => {
            sessionId = await initializeServer();

            const request = createRequest('POST', TEST_MESSAGES.toolsList, { sessionId });
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/json');

            const data = await response.json();
            expect(data).toMatchObject({
                jsonrpc: '2.0',
                result: expect.objectContaining({
                    tools: expect.any(Array)
                }),
                id: 'tools-1'
            });
        });

        it('should handle tool calls in JSON response mode', async () => {
            sessionId = await initializeServer();

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'World' }
                },
                id: 'call-1'
            };

            const request = createRequest('POST', toolCallMessage, { sessionId });
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/json');

            const data = await response.json();
            expect(data).toMatchObject({
                jsonrpc: '2.0',
                result: {
                    content: [{ type: 'text', text: 'Hello, World!' }]
                },
                id: 'call-1'
            });
        });
    });

    describe('HTTPServerTransport - Session Callbacks', () => {
        it('should call onsessioninitialized callback', async () => {
            const onInitialized = vi.fn();

            const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => 'test-session-123',
                onsessioninitialized: onInitialized
            });

            await mcpServer.connect(transport);

            const request = createRequest('POST', TEST_MESSAGES.initialize);
            await transport.handleRequest(request);

            expect(onInitialized).toHaveBeenCalledWith('test-session-123');

            await transport.close();
        });

        it('should call onsessionclosed callback on DELETE', async () => {
            const onClosed = vi.fn();

            const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => 'test-session-456',
                onsessionclosed: onClosed
            });

            await mcpServer.connect(transport);

            // Initialize first
            const initRequest = createRequest('POST', TEST_MESSAGES.initialize);
            await transport.handleRequest(initRequest);

            // Then delete
            const deleteRequest = createRequest('DELETE', undefined, { sessionId: 'test-session-456' });
            await transport.handleRequest(deleteRequest);

            expect(onClosed).toHaveBeenCalledWith('test-session-456');
        });
    });

    describe('HTTPServerTransport - Event Store (Resumability)', () => {
        let transport: WebStandardStreamableHTTPServerTransport;
        let mcpServer: McpServer;
        let eventStore: EventStore;
        let storedEvents: Map<EventId, { streamId: StreamId; message: JSONRPCMessage }>;
        let sessionId: string;

        beforeEach(async () => {
            storedEvents = new Map();

            eventStore = {
                async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
                    const eventId = `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    storedEvents.set(eventId, { streamId, message });
                    return eventId;
                },
                async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
                    const event = storedEvents.get(eventId);
                    return event?.streamId;
                },
                async replayEventsAfter(
                    lastEventId: EventId,
                    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
                ): Promise<StreamId> {
                    const lastEvent = storedEvents.get(lastEventId);
                    if (!lastEvent) {
                        throw new Error('Event not found');
                    }

                    // Replay events after lastEventId for the same stream
                    const streamId = lastEvent.streamId;
                    const entries = [...storedEvents.entries()];
                    let foundLast = false;

                    for (const [eventId, event] of entries) {
                        if (eventId === lastEventId) {
                            foundLast = true;
                            continue;
                        }
                        if (foundLast && event.streamId === streamId) {
                            await send(eventId, event.message);
                        }
                    }

                    return streamId;
                }
            };

            mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

            mcpServer.registerTool(
                'greet',
                { description: 'Greeting tool', inputSchema: z.object({ name: z.string() }) },
                async ({ name }): Promise<CallToolResult> => {
                    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
                }
            );

            transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore
            });

            await mcpServer.connect(transport);
        });

        afterEach(async () => {
            await transport.close();
        });

        async function initializeServer(): Promise<string> {
            const request = createRequest('POST', TEST_MESSAGES.initialize);
            const response = await transport.handleRequest(request);

            expect(response.status).toBe(200);
            const newSessionId = response.headers.get('mcp-session-id');
            expect(newSessionId).toBeDefined();
            return newSessionId as string;
        }

        it('should store events when event store is configured', async () => {
            sessionId = await initializeServer();

            const request = createRequest('POST', TEST_MESSAGES.toolsList, { sessionId });
            await transport.handleRequest(request);

            // Events should have been stored (priming event + response)
            expect(storedEvents.size).toBeGreaterThan(0);
        });

        it('should include event ID in SSE events', async () => {
            sessionId = await initializeServer();

            const request = createRequest('POST', TEST_MESSAGES.toolsList, { sessionId });
            const response = await transport.handleRequest(request);

            const text = await readSSEEvent(response);

            // Should have id: field in the SSE event
            expect(text).toContain('id:');
        });
    });

    describe('HTTPServerTransport - Protocol Version Validation', () => {
        let transport: WebStandardStreamableHTTPServerTransport;
        let mcpServer: McpServer;
        let sessionId: string;

        beforeEach(async () => {
            mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });

            transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID()
            });

            await mcpServer.connect(transport);
        });

        afterEach(async () => {
            await transport.close();
        });

        async function initializeServer(): Promise<string> {
            const request = createRequest('POST', TEST_MESSAGES.initialize);
            const response = await transport.handleRequest(request);
            return response.headers.get('mcp-session-id') as string;
        }

        it('should reject unsupported protocol version in header', async () => {
            sessionId = await initializeServer();

            const request = new Request('http://localhost/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': 'unsupported-version'
                },
                body: JSON.stringify(TEST_MESSAGES.toolsList)
            });

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32_000, /Unsupported protocol version/);
        });
    });

    describe('HTTPServerTransport - start() method', () => {
        it('should throw error when started twice', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID()
            });

            await transport.start();

            await expect(transport.start()).rejects.toThrow('Transport already started');
        });
    });

    describe('HTTPServerTransport - onerror callback', () => {
        let transport: WebStandardStreamableHTTPServerTransport;
        let mcpServer: McpServer;
        let errors: Error[];

        beforeEach(async () => {
            errors = [];
            mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });

            transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID()
            });

            transport.onerror = err => errors.push(err);

            await mcpServer.connect(transport);
        });

        afterEach(async () => {
            await transport.close();
        });

        async function initializeServer(): Promise<string> {
            const request = createRequest('POST', TEST_MESSAGES.initialize);
            const response = await transport.handleRequest(request);
            return response.headers.get('mcp-session-id') as string;
        }

        it('should call onerror for invalid JSON', async () => {
            const request = new Request('http://localhost/mcp', {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                },
                body: 'not valid json'
            });

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(400);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error).toBeInstanceOf(SyntaxError);
        });

        it('should call onerror for invalid JSON-RPC message', async () => {
            const request = new Request('http://localhost/mcp', {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ not: 'valid jsonrpc' })
            });

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(400);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error?.name).toBe('ZodError');
        });

        it('should call onerror for missing Accept header on POST', async () => {
            const request = createRequest('POST', TEST_MESSAGES.initialize, { accept: 'application/json' });

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(406);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error?.message).toContain('Not Acceptable');
        });

        it('should call onerror for unsupported Content-Type', async () => {
            const request = new Request('http://localhost/mcp', {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'text/plain'
                },
                body: JSON.stringify(TEST_MESSAGES.initialize)
            });

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(415);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error?.message).toContain('Unsupported Media Type');
        });

        it('should call onerror for server not initialized', async () => {
            const request = createRequest('POST', TEST_MESSAGES.toolsList);

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(400);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error?.message).toContain('Server not initialized');
        });

        it('should call onerror for invalid session ID', async () => {
            await initializeServer();

            const request = createRequest('POST', TEST_MESSAGES.toolsList, { sessionId: 'invalid-session-id' });

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(404);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error?.message).toContain('Session not found');
        });

        it('should call onerror for re-initialization attempt', async () => {
            await initializeServer();

            const request = createRequest('POST', TEST_MESSAGES.initialize);

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(400);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error?.message).toContain('Server already initialized');
        });

        it('should call onerror for GET without Accept header', async () => {
            const sessionId = await initializeServer();

            const request = createRequest('GET', undefined, { sessionId, accept: 'application/json' });

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(406);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error?.message).toContain('Not Acceptable');
        });

        it('should call onerror for concurrent SSE streams', async () => {
            const sessionId = await initializeServer();

            const request1 = createRequest('GET', undefined, { sessionId });
            await transport.handleRequest(request1);

            const request2 = createRequest('GET', undefined, { sessionId });
            const response2 = await transport.handleRequest(request2);

            expect(response2.status).toBe(409);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error?.message).toContain('Conflict');
        });

        it('should call onerror for unsupported protocol version', async () => {
            const sessionId = await initializeServer();

            const request = new Request('http://localhost/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': 'unsupported-version'
                },
                body: JSON.stringify(TEST_MESSAGES.toolsList)
            });

            const response = await transport.handleRequest(request);

            expect(response.status).toBe(400);
            expect(errors.length).toBeGreaterThan(0);
            const error = errors[0];
            expect(error).toBeDefined();
            expect(error?.message).toContain('Unsupported protocol version');
        });
    });

    describe('HTTPServerTransport - Stateless routing (per-request protocol revisions)', () => {
        const draftHeaders = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-protocol-version': DRAFT_PROTOCOL_VERSION
        };
        const toolsListDraft = {
            jsonrpc: '2.0',
            method: 'tools/list',
            params: {},
            id: 'route-1'
        } as JSONRPCMessage;

        /** The complete per-request `_meta` envelope this protocol revision requires. */
        const validEnvelope = () => ({
            'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {}
        });

        /** A transport connected to a server that lists the draft protocol version as supported. */
        async function connectDraftServer(transport: WebStandardStreamableHTTPServerTransport): Promise<McpServer> {
            const mcpServer = new McpServer(
                { name: 'test-server', version: '1.0.0' },
                {
                    capabilities: {},
                    supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION]
                }
            );
            mcpServer.registerTool('noop', { inputSchema: z.object({}) }, async (): Promise<CallToolResult> => ({ content: [] }));
            await mcpServer.connect(transport);
            return mcpServer;
        }

        it('non-POST methods on the stateless path get 405 with Allow: POST', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            for (const method of ['GET', 'DELETE'] as const) {
                const response = await transport.handleRequest(new Request('http://localhost/mcp', { method, headers: draftHeaders }));
                expect(response.status).toBe(405);
                expect(response.headers.get('allow')).toBe('POST');
            }

            await transport.close();
        });

        it('falls back to the parsed body _meta version claim when the header is absent', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            // The incomplete envelope proves the route: only the stateless path
            // answers with the envelope -32602 (the stateful path would serve the
            // request normally on this session-less transport).
            const parsedBody = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: { _meta: { 'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION } },
                id: 'route-2'
            };
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                    body: JSON.stringify(parsedBody)
                }),
                { parsedBody }
            );

            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ id: 'route-2', error: { code: -32_602 } });

            await transport.close();
        });

        it('routes on the body _meta claim when the header is absent and the body is not pre-parsed', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            // Same incomplete-envelope trick as the pre-parsed test: only the
            // stateless path answers -32602. Without routing-time body parsing this
            // request would silently run on the stateful machinery.
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'tools/list',
                        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION } },
                        id: 'route-raw-1'
                    })
                })
            );

            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ id: 'route-raw-1', error: { code: -32_602 } });

            await transport.close();
        });

        it('serves a header-less raw-body claim end to end (the body is parsed once by routing)', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'tools/list',
                        params: { _meta: validEnvelope() },
                        id: 'route-raw-2'
                    })
                })
            );

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ id: 'route-raw-2', result: { tools: [{ name: 'noop' }] } });

            await transport.close();
        });

        it('routes the body _meta claim on a session-mode transport too (no session header present)', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'session-route-1' });
            await connectDraftServer(transport);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'tools/list',
                        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION } },
                        id: 'route-raw-3'
                    })
                })
            );

            // The stateless -32602, not the stateful "Server not initialized" rejection.
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ id: 'route-raw-3', error: { code: -32_602 } });

            await transport.close();
        });

        it('keeps header-less traffic with no body claim on the stateful path', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            // No version header, no _meta claim: legitimate 2025 traffic. The
            // stateful machinery serves it (an envelope -32602 here would mean the
            // routing sniff hijacked it).
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'route-raw-4' })
                })
            );

            expect(response.status).toBe(200);
            // The stateful request path answers over SSE.
            expect(response.headers.get('content-type')).toBe('text/event-stream');
            const body = parseSSEData(await readSSEEvent(response));
            expect(body).toMatchObject({ id: 'route-raw-4', result: { tools: [{ name: 'noop' }] } });

            await transport.close();
        });

        it('serves a routed request with a complete envelope as a single JSON response', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: draftHeaders,
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'tools/list',
                        params: { _meta: validEnvelope() },
                        id: 'route-5'
                    })
                })
            );

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');
            // Sessionless invariant: the stateless path never emits a session header.
            expect(response.headers.get('mcp-session-id')).toBeNull();
            expect(await response.json()).toMatchObject({
                jsonrpc: '2.0',
                id: 'route-5',
                result: { tools: [{ name: 'noop' }] }
            });

            await transport.close();
        });

        it('opens an SSE stream when the handler emits request-scoped notifications', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION]
            });
            transport.setStatelessHandlers({
                dispatch: async (request, ctx) => {
                    await ctx.sendNotification?.({
                        jsonrpc: '2.0',
                        method: 'notifications/progress',
                        params: { progressToken: 'tok', progress: 1 }
                    });
                    return { jsonrpc: '2.0', id: request.id, result: {} };
                }
            });

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', { method: 'POST', headers: draftHeaders, body: JSON.stringify(toolsListDraft) })
            );

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');

            const events = (await response.text())
                .split('\n\n')
                .filter(Boolean)
                .map(event =>
                    JSON.parse(
                        event
                            .split('\n')
                            .find(line => line.startsWith('data: '))!
                            .slice('data: '.length)
                    )
                );
            expect(events).toEqual([
                { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'tok', progress: 1 } },
                { jsonrpc: '2.0', id: 'route-1', result: {} }
            ]);

            await transport.close();
        });

        it('drops notifications sent after the response settled instead of buffering into a dead stream', async () => {
            const errors: Error[] = [];
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION]
            });
            transport.onerror = error => {
                errors.push(error);
            };
            let lateNotify!: () => Promise<void>;
            transport.setStatelessHandlers({
                dispatch: async (request, ctx) => {
                    // Capture the callback so a "leaked task" can fire it after the
                    // JSON response has already been produced.
                    lateNotify = () =>
                        ctx.sendNotification!({
                            jsonrpc: '2.0',
                            method: 'notifications/progress',
                            params: { progressToken: 'late', progress: 1 }
                        });
                    return { jsonrpc: '2.0', id: request.id, result: {} };
                }
            });

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', { method: 'POST', headers: draftHeaders, body: JSON.stringify(toolsListDraft) })
            );

            // No notification before settling: a plain JSON response.
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');

            // Late notifications are dropped (surfaced once via onerror), never buffered.
            await lateNotify();
            await lateNotify();
            expect(errors.filter(error => error.message.includes('after the response settled'))).toHaveLength(1);

            await transport.close();
        });

        it('maps JSON-RPC error codes to HTTP statuses on the stateless path', async () => {
            const cases: Array<[number, number]> = [
                [-32_700, 400], // ParseError
                [-32_600, 400], // InvalidRequest
                [-32_602, 400], // InvalidParams
                [-32_001, 400], // HeaderMismatch
                [-32_003, 400], // MissingRequiredClientCapability
                [-32_004, 400], // UnsupportedProtocolVersion
                [-32_601, 404], // MethodNotFound
                [-32_603, 500], // InternalError
                [-32_002, 200], // domain-level error (ResourceNotFound): the HTTP exchange succeeded
                [1234, 200] // application-defined error
            ];

            for (const [code, status] of cases) {
                const transport = new WebStandardStreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                    supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION]
                });
                transport.setStatelessHandlers({
                    dispatch: async request => ({ jsonrpc: '2.0', id: request.id, error: { code, message: 'mapped' } })
                });

                const response = await transport.handleRequest(
                    new Request('http://localhost/mcp', { method: 'POST', headers: draftHeaders, body: JSON.stringify(toolsListDraft) })
                );

                expect(response.status, `code ${code}`).toBe(status);
                expect(await response.json()).toMatchObject({ id: 'route-1', error: { code } });

                await transport.close();
            }
        });

        it('rejects a header/_meta protocol version mismatch with 400 and -32001, id echoed', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: draftHeaders,
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'tools/list',
                        params: { _meta: { ...validEnvelope(), 'io.modelcontextprotocol/protocolVersion': 'v999.0.0' } },
                        id: 'route-6'
                    })
                })
            );

            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
                jsonrpc: '2.0',
                id: 'route-6',
                error: { code: -32_001, message: expect.stringContaining('Header mismatch') }
            });

            await transport.close();
        });

        it('takes the stateful path when no stateless handlers are installed, even with the draft version listed', async () => {
            // Transport double for the seam-absent case: the draft version is listed via the
            // constructor option but the transport is never connected, so no handlers exist.
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION]
            });

            // A notification-only POST is answered 202 by the stateful path (the
            // stateless path would reject it: it only dispatches single requests).
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: draftHeaders,
                    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
                })
            );

            expect(response.status).toBe(202);

            await transport.close();
        });

        it('rejects batches on the stateless path', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: draftHeaders,
                    body: JSON.stringify([toolsListDraft, { ...toolsListDraft, id: 'route-3' }])
                })
            );

            expect(response.status).toBe(400);
            expectErrorResponse(await response.json(), -32_600, /Batching is not supported/);

            await transport.close();
        });

        it('answers a notification body on the stateless path with 202 and no body', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: draftHeaders,
                    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'x' } })
                })
            );

            expect(response.status).toBe(202);
            expect(await response.text()).toBe('');

            await transport.close();
        });

        it('rejects a response body on the stateless path with 400', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: draftHeaders,
                    body: JSON.stringify({ jsonrpc: '2.0', id: 9, result: {} })
                })
            );

            expect(response.status).toBe(400);
            expectErrorResponse(await response.json(), -32_600, /no server-initiated request awaits a response/);

            await transport.close();
        });

        it('rejects a malformed JSON-RPC body on the stateless path with a parse error', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: draftHeaders,
                    body: JSON.stringify({ jsonrpc: '2.0' })
                })
            );

            expect(response.status).toBe(400);
            expectErrorResponse(await response.json(), -32_700, /Invalid JSON-RPC message/);

            await transport.close();
        });

        it('a dispatch rejection answers 500 with a generic message (no leak)', async () => {
            // Fault-injecting handlers double: dispatch() maps handler errors to
            // error responses itself, so the rejection branch needs direct injection.
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION]
            });
            transport.setStatelessHandlers({
                dispatch: () => {
                    throw new Error('secret internal detail');
                }
            });
            const errors: Error[] = [];
            transport.onerror = error => errors.push(error);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', { method: 'POST', headers: draftHeaders, body: JSON.stringify(toolsListDraft) })
            );

            // The wire gets a generic message (no internal details leak); onerror gets the real one.
            expect(response.status).toBe(500);
            expect(await response.json()).toEqual({
                jsonrpc: '2.0',
                id: 'route-1',
                error: { code: -32_603, message: 'Internal error' }
            });
            expect(errors.map(error => error.message)).toEqual(['secret internal detail']);

            await transport.close();
        });

        it('a raw non-JSON body on the stateless path gets a 400 parse error', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await connectDraftServer(transport);

            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', { method: 'POST', headers: draftHeaders, body: 'this is not json' })
            );

            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32_700, message: 'Parse error: Invalid JSON' }
            });

            await transport.close();
        });
    });

    describe('close() re-entrancy guard', () => {
        it('should not recurse when onclose triggers a second close()', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });

            let closeCallCount = 0;
            transport.onclose = () => {
                closeCallCount++;
                // Simulate the Protocol layer calling close() again from within onclose —
                // the re-entrancy guard should prevent infinite recursion / stack overflow.
                void transport.close();
            };

            // Should resolve without throwing RangeError: Maximum call stack size exceeded
            await expect(transport.close()).resolves.toBeUndefined();
            expect(closeCallCount).toBe(1);
        });

        it('should clean up all streams exactly once even when close() is called concurrently', async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });

            const cleanupCalls: string[] = [];

            // Inject a fake stream entry to verify cleanup runs exactly once
            // @ts-expect-error accessing private map for test purposes
            transport._streamMapping.set('stream-1', {
                cleanup: () => {
                    cleanupCalls.push('stream-1');
                }
            });

            // Fire two concurrent close() calls — only the first should proceed
            await Promise.all([transport.close(), transport.close()]);

            expect(cleanupCalls).toEqual(['stream-1']);
        });
    });
});
