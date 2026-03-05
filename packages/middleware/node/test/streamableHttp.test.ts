import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as netCreateServer } from 'node:net';

import type {
    AuthInfo,
    CallToolResult,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCResultResponse,
    RequestId
} from '@modelcontextprotocol/core';
import type { EventId, EventStore, StreamId } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import * as z from 'zod/v4';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeStreamableHTTPServerTransport } from '../src/streamableHttp.js';

async function getFreePort() {
    return new Promise(res => {
        const srv = netCreateServer();
        srv.listen(0, () => {
            const address = srv.address()!;
            if (typeof address === 'string') {
                throw new TypeError('Unexpected address type: ' + typeof address);
            }
            const port = (address as AddressInfo).port;
            srv.close(_err => res(port));
        });
    });
}

/**
 * Test server configuration for NodeStreamableHTTPServerTransport tests
 */
interface TestServerConfig {
    sessionIdGenerator: (() => string) | undefined;
    enableJsonResponse?: boolean;
    customRequestHandler?: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>;
    eventStore?: EventStore;
    onsessioninitialized?: (sessionId: string) => void | Promise<void>;
    onsessionclosed?: (sessionId: string) => void | Promise<void>;
    retryInterval?: number;
}

/**
 * Helper to stop test server
 */
async function stopTestServer({ server, transport }: { server: Server; transport: NodeStreamableHTTPServerTransport }): Promise<void> {
    // First close the transport to ensure all SSE streams are closed
    await transport.close();

    // Close the server without waiting indefinitely
    server.close();
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
            protocolVersion: '2025-11-25',
            capabilities: {}
        },
        id: 'init-1'
    } as JSONRPCMessage,

    // Initialize message with an older protocol version for backward compatibility tests
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
 * Helper to extract text from SSE response
 * Note: Can only be called once per response stream. For multiple reads,
 * get the reader manually and read multiple times.
 */
async function readSSEEvent(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    const { value } = await reader!.read();
    return new TextDecoder().decode(value);
}

/**
 * Helper to send JSON-RPC request
 */
async function sendPostRequest(
    baseUrl: URL,
    message: JSONRPCMessage | JSONRPCMessage[],
    sessionId?: string,
    extraHeaders?: Record<string, string>
): Promise<Response> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...extraHeaders
    };

    if (sessionId) {
        headers['mcp-session-id'] = sessionId;
        headers['mcp-protocol-version'] = '2025-11-25';
    }

    return fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(message)
    });
}

