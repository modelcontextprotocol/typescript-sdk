import type { CallToolResult, JSONRPCErrorResponse, JSONRPCMessage } from '@modelcontextprotocol/core';
import { McpServer, Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

const PROTOCOL_VERSION = '2025-11-25';

const TEST_MESSAGES = {
    initialize: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
            clientInfo: { name: 'test-client', version: '1.0' },
            protocolVersion: PROTOCOL_VERSION,
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

function createRequest(
    method: string,
    body?: JSONRPCMessage | JSONRPCMessage[],
    options?: { sessionId?: string; extraHeaders?: Record<string, string> }
): Request {
    const headers: Record<string, string> = {};

    if (method === 'POST') {
        headers.Accept = 'application/json, text/event-stream';
    } else if (method === 'GET') {
        headers.Accept = 'text/event-stream';
    }

    if (body) {
        headers['Content-Type'] = 'application/json';
    }

    if (options?.sessionId) {
        headers['mcp-session-id'] = options.sessionId;
        headers['mcp-protocol-version'] = PROTOCOL_VERSION;
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

async function readSSEEvent(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    const { value } = await reader!.read();
    return new TextDecoder().decode(value);
}

function parseSSEData(text: string): unknown {
    const dataLine = text.split('\n').find(line => line.startsWith('data:'));
    if (!dataLine) throw new Error('No data line found in SSE event');
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

describe('WebStandardStreamableHTTPServerTransport session hydration', () => {
    let transport: WebStandardStreamableHTTPServerTransport;
    let mcpServer: McpServer;

    beforeEach(() => {
        mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

        mcpServer.registerTool(
            'greet',
            {
                description: 'A simple greeting tool',
                inputSchema: z.object({ name: z.string().describe('Name to greet') })
            },
            async ({ name }): Promise<CallToolResult> => ({
                content: [{ type: 'text', text: `Hello, ${name}!` }]
            })
        );
    });

    afterEach(async () => {
        await transport?.close();
    });

    async function connectTransport(options?: ConstructorParameters<typeof WebStandardStreamableHTTPServerTransport>[0]) {
        transport = new WebStandardStreamableHTTPServerTransport(options);
        await mcpServer.connect(transport);
    }

    describe('transport-layer hydration (sessionId option)', () => {
        it('processes requests without initialize when constructed with sessionId', async () => {
            const sessionId = 'persisted-session-id';
            await connectTransport({ sessionId });

            const response = await transport.handleRequest(createRequest('POST', TEST_MESSAGES.toolsList, { sessionId }));

            expect(response.status).toBe(200);
            expect(response.headers.get('mcp-session-id')).toBe(sessionId);

            const eventData = parseSSEData(await readSSEEvent(response));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: expect.objectContaining({
                    tools: expect.arrayContaining([expect.objectContaining({ name: 'greet' })])
                }),
                id: 'tools-1'
            });
        });

        it('rejects requests with a mismatched session ID', async () => {
            await connectTransport({ sessionId: 'persisted-session-id' });

            const response = await transport.handleRequest(
                createRequest('POST', TEST_MESSAGES.toolsList, { sessionId: 'wrong-session-id' })
            );

            expect(response.status).toBe(404);
            expectErrorResponse(await response.json(), -32_001, /Session not found/);
        });

        it('rejects requests without a session ID header', async () => {
            await connectTransport({ sessionId: 'persisted-session-id' });

            const response = await transport.handleRequest(createRequest('POST', TEST_MESSAGES.toolsList));

            expect(response.status).toBe(400);
            const errorData = (await response.json()) as JSONRPCErrorResponse;
            expectErrorResponse(errorData, -32_000, /Mcp-Session-Id header is required/);
            expect(errorData.id).toBeNull();
        });

        it('rejects re-initialize on a hydrated transport', async () => {
            await connectTransport({ sessionId: 'persisted-session-id' });

            const response = await transport.handleRequest(createRequest('POST', TEST_MESSAGES.initialize));

            expect(response.status).toBe(400);
            expectErrorResponse(await response.json(), -32_600, /Server already initialized/);
        });

        it('leaves default initialize flow unchanged when sessionId is not provided', async () => {
            await connectTransport({ sessionIdGenerator: () => 'generated-session-id' });

            const initResponse = await transport.handleRequest(createRequest('POST', TEST_MESSAGES.initialize));

            expect(initResponse.status).toBe(200);
            expect(initResponse.headers.get('mcp-session-id')).toBe('generated-session-id');

            const toolsResponse = await transport.handleRequest(
                createRequest('POST', TEST_MESSAGES.toolsList, { sessionId: 'generated-session-id' })
            );

            expect(toolsResponse.status).toBe(200);
            const eventData = parseSSEData(await readSSEEvent(toolsResponse));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: expect.objectContaining({
                    tools: expect.arrayContaining([expect.objectContaining({ name: 'greet' })])
                }),
                id: 'tools-1'
            });
        });
    });

    describe('Server.restoreInitializeState', () => {
        it('restores client capabilities without an initialize round-trip', () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            expect(server.getClientCapabilities()).toBeUndefined();
            expect(server.getClientVersion()).toBeUndefined();

            server.restoreInitializeState({
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { sampling: {}, elicitation: { form: {} } },
                clientInfo: { name: 'persisted-client', version: '2.0.0' }
            });

            expect(server.getClientCapabilities()).toEqual({ sampling: {}, elicitation: { form: {} } });
            expect(server.getClientVersion()).toEqual({ name: 'persisted-client', version: '2.0.0' });
        });

        it('enables capability-gated methods after restoration', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            // Before restoration, server thinks client has no sampling capability
            expect(server.getClientCapabilities()?.sampling).toBeUndefined();

            server.restoreInitializeState({
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { sampling: {} },
                clientInfo: { name: 'c', version: '1' }
            });

            // After restoration, sampling capability is visible
            expect(server.getClientCapabilities()?.sampling).toEqual({});
        });
    });
});
