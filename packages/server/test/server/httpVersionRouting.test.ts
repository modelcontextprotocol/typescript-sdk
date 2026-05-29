import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod/v4';
import type {
    CallToolResult,
    GetPromptResult,
    JSONRPCErrorResponse,
    ListPromptsResult,
    ListResourcesResult,
    ListToolsResult,
    ReadResourceResult
} from '@modelcontextprotocol/core';
import { McpServer } from '../../src/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/modernStreamableHttp.js';

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

describe('WebStandardStreamableHTTPServerTransport', () => {
    let server: McpServer;
    let transport: WebStandardStreamableHTTPServerTransport;

    beforeEach(async () => {
        server = new McpServer({ name: 'test-server', version: '1.0.0' });

        server.registerTool('greet', { description: 'Greet someone', inputSchema: { name: z.string() } }, async ({ name }) => ({
            content: [{ type: 'text', text: `Hello, ${name}!` }]
        }));

        server.registerResource('test-resource', 'test://doc', { description: 'A test resource' }, async () => ({
            contents: [{ uri: 'test://doc', text: 'Resource content here' }]
        }));

        server.registerPrompt('test-prompt', { description: 'A test prompt' }, async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Hello from prompt' } }]
        }));

        transport = new WebStandardStreamableHTTPServerTransport({
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

        it('handles resources/list', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'resources/list',
                        'MCP-Protocol-Version': '2026-06-30'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'resources/list',
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
            const body = (await response.json()) as JsonRpcOk<ListResourcesResult>;
            expect(body.result.result_type).toBe('complete');
            expect(body.result.resources).toMatchObject([{ uri: 'test://doc', name: 'test-resource' }]);
        });

        it('handles resources/read', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'resources/read',
                        'MCP-Protocol-Version': '2026-06-30'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'resources/read',
                        params: {
                            uri: 'test://doc',
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
            const body = (await response.json()) as JsonRpcOk<ReadResourceResult>;
            expect(body.result.result_type).toBe('complete');
            expect(body.result.contents).toMatchObject([{ uri: 'test://doc', text: 'Resource content here' }]);
        });

        it('handles prompts/list', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'prompts/list',
                        'MCP-Protocol-Version': '2026-06-30'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'prompts/list',
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
            const body = (await response.json()) as JsonRpcOk<ListPromptsResult>;
            expect(body.result.result_type).toBe('complete');
            expect(body.result.prompts).toMatchObject([{ name: 'test-prompt' }]);
        });

        it('handles prompts/get', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Method': 'prompts/get',
                        'MCP-Protocol-Version': '2026-06-30'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'prompts/get',
                        params: {
                            name: 'test-prompt',
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
            const body = (await response.json()) as JsonRpcOk<GetPromptResult>;
            expect(body.result.result_type).toBe('complete');
            expect(body.result.messages).toMatchObject([{ role: 'user', content: { type: 'text', text: 'Hello from prompt' } }]);
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

        it('handles DELETE for session termination', async () => {
            // Initialize a session
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

            // Send DELETE
            const deleteResponse = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'DELETE',
                    headers: { 'Mcp-Session-Id': sessionId }
                })
            );

            expect(deleteResponse.status).toBe(200);

            // Session should be gone — subsequent request returns 404
            const afterDelete = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'Mcp-Session-Id': sessionId
                    },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
                })
            );

            expect(afterDelete.status).toBe(404);
        });

        it('rejects GET without session ID', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'GET',
                    headers: {}
                })
            );

            expect(response.status).toBe(400);
        });

        it('rejects DELETE without session ID', async () => {
            const response = await transport.handleRequest(
                new Request('http://localhost/mcp', {
                    method: 'DELETE',
                    headers: {}
                })
            );

            expect(response.status).toBe(400);
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
