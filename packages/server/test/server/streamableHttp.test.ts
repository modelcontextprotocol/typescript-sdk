import { randomUUID } from 'node:crypto';

import type { CallToolResult, JSONRPCErrorResponse, JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp';
import type { EventId, EventStore, StreamId } from '../../src/server/streamableHttp';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

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

        it('should store request-related events emitted after closeSSEStream() and not throw on the final response', async () => {
            // The SEP-1699 poll-and-replay flow: handler closes the per-request
            // SSE stream, then emits a notification and its final result while
            // the client has not yet reconnected. Both must be persisted to the
            // eventStore (so they replay on Last-Event-ID reconnect) and the
            // final-response send must not surface a spurious error.
            mcpServer.registerTool(
                'poll',
                { description: 'closeSSE then emit', inputSchema: z.object({}) },
                async (_args, ctx): Promise<CallToolResult> => {
                    ctx.http?.closeSSE?.();
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken: 'poll-1', progress: 75 }
                    });
                    return { content: [{ type: 'text', text: 'done' }] };
                }
            );

            const sendErrors: unknown[] = [];
            mcpServer.server.onerror = e => sendErrors.push(e);

            sessionId = await initializeServer();
            storedEvents.clear();

            const callMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'poll', arguments: {} },
                id: 'poll-1'
            };
            const response = await transport.handleRequest(createRequest('POST', callMessage, { sessionId }));
            // closeSSE() in the handler closes the controller; drain the (now
            // closed) body so the Response is fully consumed.
            await response.text().catch(() => {});
            // Let the async handler chain (notify + final response send) settle.
            await new Promise(resolve => setTimeout(resolve, 50));

            const stored = [...storedEvents.values()].map(e => e.message);
            expect(
                stored.some(m => 'method' in m && m.method === 'notifications/progress'),
                'progress notification should be stored for replay after closeSSE()'
            ).toBe(true);
            expect(
                stored.some(m => 'id' in m && m.id === 'poll-1' && 'result' in m),
                'final response should be stored for replay after closeSSE()'
            ).toBe(true);
            expect(sendErrors).toEqual([]);
        });

        it('should store request-related events after a client disconnect while the request is still in flight', async () => {
            // Per 2025-11-25 transports.mdx, disconnection SHOULD NOT be
            // interpreted as the client cancelling its request — storage is
            // keyed on request-in-flight (_requestToStreamMapping), not on
            // whether a live SSE writer exists. The final-response send must
            // not throw and must clear the request id from the mapping.
            let release!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            mcpServer.registerTool(
                'disconnect',
                { description: 'emit after client disconnect', inputSchema: z.object({}) },
                async (_args, ctx): Promise<CallToolResult> => {
                    await gate;
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken: 'disconnect-1', progress: 50 }
                    });
                    return { content: [{ type: 'text', text: 'done' }] };
                }
            );
            const sendErrors: unknown[] = [];
            mcpServer.server.onerror = e => sendErrors.push(e);

            sessionId = await initializeServer();

            const callMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'disconnect', arguments: {} },
                id: 'disconnect-1'
            };
            const response = await transport.handleRequest(createRequest('POST', callMessage, { sessionId }));
            storedEvents.clear();
            // Client disconnect: cancel the per-request stream (the ReadableStream
            // cancel callback deletes the _streamMapping entry — no live writer).
            await response.body?.cancel();
            await new Promise(resolve => setTimeout(resolve, 10));
            release();
            await new Promise(resolve => setTimeout(resolve, 50));

            const stored = [...storedEvents.values()].map(e => e.message);
            expect(
                stored.some(m => 'method' in m && m.method === 'notifications/progress'),
                'progress notification should be stored while request is in flight (disconnect ≠ cancel)'
            ).toBe(true);
            expect(
                stored.some(m => 'id' in m && m.id === 'disconnect-1' && 'result' in m),
                'final response should be stored for replay when no live writer exists'
            ).toBe(true);
            expect(sendErrors).toEqual([]);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((transport as any)._requestToStreamMapping.has('disconnect-1')).toBe(false);
        });

        it('should accept Last-Event-ID reconnect after closeSSEStream() and replay stored events', async () => {
            // closeSSEStream() removes the _streamMapping entry, so the
            // replayEvents() conflict check sees no active connection and the
            // reconnect succeeds (200), replaying the stored notification.
            let release!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            mcpServer.registerTool(
                'reconnect',
                { description: 'closeSSE, emit, then wait for reconnect', inputSchema: z.object({}) },
                async (_args, ctx): Promise<CallToolResult> => {
                    ctx.http?.closeSSE?.();
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken: 'reconnect-1', progress: 75 }
                    });
                    await gate;
                    return { content: [{ type: 'text', text: 'done' }] };
                }
            );
            mcpServer.server.onerror = () => {};

            sessionId = await initializeServer();
            storedEvents.clear();

            const callMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'reconnect', arguments: {} },
                id: 'reconnect-1'
            };
            const response = await transport.handleRequest(createRequest('POST', callMessage, { sessionId }));
            // Read the priming event so we have a Last-Event-ID to reconnect with.
            const primingText = await response.text().catch(() => '');
            const primingId = /id:\s*(\S+)/.exec(primingText)?.[1];
            expect(primingId).toBeDefined();
            // Let the closeSSE + notify settle (handler is now gated on `gate`).
            await new Promise(resolve => setTimeout(resolve, 30));

            // Reconnect with Last-Event-ID while the request is still in flight.
            const reconnect = await transport.handleRequest(
                createRequest('GET', undefined, { sessionId, extraHeaders: { 'Last-Event-ID': primingId! } })
            );
            expect(reconnect.status).toBe(200);
            release();
            const replayed = await readSSEEvent(reconnect);
            expect(replayed).toContain('notifications/progress');
        });

        it('should close and unregister the resumed stream when reconnecting after the request was already retired', async () => {
            // Retire-then-reconnect: handler closeSSE → emit + result. With no
            // live writer the final response is stored and the request id is
            // retired by the clean-return path. A subsequent Last-Event-ID
            // reconnect must replay the stored response AND close the resumed
            // stream (per spec: server SHOULD close the SSE stream after the
            // JSON-RPC response) so a second reconnect is not refused with 409.
            mcpServer.registerTool(
                'retire',
                { description: 'closeSSE then emit then return', inputSchema: z.object({}) },
                async (_args, ctx): Promise<CallToolResult> => {
                    ctx.http?.closeSSE?.();
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken: 'retire-1', progress: 75 }
                    });
                    return { content: [{ type: 'text', text: 'done' }] };
                }
            );
            mcpServer.server.onerror = () => {};

            sessionId = await initializeServer();
            storedEvents.clear();

            const callMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'retire', arguments: {} },
                id: 'retire-1'
            };
            const response = await transport.handleRequest(createRequest('POST', callMessage, { sessionId }));
            // Read the priming event so we have a Last-Event-ID to reconnect with.
            const primingText = await response.text().catch(() => '');
            const primingId = /id:\s*(\S+)/.exec(primingText)?.[1];
            expect(primingId).toBeDefined();
            // Let the handler chain (notify + final response send → clean-return) settle.
            await new Promise(resolve => setTimeout(resolve, 50));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((transport as any)._requestToStreamMapping.has('retire-1')).toBe(false);

            // Reconnect after the request was retired.
            const reconnect = await transport.handleRequest(
                createRequest('GET', undefined, { sessionId, extraHeaders: { 'Last-Event-ID': primingId! } })
            );
            expect(reconnect.status).toBe(200);
            const replayed = await reconnect.text();
            expect(replayed).toContain('notifications/progress');
            expect(replayed).toContain('"id":"retire-1"');
            expect(replayed, 'replay should include the stored final response').toContain('"result"');

            // Resumed stream must have been closed and unregistered: a second
            // reconnect with the same Last-Event-ID is accepted (200), not 409.
            const reconnect2 = await transport.handleRequest(
                createRequest('GET', undefined, { sessionId, extraHeaders: { 'Last-Event-ID': primingId! } })
            );
            expect(reconnect2.status).toBe(200);
            await reconnect2.body?.cancel();
        });

        it('should write to a stream resumed during the storeEvent() await (re-read after await, no TOCTOU)', async () => {
            // send() reads _streamMapping[streamId] before `await storeEvent()`
            // and decides on that snapshot. A Last-Event-ID reconnect during
            // the await registers a resumed stream — send() must re-read after
            // the await so the final response is written to it (and the
            // all-responses-ready path closes/unregisters it), not silently
            // dropped into the clean-return.
            let handlerRelease!: () => void;
            const handlerGate = new Promise<void>(resolve => {
                handlerRelease = resolve;
            });
            mcpServer.registerTool(
                'toctou',
                { description: 'closeSSE, gate, then return', inputSchema: z.object({}) },
                async (_args, ctx): Promise<CallToolResult> => {
                    ctx.http?.closeSSE?.();
                    await handlerGate;
                    return { content: [{ type: 'text', text: 'done' }] };
                }
            );
            mcpServer.server.onerror = () => {};

            sessionId = await initializeServer();
            storedEvents.clear();

            // Gate storeEvent() only after we flip `gateStores` (the priming
            // event must store and flush ungated so we have a Last-Event-ID).
            let gateStores = false;
            let storeRelease!: () => void;
            const storeGate = new Promise<void>(resolve => {
                storeRelease = resolve;
            });
            const realStoreEvent = eventStore.storeEvent.bind(eventStore);
            eventStore.storeEvent = async (sid, msg) => {
                const id = await realStoreEvent(sid, msg);
                if (gateStores) {
                    await storeGate;
                }
                return id;
            };

            const callMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'toctou', arguments: {} },
                id: 'toctou-1'
            };
            const response = await transport.handleRequest(createRequest('POST', callMessage, { sessionId }));
            const primingText = await response.text().catch(() => '');
            const primingId = /id:\s*(\S+)/.exec(primingText)?.[1];
            expect(primingId).toBeDefined();

            // Arm the storeEvent gate, then let the handler return so send()
            // for the final response enters `await storeEvent()` and parks.
            gateStores = true;
            handlerRelease();
            await new Promise(resolve => setTimeout(resolve, 30));

            // Reconnect while storeEvent() is pending — registers a resumed
            // stream under the same streamId. The request is still in flight
            // (send() is parked on the await), so replayEvents() leaves it open.
            const reconnect = await transport.handleRequest(
                createRequest('GET', undefined, { sessionId, extraHeaders: { 'Last-Event-ID': primingId! } })
            );
            expect(reconnect.status).toBe(200);

            // Release storeEvent — send() re-reads _streamMapping, sees the
            // resumed stream, writes the result, and the all-responses-ready
            // path closes/unregisters it.
            storeRelease();
            const body = await reconnect.text();
            expect(body, 'final response must be written to the resumed stream').toContain('"id":"toctou-1"');
            expect(body).toContain('"result"');
            // Exactly-once on the resumed stream: replay may have written it,
            // and send() must dedup against replayedEventIds (no double write).
            expect(body.match(/"id":"toctou-1"/g)?.length, 'result must be delivered exactly once').toBe(1);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((transport as any)._requestToStreamMapping.has('toctou-1')).toBe(false);
            // Resumed stream was closed/unregistered: second reconnect → 200.
            const reconnect2 = await transport.handleRequest(
                createRequest('GET', undefined, { sessionId, extraHeaders: { 'Last-Event-ID': primingId! } })
            );
            expect(reconnect2.status).toBe(200);
            await reconnect2.body?.cancel();
        });

        it('should not let a stale per-request cancel delete a successor resumed stream (identity-guarded)', async () => {
            // EventStore without getStreamIdForEventId → replayEvents() skips
            // the conflict check and registers the resumed stream under the
            // SAME streamId, OVERWRITING the original entry. A late cancel of
            // the original POST body must identity-check before deleting so
            // the successor survives and receives subsequent send()s.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (eventStore as any).getStreamIdForEventId;

            let release!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            mcpServer.registerTool(
                'stalecancel',
                { description: 'gate then return', inputSchema: z.object({}) },
                async (): Promise<CallToolResult> => {
                    await gate;
                    return { content: [{ type: 'text', text: 'done' }] };
                }
            );
            mcpServer.server.onerror = () => {};

            sessionId = await initializeServer();
            storedEvents.clear();

            const callMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'stalecancel', arguments: {} },
                id: 'stalecancel-1'
            };
            const original = await transport.handleRequest(createRequest('POST', callMessage, { sessionId }));
            const reader = original.body!.getReader();
            const { value } = await reader.read();
            const primingText = new TextDecoder().decode(value);
            const primingId = /id:\s*(\S+)/.exec(primingText)?.[1];
            expect(primingId).toBeDefined();

            // Reconnect while the original is still mapped (no conflict check
            // without getStreamIdForEventId) — successor overwrites the entry.
            const reconnect = await transport.handleRequest(
                createRequest('GET', undefined, { sessionId, extraHeaders: { 'Last-Event-ID': primingId! } })
            );
            expect(reconnect.status).toBe(200);

            // Late cancel of the ORIGINAL per-request stream — its source
            // cancel callback fires now. Identity-guard must keep the
            // successor's _streamMapping entry intact.
            await reader.cancel();
            await new Promise(resolve => setTimeout(resolve, 10));

            // Handler returns → send() finds the successor and writes to it.
            release();
            const body = await reconnect.text();
            expect(body, 'result must reach the successor resumed stream').toContain('"id":"stalecancel-1"');
            expect(body).toContain('"result"');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((transport as any)._requestToStreamMapping.has('stalecancel-1')).toBe(false);
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

        it('should call onerror when the per-request stream disconnects mid-handler with no eventStore configured', async () => {
            // Sessionful transport WITHOUT an eventStore: a final response sent
            // while no live writer exists is undeliverable AND not stored. The
            // drop must be observable via onerror, and the request id retired.
            // Fresh server (the suite beforeEach connects before any tool is
            // registered, which would trip registerCapabilities).
            let release!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            const localServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });
            localServer.registerTool(
                'disconnect',
                { description: 'return after client disconnect', inputSchema: z.object({}) },
                async (): Promise<CallToolResult> => {
                    await gate;
                    return { content: [{ type: 'text', text: 'done' }] };
                }
            );
            const localTransport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID()
            });
            const localErrors: Error[] = [];
            localServer.server.onerror = e => localErrors.push(e as Error);
            await localServer.connect(localTransport);

            const initRes = await localTransport.handleRequest(createRequest('POST', TEST_MESSAGES.initialize));
            const sessionId = initRes.headers.get('mcp-session-id') as string;

            const callMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'disconnect', arguments: {} },
                id: 'disconnect-1'
            };
            const response = await localTransport.handleRequest(createRequest('POST', callMessage, { sessionId }));
            // Client hard-disconnect: cancel the per-request stream (the
            // ReadableStream cancel callback drops the _streamMapping entry).
            await response.body?.cancel();
            await new Promise(resolve => setTimeout(resolve, 10));
            release();
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(localErrors.length, 'onerror should surface the undeliverable response').toBeGreaterThan(0);
            expect(localErrors[0]?.message).toMatch(/undeliverable.*no eventStore is configured/);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((localTransport as any)._requestToStreamMapping.has('disconnect-1')).toBe(false);
            await localTransport.close();
        });

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

    describe('HTTPServerTransport - keepAliveInterval', () => {
        let transport: WebStandardStreamableHTTPServerTransport;
        let mcpServer: McpServer;

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(async () => {
            vi.useRealTimers();
            await transport.close();
        });

        async function setupTransport(keepAliveInterval?: number): Promise<string> {
            mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });

            transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                keepAliveInterval
            });

            await mcpServer.connect(transport);

            const initReq = createRequest('POST', TEST_MESSAGES.initialize);
            const initRes = await transport.handleRequest(initReq);
            return initRes.headers.get('mcp-session-id') as string;
        }

        it('should send SSE keepalive comments periodically when keepAliveInterval is set', async () => {
            const sessionId = await setupTransport(50);

            const getReq = createRequest('GET', undefined, { sessionId });
            const getRes = await transport.handleRequest(getReq);

            expect(getRes.status).toBe(200);
            expect(getRes.body).not.toBeNull();

            const reader = getRes.body!.getReader();

            // Advance past two intervals to accumulate keepalive comments
            vi.advanceTimersByTime(120);

            const { value } = await reader.read();
            const text = new TextDecoder().decode(value);
            expect(text).toContain(': keepalive');
        });

        it('should not send SSE comments when keepAliveInterval is not set', async () => {
            const sessionId = await setupTransport(undefined);

            const getReq = createRequest('GET', undefined, { sessionId });
            const getRes = await transport.handleRequest(getReq);

            expect(getRes.status).toBe(200);
            expect(getRes.body).not.toBeNull();

            const reader = getRes.body!.getReader();

            // Advance time; no keepalive should be enqueued
            vi.advanceTimersByTime(200);

            // Close the transport to end the stream, then read whatever was buffered
            await transport.close();

            const chunks: string[] = [];
            for (let result = await reader.read(); !result.done; result = await reader.read()) {
                chunks.push(new TextDecoder().decode(result.value));
            }

            const allText = chunks.join('');
            expect(allText).not.toContain(': keepalive');
        });

        it('should clear the keepalive interval when the transport is closed', async () => {
            const sessionId = await setupTransport(50);

            const getReq = createRequest('GET', undefined, { sessionId });
            const getRes = await transport.handleRequest(getReq);

            expect(getRes.status).toBe(200);

            // Close the transport, which should clear the interval
            await transport.close();

            // Advancing timers after close should not throw
            vi.advanceTimersByTime(200);
        });
    });
});
