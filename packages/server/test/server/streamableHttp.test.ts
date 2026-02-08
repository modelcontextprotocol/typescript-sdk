import { randomUUID } from 'node:crypto';

import type { CallToolResult, JSONRPCErrorResponse, JSONRPCMessage } from '@modelcontextprotocol/core';
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
});
