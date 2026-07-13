import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { LATEST_PROTOCOL_VERSION, McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import * as z from 'zod/v4';

function buildMcpServer(): McpServer {
    const mcpServer = new McpServer(
        { name: 'test-server', version: '1.0.0' },
        {
            capabilities: {
                logging: {},
                tools: {},
                resources: {},
                prompts: {}
            }
        }
    );

    // Add a simple resource
    mcpServer.registerResource('test-resource', '/test', { description: 'A test resource' }, async () => ({
        contents: [
            {
                uri: '/test',
                text: 'This is a test resource content'
            }
        ]
    }));

    mcpServer.registerPrompt('test-prompt', { description: 'A test prompt' }, async () => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'This is a test prompt'
                }
            }
        ]
    }));

    mcpServer.registerTool(
        'greet',
        {
            description: 'A simple greeting tool',
            inputSchema: z.object({
                name: z.string().describe('Name to greet').default('World')
            })
        },
        async ({ name }) => {
            return {
                content: [{ type: 'text', text: `Hello, ${name}!` }]
            };
        }
    );

    return mcpServer;
}

async function setupServer(): Promise<{
    server: Server;
    mcpServer: McpServer;
    serverTransport: NodeStreamableHTTPServerTransport;
    baseUrl: URL;
}> {
    const server: Server = createServer();
    const mcpServer = buildMcpServer();

    const serverTransport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID()
    });

    await mcpServer.connect(serverTransport);

    server.on('request', async (req, res) => {
        await serverTransport.handleRequest(req, res);
    });

    // Start the server on a random port
    const baseUrl = await listenOnRandomPort(server);

    return { server, mcpServer, serverTransport, baseUrl };
}

/**
 * Stateless hosting: each request gets a fresh transport + mcpServer pair (a
 * stateless transport throws when reused across requests). The per-request
 * mcpServer is closed after handling to release resources.
 */
async function setupStatelessServer(): Promise<{ server: Server; baseUrl: URL }> {
    const server: Server = createServer(async (req, res) => {
        try {
            const mcpServer = buildMcpServer();
            const serverTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await mcpServer.connect(serverTransport);
            res.on('close', () => {
                void mcpServer.close().catch(() => {});
            });
            await serverTransport.handleRequest(req, res);
        } catch (error) {
            console.error('Error handling request:', error);
            if (!res.headersSent) res.writeHead(500).end();
        }
    });

    const baseUrl = await listenOnRandomPort(server);

    return { server, baseUrl };
}

