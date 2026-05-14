import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod/v4';
import type { CallToolResult, JSONRPCErrorResponse, ListToolsResult } from '@modelcontextprotocol/core';
import { McpServer } from '../../src/server/mcp.js';
import { HTTPVersionRoutingTransport } from '../../src/server/httpVersionRoutingTransport.js';

interface DiscoverResult {
    supportedVersions: string[];
    serverInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
}
interface JsonRpcOk<T> {
    jsonrpc: '2.0';
    id: number;
    result: T & { result_type?: string };
}
type JsonRpcErr = JSONRPCErrorResponse;

describe('HTTPVersionRoutingTransport', () => {
    let server: McpServer;
    let transport: HTTPVersionRoutingTransport;

    beforeEach(async () => {
        server = new McpServer({ name: 'test-server', version: '1.0.0' });

        server.registerTool('greet', { description: 'Greet someone', inputSchema: { name: z.string() } }, async ({ name }) => ({
            content: [{ type: 'text', text: `Hello, ${name}!` }]
        }));

        transport = new HTTPVersionRoutingTransport({
            sessionIdGenerator: () => crypto.randomUUID()
        });

        await server.connect(transport);
    });

    describe('modern 2026-06 path', () => {
        it('handles server/discover', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'server/discover',
                        'MCP-Protocol-Version': '2026-06-30'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'server/discover',
                        params: {
                            _meta: {
                                protocolVersion: '2026-06-30',
                                clientCapabilities: {},
                                clientInfo: { name: 'test-client', version: '1.0.0' }
                            }
                        }
                    })
                })
            );

            expect(response.status).toBe(200);
            const body = (await response.json()) as JsonRpcOk<DiscoverResult>;
            expect(body.result.supportedVersions).toContain('2026-06-30');
            expect(body.result.serverInfo.name).toBe('test-server');
            expect(body.result.capabilities).toBeDefined();
        });

        it('handles tools/call', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'tools/call',
                        'MCP-Protocol-Version': '2026-06-30'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'tools/call',
                        params: {
                            name: 'greet',
                            arguments: { name: 'World' },
                            _meta: {
                                protocolVersion: '2026-06-30',
                                clientCapabilities: {},
                                clientInfo: { name: 'test-client', version: '1.0.0' }
                            }
                        }
                    })
                })
            );

            expect(response.status).toBe(200);
            const body = (await response.json()) as JsonRpcOk<CallToolResult>;
            expect(body.result.result_type).toBe('complete');
            expect(body.result.content).toMatchObject([{ type: 'text', text: 'Hello, World!' }]);
        });

        it('handles tools/list', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'tools/list',
                        'MCP-Protocol-Version': '2026-06-30'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'tools/list',
                        params: {
                            _meta: {
                                protocolVersion: '2026-06-30',
                                clientCapabilities: {},
                                clientInfo: { name: 'test-client', version: '1.0.0' }
                            }
                        }
                    })
                })
            );

            expect(response.status).toBe(200);
            const body = (await response.json()) as JsonRpcOk<ListToolsResult>;
            expect(body.result.result_type).toBe('complete');
            expect(body.result.tools).toHaveLength(1);
            expect(body.result.tools).toMatchObject([{ name: 'greet' }]);
        });

        it('returns method not found for unknown methods', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'unknown/method',
                        'MCP-Protocol-Version': '2026-06-30'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'unknown/method',
                        params: {
                            _meta: { protocolVersion: '2026-06-30' }
                        }
                    })
                })
            );

            expect(response.status).toBe(200);
            const body = (await response.json()) as JsonRpcErr;
            expect(body.error.code).toBe(-32601);
        });

        it('rejects wrong Content-Type', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain',
                        'Mcp-Method': 'tools/call'
                    },
                    body: 'not json'
                })
            );

            expect(response.status).toBe(415);
        });

        it('rejects non-POST methods', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'GET',
                    headers: { 'Mcp-Method': 'server/discover' }
                })
            );

            expect(response.status).toBe(405);
        });

        it('rejects batch requests', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'tools/call'
                    },
                    body: JSON.stringify([
                        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
                        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
                    ])
                })
            );

            expect(response.status).toBe(400);
            const body = (await response.json()) as JsonRpcErr;
            expect(body.error.message).toContain('Batch');
        });
    });

    describe('legacy 2025-11 path', () => {
        it('handles initialize + tools/call', async () => {
            // Step 1: Initialize
            const initResponse = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'initialize',
                        params: {
                            protocolVersion: '2025-11-25',
                            capabilities: {},
                            clientInfo: { name: 'legacy-client', version: '1.0.0' }
                        }
                    })
                })
            );

            const sessionId = initResponse.headers.get('mcp-session-id');
            expect(sessionId).toBeDefined();

            // Step 2: Send initialized notification
            await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'Mcp-Session-Id': sessionId!
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'notifications/initialized'
                    })
                })
            );

            // Step 3: Call tool
            const toolResponse = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'Mcp-Session-Id': sessionId!
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 2,
                        method: 'tools/call',
                        params: {
                            name: 'greet',
                            arguments: { name: 'World' }
                        }
                    })
                })
            );

            // The response could be SSE or JSON depending on transport config
            // For SSE, we need to parse the event stream
            const contentType = toolResponse.headers.get('content-type');
            if (contentType?.includes('text/event-stream')) {
                const text = await toolResponse.text();
                const dataLines = text.split('\n').filter(line => line.startsWith('data: '));
                const lastData = dataLines[dataLines.length - 1]!;
                const parsed = JSON.parse(lastData.replace('data: ', '')) as JsonRpcOk<CallToolResult>;
                expect(parsed.result.content).toMatchObject([{ type: 'text', text: 'Hello, World!' }]);
            } else {
                const body = (await toolResponse.json()) as JsonRpcOk<CallToolResult>;
                expect(body.result.content).toMatchObject([{ type: 'text', text: 'Hello, World!' }]);
            }
        });

        it('returns 404 for unknown session ID', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'Mcp-Session-Id': 'nonexistent-session'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'tools/list',
                        params: {}
                    })
                })
            );

            expect(response.status).toBe(404);
        });
    });

    describe('same tool on both paths', () => {
        it('returns identical content for the same tool call', async () => {
            // Modern path
            const modernResponse = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'tools/call',
                        'MCP-Protocol-Version': '2026-06-30'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'tools/call',
                        params: {
                            name: 'greet',
                            arguments: { name: 'Alice' },
                            _meta: {
                                protocolVersion: '2026-06-30',
                                clientCapabilities: {},
                                clientInfo: { name: 'test-client', version: '1.0.0' }
                            }
                        }
                    })
                })
            );
            const modernBody = (await modernResponse.json()) as JsonRpcOk<CallToolResult>;

            // Legacy path: initialize first
            const initResponse = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'initialize',
                        params: {
                            protocolVersion: '2025-11-25',
                            capabilities: {},
                            clientInfo: { name: 'legacy-client', version: '1.0.0' }
                        }
                    })
                })
            );
            const sessionId = initResponse.headers.get('mcp-session-id')!;

            await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'Mcp-Session-Id': sessionId
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'notifications/initialized'
                    })
                })
            );

            const legacyResponse = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'Mcp-Session-Id': sessionId
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 2,
                        method: 'tools/call',
                        params: {
                            name: 'greet',
                            arguments: { name: 'Alice' }
                        }
                    })
                })
            );

            // Extract legacy result (may be SSE or JSON)
            let legacyContent;
            const contentType = legacyResponse.headers.get('content-type');
            if (contentType?.includes('text/event-stream')) {
                const text = await legacyResponse.text();
                const dataLines = text.split('\n').filter(line => line.startsWith('data: '));
                const lastData = dataLines[dataLines.length - 1]!;
                const parsed = JSON.parse(lastData.replace('data: ', '')) as JsonRpcOk<CallToolResult>;
                legacyContent = parsed.result.content;
            } else {
                const body = (await legacyResponse.json()) as JsonRpcOk<CallToolResult>;
                legacyContent = body.result.content;
            }

            // Both paths should return the same content
            expect(modernBody.result.content).toEqual(legacyContent);
            expect(modernBody.result.content).toMatchObject([{ type: 'text', text: 'Hello, Alice!' }]);
        });
    });
});
