import http from 'node:http';
import { type Mocked } from 'vitest';

import { SSEServerTransport } from '../../src/sse/sse';
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';

const createMockResponse = () => {
    const res = {
        writeHead: vi.fn<http.ServerResponse['writeHead']>().mockReturnThis(),
        write: vi.fn<http.ServerResponse['write']>().mockReturnThis(),
        on: vi.fn<http.ServerResponse['on']>().mockReturnThis(),
        end: vi.fn<http.ServerResponse['end']>().mockReturnThis()
    };

    return res as unknown as Mocked<http.ServerResponse>;
};

const createMockRequest = ({
    headers = {},
    body,
    url = '/messages'
}: { headers?: Record<string, string>; body?: string; url?: string } = {}) => {
    const mockReq = {
        headers,
        body: body ? body : undefined,
        url,
        method: 'POST',
        auth: {
            token: 'test-token'
        },
        socket: {},
        on: vi.fn<http.IncomingMessage['on']>().mockImplementation((event, listener) => {
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
        listeners: vi.fn<http.IncomingMessage['listeners']>(),
        removeListener: vi.fn<http.IncomingMessage['removeListener']>()
    } as unknown as http.IncomingMessage;

    return mockReq;
};

describe('SSEServerTransport', () => {
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

        it('should throw if started twice', async () => {
            const mockRes = createMockResponse();
            const transport = new SSEServerTransport('/messages', mockRes);
            await transport.start();

            await expect(transport.start()).rejects.toThrow('SSEServerTransport already started');
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

            transport.onerror = vi.fn();
            const error = 'Unsupported content-type: text/plain';
            await expect(transport.handlePostMessage(mockReq, mockRes)).resolves.toBe(undefined);
            expect(mockRes.writeHead).toHaveBeenCalledWith(400);
            expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining(error));
            expect(transport.onerror).toHaveBeenCalledWith(new Error(error));
        });

        it('should return 400 if message has not a valid schema', async () => {
            const invalidMessage = JSON.stringify({
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

            transport.onmessage = vi.fn();
            await transport.handlePostMessage(mockReq, mockRes);
            expect(mockRes.writeHead).toHaveBeenCalledWith(400);
            expect(transport.onmessage).not.toHaveBeenCalled();
            expect(mockRes.end).toHaveBeenCalledWith(`Invalid message: ${invalidMessage}`);
        });

        it('should return 202 if message has a valid schema', async () => {
            const validMessage = JSON.stringify({
                jsonrpc: '2.0',
                method: 'call',
                params: { a: 1, b: 2, c: 3 },
                id: 1
            });
            const mockReq = createMockRequest({
                headers: { host: 'localhost', 'content-type': 'application/json' },
                body: validMessage
            });
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);
            await transport.start();

            transport.onmessage = vi.fn();
            await transport.handlePostMessage(mockReq, mockRes);
            expect(mockRes.writeHead).toHaveBeenCalledWith(202);
            expect(mockRes.end).toHaveBeenCalledWith('Accepted');
            expect(transport.onmessage).toHaveBeenCalledWith(
                {
                    jsonrpc: '2.0',
                    method: 'call',
                    params: { a: 1, b: 2, c: 3 },
                    id: 1
                },
                expect.objectContaining({
                    authInfo: { token: 'test-token' },
                    request: expect.any(Request)
                })
            );

            const extra = (transport.onmessage as ReturnType<typeof vi.fn>).mock.calls[0]![1];
            expect(extra.request.url).toBe('http://localhost/messages');
        });
    });

    describe('close method', () => {
        it('should call onclose', async () => {
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);
            await transport.start();
            transport.onclose = vi.fn();
            await transport.close();
            expect(transport.onclose).toHaveBeenCalled();
        });
    });

    describe('send method', () => {
        it('should write SSE event', async () => {
            const mockRes = createMockResponse();
            const endpoint = '/messages';
            const transport = new SSEServerTransport(endpoint, mockRes);
            await transport.start();
            expect(mockRes.write).toHaveBeenCalledTimes(1);
            expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('event: endpoint'));
            expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining(`data: /messages?sessionId=${transport.sessionId}`));
        });

        it('should throw if not connected', async () => {
            const mockRes = createMockResponse();
            const transport = new SSEServerTransport('/messages', mockRes);
            const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test' };
            await expect(transport.send(message)).rejects.toThrow('Not connected');
        });

        it('should accept optional TransportSendOptions', async () => {
            const mockRes = createMockResponse();
            const transport = new SSEServerTransport('/messages', mockRes);
            await transport.start();

            const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test' };
            await transport.send(message, { relatedRequestId: 'req-1' });

            expect(mockRes.write).toHaveBeenCalledWith(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        });
    });

    describe('DNS rebinding protection', () => {
        beforeEach(() => {
            vi.clearAllMocks();
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
                    headers: { host: 'localhost:3000', 'content-type': 'application/json' }
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
                    headers: { host: 'evil.com', 'content-type': 'application/json' }
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
                    headers: { 'content-type': 'application/json' }
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
                    headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(202);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Accepted');
            });

            it('should accept requests without origin headers', async () => {
                const mockRes = createMockResponse();
                const transport = new SSEServerTransport('/messages', mockRes, {
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: true
                });
                await transport.start();

                const mockReq = createMockRequest({
                    headers: { 'content-type': 'application/json' }
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
                    headers: { origin: 'http://evil.com', 'content-type': 'application/json' }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(403);
                expect(mockHandleRes.end).toHaveBeenCalledWith('Invalid Origin header: http://evil.com');
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
                    headers: { host: 'evil.com', origin: 'http://evil.com', 'content-type': 'text/plain' }
                });
                const mockHandleRes = createMockResponse();

                await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

                expect(mockHandleRes.writeHead).toHaveBeenCalledWith(400);
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
                    headers: { host: 'localhost:3000', origin: 'http://evil.com', 'content-type': 'application/json' }
                });
                const mockHandleRes1 = createMockResponse();
                await transport.handlePostMessage(mockReq1, mockHandleRes1, { jsonrpc: '2.0', method: 'test' });
                expect(mockHandleRes1.writeHead).toHaveBeenCalledWith(403);
                expect(mockHandleRes1.end).toHaveBeenCalledWith('Invalid Origin header: http://evil.com');

                // Invalid host, valid origin
                const mockReq2 = createMockRequest({
                    headers: { host: 'evil.com', origin: 'http://localhost:3000', 'content-type': 'application/json' }
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