function expectErrorResponse(
    data: unknown,
    expectedCode: number,
    expectedMessagePattern: RegExp,
    options?: { expectData?: boolean }
): void {
    expect(data).toMatchObject({
        jsonrpc: '2.0',
        error: expect.objectContaining({
            code: expectedCode,
            message: expect.stringMatching(expectedMessagePattern)
        })
    });
    if (options?.expectData) {
        expect((data as { error: { data?: string } }).error.data).toBeDefined();
    }
}
describe('Zod v4', () => {
    /**
     * Helper to create and start test HTTP server with MCP setup
     */
    async function createTestServer(config?: TestServerConfig): Promise<{
        server: Server;
        transport: NodeStreamableHTTPServerTransport;
        mcpServer: McpServer;
        baseUrl: URL;
    }> {
        config ??= { sessionIdGenerator: () => randomUUID() };
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

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

        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: config.sessionIdGenerator,
            enableJsonResponse: config.enableJsonResponse ?? false,
            eventStore: config.eventStore,
            onsessioninitialized: config.onsessioninitialized,
            onsessionclosed: config.onsessionclosed,
            retryInterval: config.retryInterval
        });

        await mcpServer.connect(transport);

        const server = createServer(async (req, res) => {
            try {
                await (config.customRequestHandler ? config.customRequestHandler(req, res) : transport.handleRequest(req, res));
            } catch (error) {
                console.error('Error handling request:', error);
                if (!res.headersSent) res.writeHead(500).end();
            }
        });

        const baseUrl = await listenOnRandomPort(server);

        return { server, transport, mcpServer, baseUrl };
    }

    /**
     * Helper to create and start authenticated test HTTP server with MCP setup
     */
    async function createTestAuthServer(config: TestServerConfig = { sessionIdGenerator: () => randomUUID() }): Promise<{
        server: Server;
        transport: NodeStreamableHTTPServerTransport;
        mcpServer: McpServer;
        baseUrl: URL;
    }> {
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

        mcpServer.registerTool(
            'profile',
            {
                description: 'A user profile data tool',
                inputSchema: z.object({ active: z.boolean().describe('Profile status') })
            },
            async ({ active }, ctx): Promise<CallToolResult> => {
                return {
                    content: [{ type: 'text', text: `${active ? 'Active' : 'Inactive'} profile from token: ${ctx.http?.authInfo?.token}!` }]
                };
            }
        );

        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: config.sessionIdGenerator,
            enableJsonResponse: config.enableJsonResponse ?? false,
            eventStore: config.eventStore,
            onsessioninitialized: config.onsessioninitialized,
            onsessionclosed: config.onsessionclosed
        });

        await mcpServer.connect(transport);

        const server = createServer(async (req: IncomingMessage & { auth?: AuthInfo }, res) => {
            try {
                if (config.customRequestHandler) {
                    await config.customRequestHandler(req, res);
                } else {
                    req.auth = { token: req.headers['authorization']?.split(' ')[1] } as AuthInfo;
                    await transport.handleRequest(req, res);
                }
            } catch (error) {
                console.error('Error handling request:', error);
                if (!res.headersSent) res.writeHead(500).end();
            }
        });

        const baseUrl = await listenOnRandomPort(server);

        return { server, transport, mcpServer, baseUrl };
    }

    describe('NodeStreamableHTTPServerTransport', () => {
        let server: Server;
        let mcpServer: McpServer;
        let transport: NodeStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;

        beforeEach(async () => {
            const result = await createTestServer();
            server = result.server;
            transport = result.transport;
            mcpServer = result.mcpServer;
            baseUrl = result.baseUrl;
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
        });

        async function initializeServer(): Promise<string> {
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            expect(response.status).toBe(200);
            const newSessionId = response.headers.get('mcp-session-id');
            expect(newSessionId).toBeDefined();
            return newSessionId as string;
        }

        it('should initialize server and generate session ID', async () => {
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');
            expect(response.headers.get('mcp-session-id')).toBeDefined();
        });

        it('should reject second initialization request', async () => {
            // First initialize
            const sessionId = await initializeServer();
            expect(sessionId).toBeDefined();

            // Try second initialize
            const secondInitMessage = {
                ...TEST_MESSAGES.initialize,
                id: 'second-init'
            };

            const response = await sendPostRequest(baseUrl, secondInitMessage);

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

            const response = await sendPostRequest(baseUrl, batchInitMessages);

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32_600, /Only one initialization request is allowed/);
        });

        it('should handle post requests via sse response correctly', async () => {
            sessionId = await initializeServer();

            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList, sessionId);

            expect(response.status).toBe(200);

            // Read the SSE stream for the response
            const text = await readSSEEvent(response);

            // Parse the SSE event
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.slice(5));
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

            const response = await sendPostRequest(baseUrl, toolCallMessage, sessionId);
            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.slice(5));
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

        /***
         * Test: Tool With Request Info
         */
        it('should pass request info to tool callback', async () => {
            sessionId = await initializeServer();

            mcpServer.registerTool(
                'test-request-info',
                {
                    description: 'A simple test tool with request info',
                    inputSchema: z.object({ name: z.string().describe('Name to greet') })
                },
                async ({ name }, ctx): Promise<CallToolResult> => {
                    // Convert Headers object to plain object for JSON serialization
                    // Headers is a Web API class that doesn't serialize with JSON.stringify
                    const serializedRequestInfo = {
                        headers: Object.fromEntries(ctx.http?.req?.headers ?? new Headers())
                    };
                    return {
                        content: [
                            { type: 'text', text: `Hello, ${name}!` },
                            { type: 'text', text: `${JSON.stringify(serializedRequestInfo)}` }
                        ]
                    };
                }
            );

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'test-request-info',
                    arguments: {
                        name: 'Test User'
                    }
                },
                id: 'call-1'
            };

            const response = await sendPostRequest(baseUrl, toolCallMessage, sessionId);
            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.slice(5));

            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: {
                    content: [
                        { type: 'text', text: 'Hello, Test User!' },
                        { type: 'text', text: expect.any(String) }
                    ]
                },
                id: 'call-1'
            });

            const requestInfo = JSON.parse(eventData.result.content[1].text);
            expect(requestInfo).toMatchObject({
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    connection: 'keep-alive',
                    'mcp-session-id': sessionId,
                    'accept-language': '*',
                    'user-agent': expect.any(String),
                    'accept-encoding': expect.any(String),
                    'content-length': expect.any(String)
                }
            });
        });

        it('should reject requests without a valid session ID', async () => {
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList);

            expect(response.status).toBe(400);
            const errorData = (await response.json()) as JSONRPCErrorResponse;
            expectErrorResponse(errorData, -32_000, /Bad Request/);
            expect(errorData.id).toBeNull();
        });

        it('should reject invalid session ID', async () => {
            // First initialize to be in valid state
            await initializeServer();

            // Now try with invalid session ID
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList, 'invalid-session-id');

            expect(response.status).toBe(404);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32_001, /Session not found/);
        });

        it('should establish standalone SSE stream and receive server-initiated messages', async () => {
            // First initialize to get a session ID
            sessionId = await initializeServer();

            // Open a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(sseResponse.status).toBe(200);
            expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');

            // Send a notification (server-initiated message) that should appear on SSE stream
            const notification: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'Test notification' }
            };

            // Send the notification via transport
            await transport.send(notification);

            // Read from the stream and verify we got the notification
            const text = await readSSEEvent(sseResponse);

            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.slice(5));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'Test notification' }
            });
        });

        it('should not close GET SSE stream after sending multiple server notifications', async () => {
            sessionId = await initializeServer();

            // Open a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(sseResponse.status).toBe(200);
            const reader = sseResponse.body?.getReader();

            // Send multiple notifications
            const notification1: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'First notification' }
            };

            // Just send one and verify it comes through - then the stream should stay open
            await transport.send(notification1);

            const { value, done } = await reader!.read();
            const text = new TextDecoder().decode(value);
            expect(text).toContain('First notification');
            expect(done).toBe(false); // Stream should still be open
        });

        it('should reject second SSE stream for the same session', async () => {
            sessionId = await initializeServer();

            // Open first SSE stream
            const firstStream = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(firstStream.status).toBe(200);

            // Try to open a second SSE stream with the same session ID
            const secondStream = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            // Should be rejected
            expect(secondStream.status).toBe(409); // Conflict
            const errorData = await secondStream.json();
            expectErrorResponse(errorData, -32_000, /Only one SSE stream is allowed per session/);
        });

        it('should reject GET requests without Accept: text/event-stream header', async () => {
            sessionId = await initializeServer();

            // Try GET without proper Accept header
            const response = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(response.status).toBe(406);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32_000, /Client must accept text\/event-stream/);
        });

        it('should reject POST requests without proper Accept header', async () => {
            sessionId = await initializeServer();

            // Try POST without Accept: text/event-stream
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json', // Missing text/event-stream
                    'mcp-session-id': sessionId
                },
                body: JSON.stringify(TEST_MESSAGES.toolsList)
            });

            expect(response.status).toBe(406);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32_000, /Client must accept both application\/json and text\/event-stream/);
        });

        it('should reject unsupported Content-Type', async () => {
            sessionId = await initializeServer();

            // Try POST with text/plain Content-Type
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId
                },
                body: 'This is plain text'
            });

            expect(response.status).toBe(415);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32_000, /Content-Type must be application\/json/);
        });

        it('should handle JSON-RPC batch notification messages with 202 response', async () => {
            sessionId = await initializeServer();

            // Send batch of notifications (no IDs)
            const batchNotifications: JSONRPCMessage[] = [
                { jsonrpc: '2.0', method: 'someNotification1', params: {} },
                { jsonrpc: '2.0', method: 'someNotification2', params: {} }
            ];
            const response = await sendPostRequest(baseUrl, batchNotifications, sessionId);

            expect(response.status).toBe(202);
        });

        it('should handle batch request messages with SSE stream for responses', async () => {
            sessionId = await initializeServer();

            // Send batch of requests
            const batchRequests: JSONRPCMessage[] = [
                { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'req-1' },
                { jsonrpc: '2.0', method: 'tools/call', params: { name: 'greet', arguments: { name: 'BatchUser' } }, id: 'req-2' }
            ];
            const response = await sendPostRequest(baseUrl, batchRequests, sessionId);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');

            const reader = response.body?.getReader();

            // The responses may come in any order or together in one chunk
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Check that both responses were sent on the same stream
            expect(text).toContain('"id":"req-1"');
            expect(text).toContain('"tools"'); // tools/list result
            expect(text).toContain('"id":"req-2"');
            expect(text).toContain('Hello, BatchUser'); // tools/call result
        });

        it('should properly handle invalid JSON data', async () => {
            sessionId = await initializeServer();

            // Send invalid JSON
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId
                },
                body: 'This is not valid JSON'
            });

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32_700, /Parse error/);
        });

        it('should include error data in parse error response for unexpected errors', async () => {
            sessionId = await initializeServer();

            // We can't easily trigger the catch-all error handler, but we can verify
            // that the JSON parse error includes useful information
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId
                },
                body: '{ invalid json }'
            });

            expect(response.status).toBe(400);
            const errorData = (await response.json()) as JSONRPCErrorResponse;
            expectErrorResponse(errorData, -32_700, /Parse error/);
            // The error message should contain details about what went wrong
            expect(errorData.error.message).toContain('Invalid JSON');
        });

        it('should return 400 error for invalid JSON-RPC messages', async () => {
            sessionId = await initializeServer();

            // Invalid JSON-RPC (missing required jsonrpc version)
            const invalidMessage = { method: 'tools/list', params: {}, id: 1 }; // missing jsonrpc version
            const response = await sendPostRequest(baseUrl, invalidMessage as JSONRPCMessage, sessionId);

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expect(errorData).toMatchObject({
                jsonrpc: '2.0',
                error: expect.anything()
            });
        });

        it('should reject requests to uninitialized server', async () => {
            // Create a new HTTP server and transport without initializing
            const { server: uninitializedServer, transport: uninitializedTransport, baseUrl: uninitializedUrl } = await createTestServer();
            // Transport not used in test but needed for cleanup

            // No initialization, just send a request directly
            const uninitializedMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'uninitialized-test'
            };

            // Send a request to uninitialized server
            const response = await sendPostRequest(uninitializedUrl, uninitializedMessage, 'any-session-id');

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32_000, /Server not initialized/);

            // Cleanup
            await stopTestServer({ server: uninitializedServer, transport: uninitializedTransport });
        });

        it('should send response messages to the connection that sent the request', async () => {
            sessionId = await initializeServer();

            const message1: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'req-1'
            };

            const message2: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'Connection2' }
                },
                id: 'req-2'
            };

            // Make two concurrent fetch connections for different requests
            const req1 = sendPostRequest(baseUrl, message1, sessionId);
            const req2 = sendPostRequest(baseUrl, message2, sessionId);

            // Get both responses
            const [response1, response2] = await Promise.all([req1, req2]);
            const reader1 = response1.body?.getReader();
            const reader2 = response2.body?.getReader();

            // Read responses from each stream (requires each receives its specific response)
            const { value: value1 } = await reader1!.read();
            const text1 = new TextDecoder().decode(value1);
            expect(text1).toContain('"id":"req-1"');
            expect(text1).toContain('"tools"'); // tools/list result

            const { value: value2 } = await reader2!.read();
            const text2 = new TextDecoder().decode(value2);
            expect(text2).toContain('"id":"req-2"');
            expect(text2).toContain('Hello, Connection2'); // tools/call result
        });

        it('should keep stream open after sending server notifications', async () => {
            sessionId = await initializeServer();

            // Open a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            // Send several server-initiated notifications
            await transport.send({
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'First notification' }
            });

            await transport.send({
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'Second notification' }
            });

            // Stream should still be open - it should not close after sending notifications
            expect(sseResponse.bodyUsed).toBe(false);
        });

        // The current implementation will close the entire transport for DELETE
        // Creating a temporary transport/server where we don't care if it gets closed
        it('should properly handle DELETE requests and close session', async () => {
            // Setup a temporary server for this test
            const tempResult = await createTestServer();
            const tempServer = tempResult.server;
            const tempUrl = tempResult.baseUrl;

            // Initialize to get a session ID
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            // Now DELETE the session
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(deleteResponse.status).toBe(200);

            // Clean up - don't wait indefinitely for server close
            tempServer.close();
        });

        it('should reject DELETE requests with invalid session ID', async () => {
            // Initialize the server first to activate it
            sessionId = await initializeServer();

            // Try to delete with invalid session ID
            const response = await fetch(baseUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': 'invalid-session-id',
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(response.status).toBe(404);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32_001, /Session not found/);
        });

        describe('protocol version header validation', () => {
            it('should accept requests with matching protocol version', async () => {
                sessionId = await initializeServer();

                // Send request with matching protocol version
                const response = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList, sessionId);

                expect(response.status).toBe(200);
            });

            it('should accept requests without protocol version header', async () => {
                sessionId = await initializeServer();

                // Send request without protocol version header
                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'mcp-session-id': sessionId
                        // No mcp-protocol-version header
                    },
                    body: JSON.stringify(TEST_MESSAGES.toolsList)
                });

                expect(response.status).toBe(200);
            });

            it('should reject requests with unsupported protocol version', async () => {
                sessionId = await initializeServer();

                // Send request with unsupported protocol version
                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': '1999-01-01' // Unsupported version
                    },
                    body: JSON.stringify(TEST_MESSAGES.toolsList)
                });

                expect(response.status).toBe(400);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_000, /Bad Request: Unsupported protocol version: .+ \(supported versions: .+\)/);
            });

            it('should accept when protocol version differs from negotiated version', async () => {
                sessionId = await initializeServer();

                // Send request with different but supported protocol version
                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': '2024-11-05' // Different but supported version
                    },
                    body: JSON.stringify(TEST_MESSAGES.toolsList)
                });

                // Request should still succeed
                expect(response.status).toBe(200);
            });

            it('should reject unsupported protocol version on GET requests', async () => {
                sessionId = await initializeServer();

                // GET request with unsupported protocol version
                const response = await fetch(baseUrl, {
                    method: 'GET',
                    headers: {
                        Accept: 'text/event-stream',
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': '1999-01-01' // Unsupported version
                    }
                });

                expect(response.status).toBe(400);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_000, /Bad Request: Unsupported protocol version/);
            });

            it('should reject unsupported protocol version on DELETE requests', async () => {
                sessionId = await initializeServer();

                // DELETE request with unsupported protocol version
                const response = await fetch(baseUrl, {
                    method: 'DELETE',
                    headers: {
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': '1999-01-01' // Unsupported version
                    }
                });

                expect(response.status).toBe(400);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32_000, /Bad Request: Unsupported protocol version/);
            });
        });
    });

    describe('NodeStreamableHTTPServerTransport with AuthInfo', () => {
        let server: Server;
        let transport: NodeStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;

        beforeEach(async () => {
            const result = await createTestAuthServer();
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
        });

        async function initializeServer(): Promise<string> {
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            expect(response.status).toBe(200);
            const newSessionId = response.headers.get('mcp-session-id');
            expect(newSessionId).toBeDefined();
            return newSessionId as string;
        }

        it('should call a tool with authInfo', async () => {
            sessionId = await initializeServer();

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'profile',
                    arguments: { active: true }
                },
                id: 'call-1'
            };

            const response = await sendPostRequest(baseUrl, toolCallMessage, sessionId, { authorization: 'Bearer test-token' });
            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.slice(5));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: {
                    content: [
                        {
                            type: 'text',
                            text: 'Active profile from token: test-token!'
                        }
                    ]
                },
                id: 'call-1'
            });
        });

        it('should calls tool without authInfo when it is optional', async () => {
            sessionId = await initializeServer();

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'profile',
                    arguments: { active: false }
                },
                id: 'call-1'
            };

            const response = await sendPostRequest(baseUrl, toolCallMessage, sessionId);
            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.slice(5));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: {
                    content: [
                        {
                            type: 'text',
                            text: 'Inactive profile from token: undefined!'
                        }
                    ]
                },
                id: 'call-1'
            });
        });
    });

    // Test JSON Response Mode
    describe('NodeStreamableHTTPServerTransport with JSON Response Mode', () => {
        let server: Server;
        let transport: NodeStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;

        beforeEach(async () => {
            const result = await createTestServer({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;

            // Initialize and get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            sessionId = initResponse.headers.get('mcp-session-id') as string;
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
        });

        it('should return JSON response for a single request', async () => {
            const toolsListMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'json-req-1'
            };

            const response = await sendPostRequest(baseUrl, toolsListMessage, sessionId);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/json');

            const result = await response.json();
            expect(result).toMatchObject({
                jsonrpc: '2.0',
                result: expect.objectContaining({
                    tools: expect.arrayContaining([expect.objectContaining({ name: 'greet' })])
                }),
                id: 'json-req-1'
            });
        });

        it('should return JSON response for batch requests', async () => {
            const batchMessages: JSONRPCMessage[] = [
                { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'batch-1' },
                { jsonrpc: '2.0', method: 'tools/call', params: { name: 'greet', arguments: { name: 'JSON' } }, id: 'batch-2' }
            ];

            const response = await sendPostRequest(baseUrl, batchMessages, sessionId);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/json');

            const results = (await response.json()) as JSONRPCResultResponse[];
            expect(Array.isArray(results)).toBe(true);
            expect(results).toHaveLength(2);

            // Batch responses can come in any order
            const listResponse = results.find((r: { id?: RequestId }) => r.id === 'batch-1');
            const callResponse = results.find((r: { id?: RequestId }) => r.id === 'batch-2');

            expect(listResponse).toEqual(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    id: 'batch-1',
                    result: expect.objectContaining({
                        tools: expect.arrayContaining([expect.objectContaining({ name: 'greet' })])
                    })
                })
            );

            expect(callResponse).toEqual(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    id: 'batch-2',
                    result: expect.objectContaining({
                        content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Hello, JSON!' })])
                    })
                })
            );
        });
    });

    // Test pre-parsed body handling
    describe('NodeStreamableHTTPServerTransport with pre-parsed body', () => {
        let server: Server;
        let transport: NodeStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;
        let parsedBody: unknown = null;

        beforeEach(async () => {
            const result = await createTestServer({
                customRequestHandler: async (req, res) => {
                    try {
                        if (parsedBody === null) {
                            await transport.handleRequest(req, res);
                        } else {
                            await transport.handleRequest(req, res, parsedBody);
                            parsedBody = null; // Reset after use
                        }
                    } catch (error) {
                        console.error('Error handling request:', error);
                        if (!res.headersSent) res.writeHead(500).end();
                    }
                },
                sessionIdGenerator: () => randomUUID()
            });

            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;

            // Initialize and get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
        });

        it('should accept pre-parsed request body', async () => {
            // Set up the pre-parsed body
            parsedBody = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'preparsed-1'
            };

            // Send an empty body since we'll use pre-parsed body
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId
                },
                // Empty body - we're testing pre-parsed body
                body: ''
            });

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');

            const reader = response.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Verify the response used the pre-parsed body
            expect(text).toContain('"id":"preparsed-1"');
            expect(text).toContain('"tools"');
        });

        it('should handle pre-parsed batch messages', async () => {
            parsedBody = [
                { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'batch-1' },
                { jsonrpc: '2.0', method: 'tools/call', params: { name: 'greet', arguments: { name: 'PreParsed' } }, id: 'batch-2' }
            ];

            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId
                },
                body: '' // Empty as we're using pre-parsed
            });

            expect(response.status).toBe(200);

            const reader = response.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            expect(text).toContain('"id":"batch-1"');
            expect(text).toContain('"tools"');
        });

        it('should prefer pre-parsed body over request body', async () => {
            // Set pre-parsed to tools/list
            parsedBody = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'preparsed-wins'
            };

            // Send actual body with tools/call - should be ignored
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'tools/call',
                    params: { name: 'greet', arguments: { name: 'Ignored' } },
                    id: 'ignored-id'
                })
            });

            expect(response.status).toBe(200);

            const reader = response.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Should have processed the pre-parsed body
            expect(text).toContain('"id":"preparsed-wins"');
            expect(text).toContain('"tools"');
            expect(text).not.toContain('"ignored-id"');
        });
    });

    // Test resumability support
    describe('NodeStreamableHTTPServerTransport with resumability', () => {
        let server: Server;
        let transport: NodeStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;
        let mcpServer: McpServer;
        const storedEvents: Map<string, { eventId: string; message: JSONRPCMessage }> = new Map();

        // Simple implementation of EventStore
        const eventStore: EventStore = {
            async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
                const eventId = `${streamId}_${randomUUID()}`;
                storedEvents.set(eventId, { eventId, message });
                return eventId;
            },

            async replayEventsAfter(
                lastEventId: EventId,
                {
                    send
                }: {
                    send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
                }
            ): Promise<StreamId> {
                const streamId = lastEventId.split('_')[0]!;
                // Extract stream ID from the event ID
                // For test simplicity, just return all events with matching streamId that aren't the lastEventId
                for (const [eventId, { message }] of storedEvents.entries()) {
                    if (eventId.startsWith(streamId) && eventId !== lastEventId) {
                        await send(eventId, message);
                    }
                }
                return streamId;
            }
        };

        beforeEach(async () => {
            storedEvents.clear();
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore
            });

            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Initialize the server
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
            storedEvents.clear();
        });

        it('should store and include event IDs in server SSE messages', async () => {
            // Open a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(sseResponse.status).toBe(200);
            expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');

            // Send a notification that should be stored with an event ID
            const notification: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'Test notification with event ID' }
            };

            // Send the notification via transport
            await transport.send(notification);

            // Read from the stream and verify we got the notification with an event ID
            const reader = sseResponse.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // The response should contain an event ID
            expect(text).toContain('id: ');
            expect(text).toContain('"method":"notifications/message"');

            // Extract the event ID
            const idMatch = text.match(/id: ([^\n]+)/);
            expect(idMatch).toBeTruthy();

            // Verify the event was stored
            const eventId = idMatch![1]!;
            expect(storedEvents.has(eventId)).toBe(true);
            const storedEvent = storedEvents.get(eventId);
            expect(eventId.startsWith('_GET_stream')).toBe(true);
            expect(storedEvent?.message).toMatchObject(notification);
        });

        it('should store and replay MCP server tool notifications', async () => {
            // Establish a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });
            expect(sseResponse.status).toBe(200);

            // Send a server notification through the MCP server
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'First notification from MCP server' });

            // Read the notification from the SSE stream
            const reader = sseResponse.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Verify the notification was sent with an event ID
            expect(text).toContain('id: ');
            expect(text).toContain('First notification from MCP server');

            // Extract the event ID
            const idMatch = text.match(/id: ([^\n]+)/);
            expect(idMatch).toBeTruthy();
            const firstEventId = idMatch![1]!;

            // Send a second notification
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'Second notification from MCP server' });

            // Close the first SSE stream to simulate a disconnect
            await reader!.cancel();

            // Reconnect with the Last-Event-ID to get missed messages
            const reconnectResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25',
                    'last-event-id': firstEventId
                }
            });

            expect(reconnectResponse.status).toBe(200);

            // Read the replayed notification
            const reconnectReader = reconnectResponse.body?.getReader();
            const reconnectData = await reconnectReader!.read();
            const reconnectText = new TextDecoder().decode(reconnectData.value);

            // Verify we received the second notification that was sent after our stored eventId
            expect(reconnectText).toContain('Second notification from MCP server');
            expect(reconnectText).toContain('id: ');
        });

        it('should store and replay multiple notifications sent while client is disconnected', async () => {
            // Establish a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });
            expect(sseResponse.status).toBe(200);

            const reader = sseResponse.body?.getReader();

            // Send a notification to get an event ID
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'Initial notification' });

            // Read the notification from the SSE stream
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Extract the event ID
            const idMatch = text.match(/id: ([^\n]+)/);
            expect(idMatch).toBeTruthy();
            const lastEventId = idMatch![1]!;

            // Close the SSE stream to simulate a disconnect
            await reader!.cancel();

            // Send MULTIPLE notifications while the client is disconnected
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'Missed notification 1' });
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'Missed notification 2' });
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'Missed notification 3' });

            // Reconnect with the Last-Event-ID to get all missed messages
            const reconnectResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25',
                    'last-event-id': lastEventId
                }
            });

            expect(reconnectResponse.status).toBe(200);

            // Read replayed notifications with a timeout
            const reconnectReader = reconnectResponse.body?.getReader();
            let allText = '';

            // Read chunks until we have all 3 notifications or timeout
            const readWithTimeout = async () => {
                const timeout = setTimeout(() => reconnectReader!.cancel(), 2000);
                try {
                    while (!allText.includes('Missed notification 3')) {
                        const { value, done } = await reconnectReader!.read();
                        if (done) break;
                        allText += new TextDecoder().decode(value);
                    }
                } finally {
                    clearTimeout(timeout);
                }
            };
            await readWithTimeout();

            // Verify we received ALL notifications that were sent while disconnected
            expect(allText).toContain('Missed notification 1');
            expect(allText).toContain('Missed notification 2');
            expect(allText).toContain('Missed notification 3');
        });
    });

    // Test stateless mode
    describe('NodeStreamableHTTPServerTransport in stateless mode', () => {
        let server: Server;
        let transport: NodeStreamableHTTPServerTransport;
        let baseUrl: URL;

        beforeEach(async () => {
            const result = await createTestServer({ sessionIdGenerator: undefined });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
        });

        it('should operate without session ID validation', async () => {
            // Initialize the server first
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            expect(initResponse.status).toBe(200);
            // Should NOT have session ID header in stateless mode
            expect(initResponse.headers.get('mcp-session-id')).toBeNull();

            // Try request without session ID - should work in stateless mode
            const toolsResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList);

            expect(toolsResponse.status).toBe(200);
        });

        it('should handle POST requests with various session IDs in stateless mode', async () => {
            await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            // Try with a random session ID - should be accepted
            const response1 = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': 'random-id-1'
                },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 't1' })
            });
            expect(response1.status).toBe(200);

            // Try with another random session ID - should also be accepted
            const response2 = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': 'different-id-2'
                },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 't2' })
            });
            expect(response2.status).toBe(200);
        });

        it('should reject second SSE stream even in stateless mode', async () => {
            // Despite no session ID requirement, the transport still only allows
            // one standalone SSE stream at a time

            // Initialize the server first
            await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            // Open first SSE stream
            const stream1 = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-protocol-version': '2025-11-25'
                }
            });
            expect(stream1.status).toBe(200);

            // Open second SSE stream - should still be rejected, stateless mode still only allows one
            const stream2 = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-protocol-version': '2025-11-25'
                }
            });
            expect(stream2.status).toBe(409); // Conflict - only one stream allowed
        });
    });

    // Test SSE priming events for POST streams
    describe('NodeStreamableHTTPServerTransport POST SSE priming events', () => {
        let server: Server;
        let transport: NodeStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;
        let mcpServer: McpServer;

        // Simple eventStore for priming event tests
        const createEventStore = (): EventStore => {
            const storedEvents = new Map<string, { eventId: string; message: JSONRPCMessage; streamId: string }>();
            return {
                async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
                    const eventId = `${streamId}::${Date.now()}_${randomUUID()}`;
                    storedEvents.set(eventId, { eventId, message, streamId });
                    return eventId;
                },
                async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
                    const event = storedEvents.get(eventId);
                    return event?.streamId;
                },
                async replayEventsAfter(
                    lastEventId: EventId,
                    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
                ): Promise<StreamId> {
                    const event = storedEvents.get(lastEventId);
                    const streamId = event?.streamId || lastEventId.split('::')[0]!;
                    const eventsToReplay: Array<[string, { message: JSONRPCMessage }]> = [];
                    for (const [eventId, data] of storedEvents.entries()) {
                        if (data.streamId === streamId && eventId > lastEventId) {
                            eventsToReplay.push([eventId, data]);
                        }
                    }
                    eventsToReplay.sort(([a], [b]) => a.localeCompare(b));
                    for (const [eventId, { message }] of eventsToReplay) {
                        if (Object.keys(message).length > 0) {
                            await send(eventId, message);
                        }
                    }
                    return streamId;
                }
            };
        };

        afterEach(async () => {
            if (server && transport) {
                await stopTestServer({ server, transport });
            }
        });

        it('should send priming event with retry field on POST SSE stream', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 5000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Send a tool call request
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 100,
                method: 'tools/call',
                params: { name: 'greet', arguments: { name: 'Test' } }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);
            expect(postResponse.headers.get('content-type')).toBe('text/event-stream');

            // Read the priming event
            const reader = postResponse.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Verify priming event has id and retry field
            expect(text).toContain('id: ');
            expect(text).toContain('retry: 5000');
            expect(text).toContain('data: ');
        });

        it('should NOT send priming event for old protocol versions (backwards compatibility)', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 5000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Initialize with OLD protocol version to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initializeOldVersion);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Send a tool call request with the same OLD protocol version
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 100,
                method: 'tools/call',
                params: { name: 'greet', arguments: { name: 'Test' } }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-06-18'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);
            expect(postResponse.headers.get('content-type')).toBe('text/event-stream');

            // Read the first chunk - should be the actual response, not a priming event
            const reader = postResponse.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Should NOT contain a priming event (empty data line before the response)
            // The first message should be the actual tool result
            expect(text).toContain('event: message');
            expect(text).toContain('"result"');
            // Should NOT have a separate priming event line with empty data
            expect(text).not.toMatch(/^id:.*\ndata:\s*\n\n/);
        });

        it('should send priming event without retry field when retryInterval is not configured', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore()
                // No retryInterval
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Send a tool call request
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 100,
                method: 'tools/call',
                params: { name: 'greet', arguments: { name: 'Test' } }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            // Read the priming event
            const reader = postResponse.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Priming event should have id field but NOT retry field
            expect(text).toContain('id: ');
            expect(text).toContain('data: ');
            expect(text).not.toContain('retry:');
        });

        it('should close POST SSE stream when ctx.http?.closeSSE is called', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 1000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Track when stream close is called and tool completes
            let streamCloseCalled = false;
            let toolResolve: () => void;
            const toolCompletePromise = new Promise<void>(resolve => {
                toolResolve = resolve;
            });

            // Register a tool that closes its own SSE stream via ctx callback
            mcpServer.registerTool('close-stream-tool', { description: 'Closes its own stream' }, async ctx => {
                // Close the SSE stream for this request
                ctx.http?.closeSSE?.();
                streamCloseCalled = true;

                // Wait before returning so we can observe the stream closure
                await toolCompletePromise;
                return { content: [{ type: 'text', text: 'Done' }] };
            });

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Send a tool call request
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 100,
                method: 'tools/call',
                params: { name: 'close-stream-tool', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            const reader = postResponse.body?.getReader();

            // Read the priming event
            await reader!.read();

            // Wait a moment for the tool to call closeSSEStream
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(streamCloseCalled).toBe(true);

            // Stream should now be closed
            const { done } = await reader!.read();
            expect(done).toBe(true);

            // Clean up - resolve the tool promise
            toolResolve!();
        });

        it('should provide closeSSEStream callback in ctx when eventStore is configured', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 1000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Track whether closeSSEStream callback was provided
            let receivedCloseSSEStream: (() => void) | undefined;

            // Register a tool that captures the ctx.http?.closeSSE callback
            mcpServer.registerTool('test-callback-tool', { description: 'Test tool' }, async ctx => {
                receivedCloseSSEStream = ctx.http?.closeSSE;
                return { content: [{ type: 'text', text: 'Done' }] };
            });

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Call the tool
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 200,
                method: 'tools/call',
                params: { name: 'test-callback-tool', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            // Read all events to completion
            const reader = postResponse.body?.getReader();
            while (true) {
                const { done } = await reader!.read();
                if (done) break;
            }

            // Verify closeSSEStream callback was provided
            expect(receivedCloseSSEStream).toBeDefined();
            expect(typeof receivedCloseSSEStream).toBe('function');
        });

        it('should NOT provide closeSSEStream callback for old protocol versions (backwards compatibility)', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 1000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Track whether closeSSEStream callback was provided
            let receivedCloseSSEStream: (() => void) | undefined;
            let receivedCloseStandaloneSSEStream: (() => void) | undefined;

            // Register a tool that captures the ctx.http?.closeSSE callback
            mcpServer.registerTool('test-old-version-tool', { description: 'Test tool' }, async ctx => {
                receivedCloseSSEStream = ctx.http?.closeSSE;
                receivedCloseStandaloneSSEStream = ctx.http?.closeStandaloneSSE;
                return { content: [{ type: 'text', text: 'Done' }] };
            });

            // Initialize with OLD protocol version to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initializeOldVersion);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Call the tool with the same OLD protocol version
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 200,
                method: 'tools/call',
                params: { name: 'test-old-version-tool', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-06-18'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            // Read all events to completion
            const reader = postResponse.body?.getReader();
            while (true) {
                const { done } = await reader!.read();
                if (done) break;
            }

            // Verify closeSSEStream callbacks were NOT provided for old protocol version
            // even though eventStore is configured
            expect(receivedCloseSSEStream).toBeUndefined();
            expect(receivedCloseStandaloneSSEStream).toBeUndefined();
        });

        it('should NOT provide closeSSEStream callback when eventStore is NOT configured', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID()
                // No eventStore
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Track whether closeSSEStream callback was provided
            let receivedCloseSSEStream: (() => void) | undefined;

            // Register a tool that captures the ctx.http?.closeSSE callback
            mcpServer.registerTool('test-no-callback-tool', { description: 'Test tool' }, async ctx => {
                receivedCloseSSEStream = ctx.http?.closeSSE;
                return { content: [{ type: 'text', text: 'Done' }] };
            });

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Call the tool
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 201,
                method: 'tools/call',
                params: { name: 'test-no-callback-tool', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            // Read all events to completion
            const reader = postResponse.body?.getReader();
            while (true) {
                const { done } = await reader!.read();
                if (done) break;
            }

            // Verify closeSSEStream callback was NOT provided
            expect(receivedCloseSSEStream).toBeUndefined();
        });

        it('should provide closeStandaloneSSEStream callback in ctx when eventStore is configured', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 1000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Track whether closeStandaloneSSEStream callback was provided
            let receivedCloseStandaloneSSEStream: (() => void) | undefined;

            // Register a tool that captures the ctx.http?.closeStandaloneSSE callback
            mcpServer.registerTool('test-standalone-callback-tool', { description: 'Test tool' }, async ctx => {
                receivedCloseStandaloneSSEStream = ctx.http?.closeStandaloneSSE;
                return { content: [{ type: 'text', text: 'Done' }] };
            });

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Call the tool
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 203,
                method: 'tools/call',
                params: { name: 'test-standalone-callback-tool', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            // Read all events to completion
            const reader = postResponse.body?.getReader();
            while (true) {
                const { done } = await reader!.read();
                if (done) break;
            }

            // Verify closeStandaloneSSEStream callback was provided
            expect(receivedCloseStandaloneSSEStream).toBeDefined();
            expect(typeof receivedCloseStandaloneSSEStream).toBe('function');
        });

        it('should close standalone GET SSE stream when ctx.http?.closeStandaloneSSE is called', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 1000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Register a tool that closes the standalone SSE stream via ctx callback
            mcpServer.registerTool('close-standalone-stream-tool', { description: 'Closes standalone stream' }, async ctx => {
                ctx.http?.closeStandaloneSSE?.();
                return { content: [{ type: 'text', text: 'Stream closed' }] };
            });

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Open a standalone GET SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });
            expect(sseResponse.status).toBe(200);

            const getReader = sseResponse.body?.getReader();

            // Send a notification to confirm GET stream is established
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'Stream established' });

            // Read the notification to confirm stream is working
            const { value } = await getReader!.read();
            const text = new TextDecoder().decode(value);
            expect(text).toContain('id: ');
            expect(text).toContain('Stream established');

            // Call the tool that closes the standalone SSE stream
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 300,
                method: 'tools/call',
                params: { name: 'close-standalone-stream-tool', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                },
                body: JSON.stringify(toolCallRequest)
            });
            expect(postResponse.status).toBe(200);

            // Read the POST response to completion
            const postReader = postResponse.body?.getReader();
            while (true) {
                const { done } = await postReader!.read();
                if (done) break;
            }

            // GET stream should now be closed - use a race with timeout to avoid hanging
            const readPromise = getReader!.read();
            const timeoutPromise = new Promise<{ done: boolean; value: undefined }>((_, reject) =>
                setTimeout(() => reject(new Error('Stream did not close in time')), 1000)
            );

            const { done } = await Promise.race([readPromise, timeoutPromise]);
            expect(done).toBe(true);
        });

        it('should allow client to reconnect after standalone SSE stream is closed via ctx.http?.closeStandaloneSSE', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 1000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Register a tool that closes the standalone SSE stream
            mcpServer.registerTool('close-standalone-for-reconnect', { description: 'Closes standalone stream' }, async ctx => {
                ctx.http?.closeStandaloneSSE?.();
                return { content: [{ type: 'text', text: 'Stream closed' }] };
            });

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Open a standalone GET SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                }
            });
            expect(sseResponse.status).toBe(200);

            const getReader = sseResponse.body?.getReader();

            // Send a notification to get an event ID
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'Initial message' });

            // Read the notification to get the event ID
            const { value } = await getReader!.read();
            const text = new TextDecoder().decode(value);
            const idMatch = text.match(/id: ([^\n]+)/);
            expect(idMatch).toBeTruthy();
            const lastEventId = idMatch![1]!;

            // Call the tool to close the standalone SSE stream
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 301,
                method: 'tools/call',
                params: { name: 'close-standalone-for-reconnect', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25'
                },
                body: JSON.stringify(toolCallRequest)
            });
            expect(postResponse.status).toBe(200);

            // Read the POST response to completion
            const postReader = postResponse.body?.getReader();
            while (true) {
                const { done } = await postReader!.read();
                if (done) break;
            }

            // Wait for GET stream to close - use a race with timeout
            const readPromise = getReader!.read();
            const timeoutPromise = new Promise<{ done: boolean; value: undefined }>((_, reject) =>
                setTimeout(() => reject(new Error('Stream did not close in time')), 1000)
            );
            const { done } = await Promise.race([readPromise, timeoutPromise]);
            expect(done).toBe(true);

            // Wait a bit to ensure the next notification gets a different timestamp.
            // The eventStore uses Date.now() in event IDs, and if two events have the same
            // timestamp, the UUID suffix ordering is random and may not preserve creation order.
            await new Promise(resolve => setTimeout(resolve, 5));

            // Send a notification while client is disconnected
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'Missed while disconnected' });

            // Client reconnects with Last-Event-ID
            const reconnectResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-11-25',
                    'last-event-id': lastEventId
                }
            });
            expect(reconnectResponse.status).toBe(200);

            // Read the replayed notification
            const reconnectReader = reconnectResponse.body?.getReader();
            let allText = '';
            const readWithTimeout = async () => {
                const timeout = setTimeout(() => reconnectReader!.cancel(), 5000);
                try {
                    while (!allText.includes('Missed while disconnected')) {
                        const { value, done } = await reconnectReader!.read();
                        if (done) break;
                        allText += new TextDecoder().decode(value);
                    }
                } finally {
                    clearTimeout(timeout);
                }
            };
            await readWithTimeout();

            // Verify we received the notification that was sent while disconnected
            expect(allText).toContain('Missed while disconnected');
        }, 15_000);
    });

    // Test onsessionclosed callback
    describe('NodeStreamableHTTPServerTransport onsessionclosed callback', () => {
        it('should call onsessionclosed callback when session is closed via DELETE', async () => {
            const mockCallback = vi.fn();

            // Create server with onsessionclosed callback
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessionclosed: mockCallback
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to get a session ID
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');
            expect(tempSessionId).toBeDefined();

            // DELETE the session
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(deleteResponse.status).toBe(200);
            expect(mockCallback).toHaveBeenCalledWith(tempSessionId);
            expect(mockCallback).toHaveBeenCalledTimes(1);

            // Clean up
            tempServer.close();
        });

        it('should not call onsessionclosed callback when not provided', async () => {
            // Create server without onsessionclosed callback
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID()
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to get a session ID
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            // DELETE the session - should not throw error
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(deleteResponse.status).toBe(200);

            // Clean up
            tempServer.close();
        });

        it('should not call onsessionclosed callback for invalid session DELETE', async () => {
            const mockCallback = vi.fn();

            // Create server with onsessionclosed callback
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessionclosed: mockCallback
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to get a valid session
            await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);

            // Try to DELETE with invalid session ID
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': 'invalid-session-id',
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(deleteResponse.status).toBe(404);
            expect(mockCallback).not.toHaveBeenCalled();

            // Clean up
            tempServer.close();
        });

        it('should call onsessionclosed callback with correct session ID when multiple sessions exist', async () => {
            const mockCallback = vi.fn();

            // Create first server
            const result1 = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessionclosed: mockCallback
            });

            const server1 = result1.server;
            const url1 = result1.baseUrl;

            // Create second server
            const result2 = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessionclosed: mockCallback
            });

            const server2 = result2.server;
            const url2 = result2.baseUrl;

            // Initialize both servers
            const initResponse1 = await sendPostRequest(url1, TEST_MESSAGES.initialize);
            const sessionId1 = initResponse1.headers.get('mcp-session-id');

            const initResponse2 = await sendPostRequest(url2, TEST_MESSAGES.initialize);
            const sessionId2 = initResponse2.headers.get('mcp-session-id');

            expect(sessionId1).toBeDefined();
            expect(sessionId2).toBeDefined();
            expect(sessionId1).not.toBe(sessionId2);

            // DELETE first session
            const deleteResponse1 = await fetch(url1, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': sessionId1 || '',
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(deleteResponse1.status).toBe(200);
            expect(mockCallback).toHaveBeenCalledWith(sessionId1);
            expect(mockCallback).toHaveBeenCalledTimes(1);

            // DELETE second session
            const deleteResponse2 = await fetch(url2, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': sessionId2 || '',
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(deleteResponse2.status).toBe(200);
            expect(mockCallback).toHaveBeenCalledWith(sessionId2);
            expect(mockCallback).toHaveBeenCalledTimes(2);

            // Clean up
            server1.close();
            server2.close();
        });
    });

    // Test async callbacks for onsessioninitialized and onsessionclosed
    describe('NodeStreamableHTTPServerTransport async callbacks', () => {
        it('should support async onsessioninitialized callback', async () => {
            const initializationOrder: string[] = [];

            // Create server with async onsessioninitialized callback
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: async (sessionId: string) => {
                    initializationOrder.push('async-start');
                    // Simulate async operation
                    await new Promise(resolve => setTimeout(resolve, 10));
                    initializationOrder.push('async-end', sessionId);
                }
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to trigger the callback
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            // Give time for async callback to complete
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(initializationOrder).toEqual(['async-start', 'async-end', tempSessionId]);

            // Clean up
            tempServer.close();
        });

        it('should support sync onsessioninitialized callback (backwards compatibility)', async () => {
            const capturedSessionId: string[] = [];

            // Create server with sync onsessioninitialized callback
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sessionId: string) => {
                    capturedSessionId.push(sessionId);
                }
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to trigger the callback
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            expect(capturedSessionId).toEqual([tempSessionId]);

            // Clean up
            tempServer.close();
        });

        it('should support async onsessionclosed callback', async () => {
            const closureOrder: string[] = [];

            // Create server with async onsessionclosed callback
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessionclosed: async (sessionId: string) => {
                    closureOrder.push('async-close-start');
                    // Simulate async operation
                    await new Promise(resolve => setTimeout(resolve, 10));
                    closureOrder.push('async-close-end', sessionId);
                }
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to get a session ID
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');
            expect(tempSessionId).toBeDefined();

            // DELETE the session
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(deleteResponse.status).toBe(200);

            // Give time for async callback to complete
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(closureOrder).toEqual(['async-close-start', 'async-close-end', tempSessionId]);

            // Clean up
            tempServer.close();
        });

        it('should propagate errors from async onsessioninitialized callback', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            // Create server with async onsessioninitialized callback that throws
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: async (_sessionId: string) => {
                    throw new Error('Async initialization error');
                }
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize should fail when callback throws
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            expect(initResponse.status).toBe(400);

            // Clean up
            consoleErrorSpy.mockRestore();
            tempServer.close();
        });

        it('should propagate errors from async onsessionclosed callback', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            // Create server with async onsessionclosed callback that throws
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessionclosed: async (_sessionId: string) => {
                    throw new Error('Async closure error');
                }
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to get a session ID
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            // DELETE should fail when callback throws
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(deleteResponse.status).toBe(500);

            // Clean up
            consoleErrorSpy.mockRestore();
            tempServer.close();
        });

        it('should handle both async callbacks together', async () => {
            const events: string[] = [];

            // Create server with both async callbacks
            const result = await createTestServer({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: async (sessionId: string) => {
                    await new Promise(resolve => setTimeout(resolve, 5));
                    events.push(`initialized:${sessionId}`);
                },
                onsessionclosed: async (sessionId: string) => {
                    await new Promise(resolve => setTimeout(resolve, 5));
                    events.push(`closed:${sessionId}`);
                }
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to trigger first callback
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            // Wait for async callback
            await new Promise(resolve => setTimeout(resolve, 20));

            expect(events).toContain(`initialized:${tempSessionId}`);

            // DELETE to trigger second callback
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-11-25'
                }
            });

            expect(deleteResponse.status).toBe(200);

            // Wait for async callback
            await new Promise(resolve => setTimeout(resolve, 20));

            expect(events).toContain(`closed:${tempSessionId}`);
            expect(events).toHaveLength(2);

            // Clean up
            tempServer.close();
        });
    });

    // Test DNS rebinding protection
    describe('NodeStreamableHTTPServerTransport DNS rebinding protection', () => {
        let server: Server;
        let transport: NodeStreamableHTTPServerTransport;
        let baseUrl: URL;

        afterEach(async () => {
            if (server && transport) {
                await stopTestServer({ server, transport });
            }
        });

        describe('Host header validation', () => {
            it('should accept requests with allowed host headers', async () => {
                const result = await createTestServerWithDnsProtection({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['localhost'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                // Note: fetch() automatically sets Host header to match the URL
                // Since we're connecting to localhost:3001 and that's in allowedHosts, this should work
                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response.status).toBe(200);
            });

            it('should reject requests with disallowed host headers', async () => {
                // Test DNS rebinding protection by creating a server that only allows example.com
                // but we're connecting via localhost, so it should be rejected
                const result = await createTestServerWithDnsProtection({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['example.com:3001'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response.status).toBe(403);
                const body = (await response.json()) as JSONRPCErrorResponse;
                expect(body.error.message).toContain('Invalid Host header:');
            });

            it('should reject GET requests with disallowed host headers', async () => {
                const result = await createTestServerWithDnsProtection({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['example.com:3001'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'GET',
                    headers: {
                        Accept: 'text/event-stream'
                    }
                });

                expect(response.status).toBe(403);
            });
        });

        describe('Origin header validation', () => {
            it('should accept requests with allowed origin headers', async () => {
                const result = await createTestServerWithDnsProtection({
                    sessionIdGenerator: undefined,
                    allowedOrigins: ['http://localhost:3000', 'https://example.com'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Origin: 'http://localhost:3000'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response.status).toBe(200);
            });

            it('should reject requests with disallowed origin headers', async () => {
                const result = await createTestServerWithDnsProtection({
                    sessionIdGenerator: undefined,
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Origin: 'http://evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response.status).toBe(403);
                const body = (await response.json()) as JSONRPCErrorResponse;
                expect(body.error.message).toBe('Invalid Origin header: http://evil.com');
            });

            it('should accept requests without origin headers', async () => {
                const result = await createTestServerWithDnsProtection({
                    sessionIdGenerator: undefined,
                    allowedOrigins: ['http://localhost:3000', 'https://example.com'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                // Should pass even with no Origin headers because requests that do not come from browsers may not have Origin and DNS rebinding attacks can only be performed via browsers
                expect(response.status).toBe(200);
            });
        });

        describe('enableDnsRebindingProtection option', () => {
            it('should skip all validations when enableDnsRebindingProtection is false', async () => {
                const result = await createTestServerWithDnsProtection({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['localhost'],
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: false
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Host: 'evil.com',
                        Origin: 'http://evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                // Should pass even with invalid headers because protection is disabled
                expect(response.status).toBe(200);
            });
        });

        describe('Combined validations', () => {
            it('should validate both host and origin when both are configured', async () => {
                const result = await createTestServerWithDnsProtection({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['localhost'],
                    allowedOrigins: ['http://localhost:3001'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                // Test with invalid origin (host will be automatically correct via fetch)
                const response1 = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Origin: 'http://evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response1.status).toBe(403);
                const body1 = (await response1.json()) as JSONRPCErrorResponse;
                expect(body1.error.message).toBe('Invalid Origin header: http://evil.com');

                // Test with valid origin
                const response2 = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Origin: 'http://localhost:3001'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response2.status).toBe(200);
            });
        });
    });
});

describe('NodeStreamableHTTPServerTransport global Response preservation', () => {
    it('should not override the global Response object', () => {
        // Store reference to the original global Response constructor
        const OriginalResponse = globalThis.Response;

        // Create a custom class that extends Response (similar to Next.js's NextResponse)
        class CustomResponse extends Response {
            customProperty = 'test';
        }

        // Verify instanceof works before creating transport
        const customResponseBefore = new CustomResponse('test body');
        expect(customResponseBefore instanceof Response).toBe(true);
        expect(customResponseBefore instanceof OriginalResponse).toBe(true);

        // Create the transport - this should NOT override globalThis.Response
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID()
        });

        // Verify the global Response is still the original
        expect(globalThis.Response).toBe(OriginalResponse);

        // Verify instanceof still works after creating transport
        const customResponseAfter = new CustomResponse('test body');
        expect(customResponseAfter instanceof Response).toBe(true);
        expect(customResponseAfter instanceof OriginalResponse).toBe(true);

        // Verify that instances created before transport initialization still work
        expect(customResponseBefore instanceof Response).toBe(true);

        // Clean up
        transport.close();
    });

    it('should not override the global Response object when calling handleRequest', async () => {
        // Store reference to the original global Response constructor
        const OriginalResponse = globalThis.Response;

        // Create a custom class that extends Response
        class CustomResponse extends Response {
            customProperty = 'test';
        }

        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID()
        });

        // Create a mock server to test handleRequest
        const port = await getFreePort();
        const httpServer = createServer(async (req, res) => {
            await transport.handleRequest(req as IncomingMessage & { auth?: AuthInfo }, res);
        });

        await new Promise<void>(resolve => {
            httpServer.listen(port, () => resolve());
        });

        try {
            // Make a request to trigger handleRequest
            await fetch(`http://localhost:${port}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify(TEST_MESSAGES.initialize)
            });

            // Verify the global Response is still the original after handleRequest
            expect(globalThis.Response).toBe(OriginalResponse);

            // Verify instanceof still works
            const customResponse = new CustomResponse('test body');
            expect(customResponse instanceof Response).toBe(true);
            expect(customResponse instanceof OriginalResponse).toBe(true);
        } finally {
            await transport.close();
            httpServer.close();
        }
    });
});

/**
 * Helper to create test server with DNS rebinding protection options
 */
async function createTestServerWithDnsProtection(config: {
    sessionIdGenerator: (() => string) | undefined;
    allowedHosts?: string[];
    allowedOrigins?: string[];
    enableDnsRebindingProtection?: boolean;
}): Promise<{
    server: Server;
    transport: NodeStreamableHTTPServerTransport;
    mcpServer: McpServer;
    baseUrl: URL;
}> {
    const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

    const port = await getFreePort();

    if (config.allowedHosts) {
        config.allowedHosts = config.allowedHosts.map(host => {
            if (host.includes(':')) {
                return host;
            }
            return `localhost:${port}`;
        });
    }

    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: config.sessionIdGenerator,
        allowedHosts: config.allowedHosts,
        allowedOrigins: config.allowedOrigins,
        enableDnsRebindingProtection: config.enableDnsRebindingProtection
    });

    await mcpServer.connect(transport);

    const httpServer = createServer(async (req, res) => {
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => (body += chunk));
            req.on('end', async () => {
                const parsedBody = JSON.parse(body);
                await transport.handleRequest(req as IncomingMessage & { auth?: AuthInfo }, res, parsedBody);
            });
        } else {
            await transport.handleRequest(req as IncomingMessage & { auth?: AuthInfo }, res);
        }
    });

    await new Promise<void>(resolve => {
        httpServer.listen(port, () => resolve());
    });

    const serverUrl = new URL(`http://localhost:${port}/`);

    return {
        server: httpServer,
        transport,
        mcpServer,
        baseUrl: serverUrl
    };
}
