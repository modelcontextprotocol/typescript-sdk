import http from 'http';
import { jest } from '@jest/globals';
import { SSEServerTransport } from './sse.js';
import { McpServer } from './mcp.js';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { z } from 'zod';
import { CallToolResult, JSONRPCMessage } from 'src/types.js';

const createMockResponse = () => {
    const res = {
        writeHead: jest.fn<http.ServerResponse['writeHead']>().mockReturnThis(),
        write: jest.fn<http.ServerResponse['write']>().mockReturnThis(),
        on: jest.fn<http.ServerResponse['on']>().mockReturnThis(),
        end: jest.fn<http.ServerResponse['end']>().mockReturnThis()
    };

    return res as unknown as jest.Mocked<http.ServerResponse>;
};

const createMockRequest = ({ headers = {}, body }: { headers?: Record<string, string>; body?: string } = {}) => {
    const mockReq = {
        headers,
        body: body ? body : undefined,
        auth: {
            token: 'test-token'
        },
        on: jest.fn<http.IncomingMessage['on']>().mockImplementation((event, listener) => {
            const mockListener = listener as unknown as (...args: unknown[]) => void;
            if (event === 'data') {
                mockListener(Buffer.from(body || '') as unknown as Error);
            }
            if (event === 'error') {
                mockListener(new Error('test'));
            }
            if (event === 'end') {
                mockListener();
            }
            if (event === 'close') {
                setTimeout(listener, 100);
            }
            return mockReq;
        }),
        listeners: jest.fn<http.IncomingMessage['listeners']>(),
        removeListener: jest.fn<http.IncomingMessage['removeListener']>()
    } as unknown as http.IncomingMessage;

    return mockReq;
};

/**
 * Helper to create and start test HTTP server with MCP setup
 */
async function createTestServerWithSse(args: { mockRes: http.ServerResponse }): Promise<{
    server: Server;
    transport: SSEServerTransport;
    mcpServer: McpServer;
    baseUrl: URL;
    sessionId: string;
    serverPort: number;
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

    const endpoint = '/messages';

    const transport = new SSEServerTransport(endpoint, args.mockRes);
    const sessionId = transport.sessionId;

    await mcpServer.connect(transport);

    const server = createServer(async (req, res) => {
        try {
            await transport.handlePostMessage(req, res);
        } catch (error) {
            console.error('Error handling request:', error);
            if (!res.headersSent) res.writeHead(500).end();
        }
    });

    const baseUrl = await new Promise<URL>(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    const port = (server.address() as AddressInfo).port;

    return { server, transport, mcpServer, baseUrl, sessionId, serverPort: port };
}

async function readAllSSEEvents(response: Response): Promise<string[]> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No readable stream');

    const events: string[] = [];
    const decoder = new TextDecoder();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (value) {
                events.push(decoder.decode(value));
            }
        }
    } finally {
        reader.releaseLock();
    }

    return events;
}

/**
 * Helper to send JSON-RPC request
 */
async function sendSsePostRequest(
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
        baseUrl.searchParams.set('sessionId', sessionId);
    }

    return fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(message)
    });
}