describe('Zod v4', () => {
    describe('Streamable HTTP Transport Session Management', () => {
        // Function to set up the server with optional session management
        describe('Stateless Mode', () => {
            let server: Server;
            let baseUrl: URL;

            beforeEach(async () => {
                const setup = await setupStatelessServer();
                server = setup.server;
                baseUrl = setup.baseUrl;
            });

            afterEach(async () => {
                // Clean up resources (per-request pairs are closed as their
                // responses complete).
                server.close();
            });

            it('should support multiple client connections', async () => {
                // Create and connect a client
                const client1 = new Client({
                    name: 'test-client',
                    version: '1.0.0'
                });

                const transport1 = new StreamableHTTPClientTransport(baseUrl);
                await client1.connect(transport1);

                // Verify that no session ID was set
                expect(transport1.sessionId).toBeUndefined();

                // List available tools
                await client1.request({
                    method: 'tools/list',
                    params: {}
                });

                const client2 = new Client({
                    name: 'test-client',
                    version: '1.0.0'
                });

                const transport2 = new StreamableHTTPClientTransport(baseUrl);
                await client2.connect(transport2);

                // Verify that no session ID was set
                expect(transport2.sessionId).toBeUndefined();

                // List available tools
                await client2.request({
                    method: 'tools/list',
                    params: {}
                });
            });
            it('should operate without session management', async () => {
                // Create and connect a client
                const client = new Client({
                    name: 'test-client',
                    version: '1.0.0'
                });

                const transport = new StreamableHTTPClientTransport(baseUrl);
                await client.connect(transport);

                // Verify that no session ID was set
                expect(transport.sessionId).toBeUndefined();

                // List available tools
                const toolsResult = await client.request({
                    method: 'tools/list',
                    params: {}
                });

                // Verify tools are accessible
                expect(toolsResult.tools).toContainEqual(
                    expect.objectContaining({
                        name: 'greet'
                    })
                );

                // List available resources
                const resourcesResult = await client.request({
                    method: 'resources/list',
                    params: {}
                });

                // Verify resources result structure
                expect(resourcesResult).toHaveProperty('resources');

                // List available prompts
                const promptsResult = await client.request({
                    method: 'prompts/list',
                    params: {}
                });

                // Verify prompts result structure
                expect(promptsResult).toHaveProperty('prompts');
                expect(promptsResult.prompts).toContainEqual(
                    expect.objectContaining({
                        name: 'test-prompt'
                    })
                );

                // Call the greeting tool
                const greetingResult = await client.request({
                    method: 'tools/call',
                    params: {
                        name: 'greet',
                        arguments: {
                            name: 'Stateless Transport'
                        }
                    }
                });

                // Verify tool result
                expect(greetingResult.content).toEqual([{ type: 'text', text: 'Hello, Stateless Transport!' }]);

                // Clean up
                await transport.close();
            });

            it('should set protocol version after connecting', async () => {
                // Create and connect a client
                const client = new Client({
                    name: 'test-client',
                    version: '1.0.0'
                });

                const transport = new StreamableHTTPClientTransport(baseUrl);

                // Verify protocol version is not set before connecting
                expect(transport.protocolVersion).toBeUndefined();

                await client.connect(transport);

                // Verify protocol version is set after connecting
                expect(transport.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

                // Clean up
                await transport.close();
            });
        });

        describe('Stateful Mode', () => {
            let server: Server;
            let mcpServer: McpServer;
            let serverTransport: NodeStreamableHTTPServerTransport;
            let baseUrl: URL;

            beforeEach(async () => {
                const setup = await setupServer();
                server = setup.server;
                mcpServer = setup.mcpServer;
                serverTransport = setup.serverTransport;
                baseUrl = setup.baseUrl;
            });

            afterEach(async () => {
                // Clean up resources
                await mcpServer.close().catch(() => {});
                await serverTransport.close().catch(() => {});
                server.close();
            });

            it('should operate with session management', async () => {
                // Create and connect a client
                const client = new Client({
                    name: 'test-client',
                    version: '1.0.0'
                });

                const transport = new StreamableHTTPClientTransport(baseUrl);
                await client.connect(transport);

                // Verify that a session ID was set
                expect(transport.sessionId).toBeDefined();
                expect(typeof transport.sessionId).toBe('string');

                // List available tools
                const toolsResult = await client.request({
                    method: 'tools/list',
                    params: {}
                });

                // Verify tools are accessible
                expect(toolsResult.tools).toContainEqual(
                    expect.objectContaining({
                        name: 'greet'
                    })
                );

                // List available resources
                const resourcesResult = await client.request({
                    method: 'resources/list',
                    params: {}
                });

                // Verify resources result structure
                expect(resourcesResult).toHaveProperty('resources');

                // List available prompts
                const promptsResult = await client.request({
                    method: 'prompts/list',
                    params: {}
                });

                // Verify prompts result structure
                expect(promptsResult).toHaveProperty('prompts');
                expect(promptsResult.prompts).toContainEqual(
                    expect.objectContaining({
                        name: 'test-prompt'
                    })
                );

                // Call the greeting tool
                const greetingResult = await client.request({
                    method: 'tools/call',
                    params: {
                        name: 'greet',
                        arguments: {
                            name: 'Stateful Transport'
                        }
                    }
                });

                // Verify tool result
                expect(greetingResult.content).toEqual([{ type: 'text', text: 'Hello, Stateful Transport!' }]);

                // Clean up
                await transport.close();
            });
        });
    });
});