describe('SSEServerTransport', () => {
    async function initializeServer(baseUrl: URL): Promise<void> {
        const response = await sendSsePostRequest(baseUrl, {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                clientInfo: { name: 'test-client', version: '1.0' },
                protocolVersion: '2025-03-26',
                capabilities: {}
            },

            id: 'init-1'
        } as JSONRPCMessage);

        expect(response.status).toBe(202);

        const text = await readAllSSEEvents(response);

        expect(text).toHaveLength(1);
        expect(text[0]).toBe('Accepted');
    }

    describe('start method', () => {
        it('should correctly append sessionId to a simple relative endpoint', async () => {
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);
            const expectedSessionId = transport.sessionId;

            await transport.start();

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
            expect(mockRes.write).toHaveBeenCalledTimes(1);
            expect(mockRes.write).toHaveBeenCalledWith(`event: endpoint\ndata: /messages?sessionId=${expectedSessionId}\n\n`);
        });

        it('should correctly append sessionId to an endpoint with existing query parameters', async () => {
            const mockRes = createMockResponse();
            const endpoint = '/messages?foo=bar&baz=qux';
            const transport = new SSEServerTransport(endpoint, mockRes);
            const expectedSessionId = transport.sessionId;

            await transport.start();

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
            expect(mockRes.write).toHaveBeenCalledTimes(1);
            expect(mockRes.write).toHaveBeenCalledWith(
                `event: endpoint\ndata: /messages?foo=bar&baz=qux&sessionId=${expectedSessionId}\n\n`
            );
        });

        it('should correctly append sessionId to an endpoint with a hash fragment', async () => {
            const mockRes = createMockResponse();
            const endpoint = '/messages#section1';
            const transport = new SSEServerTransport(endpoint, mockRes);
            const expectedSessionId = transport.sessionId;

            await transport.start();

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
            expect(mockRes.write).toHaveBeenCalledTimes(1);
            expect(mockRes.write).toHaveBeenCalledWith(`event: endpoint\ndata: /messages?sessionId=${expectedSessionId}#section1\n\n`);
        });

        it('should correctly append sessionId to an endpoint with query parameters and a hash fragment', async () => {
            const mockRes = createMockResponse();
            const endpoint = '/messages?key=value#section2';
            const transport = new SSEServerTransport(endpoint, mockRes);
            const expectedSessionId = transport.sessionId;

            await transport.start();

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
            expect(mockRes.write).toHaveBeenCalledTimes(1);
            expect(mockRes.write).toHaveBeenCalledWith(
                `event: endpoint\ndata: /messages?key=value&sessionId=${expectedSessionId}#section2\n\n`
            );
        });

        it('should correctly handle the root path endpoint "/"', async () => {
            const mockRes = createMockResponse();
            const endpoint = '/';
            const transport = new SSEServerTransport(endpoint, mockRes);
            const expectedSessionId = transport.sessionId;

            await transport.start();

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
            expect(mockRes.write).toHaveBeenCalledTimes(1);
            expect(mockRes.write).toHaveBeenCalledWith(`event: endpoint\ndata: /?sessionId=${expectedSessionId}\n\n`);
        });

        it('should correctly handle an empty string endpoint ""', async () => {
            const mockRes = createMockResponse();
            const endpoint = '';
            const transport = new SSEServerTransport(endpoint, mockRes);
            const expectedSessionId = transport.sessionId;

            await transport.start();

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
            expect(mockRes.write).toHaveBeenCalledTimes(1);
            expect(mockRes.write).toHaveBeenCalledWith(`event: endpoint\ndata: /?sessionId=${expectedSessionId}\n\n`);
        });

        /**
         * Test: Tool With Request Info
         */
        it('should pass request info to tool callback', async () => {
            const mockRes = createMockResponse();
            const { mcpServer, baseUrl, sessionId, serverPort } = await createTestServerWithSse({ mockRes });
            await initializeServer(baseUrl);

            mcpServer.tool(
                'test-request-info',
                'A simple test tool with request info',
                { name: z.string().describe('Name to greet') },
                async ({ name }, { requestInfo }): Promise<CallToolResult> => {
                    return {
                        content: [
                            { type: 'text', text: `Hello, ${name}!` },
                            { type: 'text', text: `${JSON.stringify(requestInfo)}` }
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

            const response = await sendSsePostRequest(baseUrl, toolCallMessage, sessionId);

            expect(response.status).toBe(202);

            expect(mockRes.write).toHaveBeenCalledWith(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

            const expectedMessage = {
                result: {
                    content: [
                        {
                            type: 'text',
                            text: 'Hello, Test User!'
                        },
                        {
                            type: 'text',
                            text: JSON.stringify({
                                headers: {
                                    host: `127.0.0.1:${serverPort}`,
                                    connection: 'keep-alive',
                                    'content-type': 'application/json',
                                    accept: 'application/json, text/event-stream',
                                    'accept-language': '*',
                                    'sec-fetch-mode': 'cors',
                                    'user-agent': 'node',
                                    'accept-encoding': 'gzip, deflate',
                                    'content-length': '124'
                                }
                            })
                        }
                    ]
                },
                jsonrpc: '2.0',
                id: 'call-1'
            };
            expect(mockRes.write).toHaveBeenCalledWith(`event: message\ndata: ${JSON.stringify(expectedMessage)}\n\n`);
        });
    });

    describe('handlePostMessage method', () => {
        it('should return 500 if server has not started', async () => {
            const mockReq = createMockRequest();
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);

            const error = 'SSE connection not established';
            await expect(transport.handlePostMessage(mockReq, mockRes)).rejects.toThrow(error);
            expect(mockRes.writeHead).toHaveBeenCalledWith(500);
            expect(mockRes.end).toHaveBeenCalledWith(error);
        });

        it('should return 400 if content-type is not application/json', async () => {
            const mockReq = createMockRequest({ headers: { 'content-type': 'text/plain' } });
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);
            await transport.start();

            transport.onerror = jest.fn();
            const error = 'Unsupported content-type: text/plain';
            await expect(transport.handlePostMessage(mockReq, mockRes)).resolves.toBe(undefined);
            expect(mockRes.writeHead).toHaveBeenCalledWith(400);
            expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining(error));
            expect(transport.onerror).toHaveBeenCalledWith(new Error(error));
        });

        it('should return 400 if message has not a valid schema', async () => {
            const invalidMessage = JSON.stringify({
                // missing jsonrpc field
                method: 'call',
                params: [1, 2, 3],
                id: 1
            });
            const mockReq = createMockRequest({
                headers: { 'content-type': 'application/json' },
                body: invalidMessage
            });
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);
            await transport.start();

            transport.onmessage = jest.fn();
            await transport.handlePostMessage(mockReq, mockRes);
            expect(mockRes.writeHead).toHaveBeenCalledWith(400);
            expect(transport.onmessage).not.toHaveBeenCalled();
            expect(mockRes.end).toHaveBeenCalledWith(`Invalid message: ${invalidMessage}`);
        });

        it('should return 202 if message has a valid schema', async () => {
            const validMessage = JSON.stringify({
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    a: 1,
                    b: 2,
                    c: 3
                },
                id: 1
            });
            const mockReq = createMockRequest({
                headers: { 'content-type': 'application/json' },
                body: validMessage
            });
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);
            await transport.start();

            transport.onmessage = jest.fn();
            await transport.handlePostMessage(mockReq, mockRes);
            expect(mockRes.writeHead).toHaveBeenCalledWith(202);
            expect(mockRes.end).toHaveBeenCalledWith('Accepted');
            expect(transport.onmessage).toHaveBeenCalledWith(
                {
                    jsonrpc: '2.0',
                    method: 'call',
                    params: {
                        a: 1,
                        b: 2,
                        c: 3
                    },
                    id: 1
                },
                {
                    authInfo: {
                        token: 'test-token'
                    },
                    requestInfo: {
                        headers: {
                            'content-type': 'application/json'
                        }
                    }
                }
            );
        });
    });

    describe('close method', () => {
        it('should call onclose', async () => {
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);
            await transport.start();
            transport.onclose = jest.fn();
            await transport.close();
            expect(transport.onclose).toHaveBeenCalled();
        });
    });

    describe('send method', () => {
        it('should call onsend', async () => {
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);
            await transport.start();
            expect(mockRes.write).toHaveBeenCalledTimes(1);
            expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('event: endpoint'));
            expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining(`data: /messages?sessionId=${transport.sessionId}`));
        });
    });

    describe('DNS rebinding protection', () => {
        beforeEach(() => {
            jest.clearAllMocks();
        });

        describe('Host header validation', () => {
            it('should accept requests with allowed host headers', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes, {
                    allowedHosts: ['localhost:3000', 'example.com'],
                    enableDnsRebindingProtection: true
                });
                await transport.start();

                const mockReq = createMockRequest({
                    headers: {
                        host: 'localhost:3000',
                        'content-type': 'application/json'
                    }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(202);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Accepted');
            });

            it('should reject requests with disallowed host headers', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes, {
                    allowedHosts: ['localhost:3000'],
                    enableDnsRebindingProtection: true
                });
                await transport.start();

                const mockReq = createMockRequest({
                    headers: {
                        host: 'evil.com',
                        'content-type': 'application/json'
                    }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(403);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Invalid Host header: evil.com');
            });

            it('should reject requests without host header when allowedHosts is configured', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes, {
                    allowedHosts: ['localhost:3000'],
                    enableDnsRebindingProtection: true
                });
                await transport.start();

                const mockReq = createMockRequest({
                    headers: {
                        'content-type': 'application/json'
                    }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(403);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Invalid Host header: undefined');
            });
        });

        describe('Origin header validation', () => {
            it('should accept requests with allowed origin headers', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes, {
                    allowedOrigins: ['http://localhost:3000', 'https://example.com'],
                    enableDnsRebindingProtection: true
                });
                await transport.start();

                const mockReq = createMockRequest({
                    headers: {
                        origin: 'http://localhost:3000',
                        'content-type': 'application/json'
                    }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(202);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Accepted');
            });

            it('should reject requests with disallowed origin headers', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes, {
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: true
                });
                await transport.start();

                const mockReq = createMockRequest({
                    headers: {
                        origin: 'http://evil.com',
                        'content-type': 'application/json'
                    }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(403);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Invalid Origin header: http://evil.com');
            });
        });

        describe('Content-Type validation', () => {
            it('should accept requests with application/json content-type', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes);
                await transport.start();

                const mockReq = createMockRequest({
                    headers: {
                        'content-type': 'application/json'
                    }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(202);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Accepted');
            });

            it('should accept requests with application/json with charset', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes);
                await transport.start();

                const mockReq = createMockRequest({
                    headers: {
                        'content-type': 'application/json; charset=utf-8'
                    }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(202);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Accepted');
            });

            it('should reject requests with non-application/json content-type when protection is enabled', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes);
                await transport.start();

                const mockReq = createMockRequest({
                    headers: {
                        'content-type': 'text/plain'
                    }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(400);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Error: Unsupported content-type: text/plain');
            });
        });

        describe('enableDnsRebindingProtection option', () => {
            it('should skip all validations when enableDnsRebindingProtection is false', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes, {
                    allowedHosts: ['localhost:3000'],
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: false
                });
                await transport.start();

                const mockReq = createMockRequest({
                    headers: {
                        host: 'evil.com',
                        origin: 'http://evil.com',
                        'content-type': 'text/plain'
                    }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                // Should pass even with invalid headers because protection is disabled
                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(400);
                // The error should be from content-type parsing, not DNS rebinding protection
                expect(mockHandleRes.end).toHaveBeenCalledWith('Error: Unsupported content-type: text/plain');
            });
        });

        describe('Combined validations', () => {
            it('should validate both host and origin when both are configured', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes, {
                    allowedHosts: ['localhost:3000'],
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: true
                });
                await transport.start();

                // Valid host, invalid origin
                const mockReq1 = createMockRequest({
                    headers: {
                        host: 'localhost:3000',
                        origin: 'http://evil.com',
                        'content-type': 'application/json'
                    }
                });
                const mockHandleRes1 = createMockResponse();

                await transport.handlePostMessage(mockReq1, mockHandleRes1, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes1.writeHead).toHaveBeenCalledWith(403);
                expect(mockHandleRes1.end).toHaveBeenCalledWith('Invalid Origin header: http://evil.com');

                // Invalid host, valid origin
                const mockReq2 = createMockRequest({
                    headers: {
                        host: 'evil.com',
                        origin: 'http://localhost:3000',
                        'content-type': 'application/json'
                    }
                });
                const mockHandleRes2 = createMockResponse();

                await transport.handlePostMessage(mockReq2, mockHandleRes2, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes2.writeHead).toHaveBeenCalledWith(403);
                expect(mockHandleRes2.end).toHaveBeenCalledWith('Invalid Host header: evil.com');

                // Both valid
                const mockReq3 = createMockRequest({
                    headers: {
                        host: 'localhost:3000',
                        origin: 'http://localhost:3000',
                        'content-type': 'application/json'
                    }
                });
                const mockHandleRes3 = createMockResponse();

                await transport.handlePostMessage(mockReq3, mockHandleRes3, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes3.writeHead).toHaveBeenCalledWith(202);
                expect(mockHandleRes3.end).toHaveBeenCalledWith('Accepted');
            });
        });
    });
});
