import { Client } from '@modelcontextprotocol/client';
import type { ContextInterface, ServerNotification, ServerRequest } from '@modelcontextprotocol/core';
import {
    CallToolResultSchema,
    GetPromptResultSchema,
    InMemoryTransport,
    ListResourcesResultSchema,
    ReadResourceResultSchema
} from '@modelcontextprotocol/core';
import { McpServer, ResourceTemplate, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

describe('ServerContext', () => {
    /***
     * Test: `ctx` provided to callbacks is ServerContext (parameterized)
     */
    type Seen = { isContext: boolean; hasRequestId: boolean };
    const contextCases: Array<[string, (mcpServer: McpServer, seen: Seen) => void | Promise<void>, (client: Client) => Promise<unknown>]> =
        [
            [
                'tool',
                (mcpServer, seen) => {
                    mcpServer.registerTool(
                        'ctx-tool',
                        {
                            inputSchema: z.object({ name: z.string() })
                        },
                        (_args: { name: string }, ctx) => {
                            seen.isContext = ctx instanceof ServerContext;
                            seen.hasRequestId = !!ctx.mcpReq.id;
                            return { content: [{ type: 'text', text: 'ok' }] };
                        }
                    );
                },
                client =>
                    client.request(
                        {
                            method: 'tools/call',
                            params: {
                                name: 'ctx-tool',
                                arguments: {
                                    name: 'ctx-tool-name'
                                }
                            }
                        },
                        CallToolResultSchema
                    )
            ],
            [
                'resource',
                (mcpServer, seen) => {
                    mcpServer.registerResource('ctx-resource', 'test://res/1', { title: 'ctx-resource' }, async (_uri, ctx) => {
                        seen.isContext = ctx instanceof ServerContext;
                        seen.hasRequestId = !!ctx.mcpReq.id;
                        return { contents: [{ uri: 'test://res/1', mimeType: 'text/plain', text: 'hello' }] };
                    });
                },
                client => client.request({ method: 'resources/read', params: { uri: 'test://res/1' } }, ReadResourceResultSchema)
            ],
            [
                'resource template list',
                (mcpServer, seen) => {
                    const template = new ResourceTemplate('test://items/{id}', {
                        list: async ctx => {
                            seen.isContext = ctx instanceof ServerContext;
                            seen.hasRequestId = !!ctx.mcpReq.id;
                            return { resources: [] };
                        }
                    });
                    mcpServer.registerResource('ctx-template', template, { title: 'ctx-template' }, async (_uri, _vars, _ctx) => ({
                        contents: []
                    }));
                },
                client => client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema)
            ],
            [
                'prompt',
                (mcpServer, seen) => {
                    mcpServer.registerPrompt('ctx-prompt', {}, async ctx => {
                        seen.isContext = ctx instanceof ServerContext;
                        seen.hasRequestId = !!ctx.mcpReq.id;
                        return { messages: [] };
                    });
                },
                client => client.request({ method: 'prompts/get', params: { name: 'ctx-prompt', arguments: {} } }, GetPromptResultSchema)
            ]
        ];

    test.each(contextCases)('should pass ServerContext as ctx to %s callbacks', async (_kind, register, trigger) => {
        const mcpServer = new McpServer({ name: 'ctx-test', version: '1.0' });
        const client = new Client({ name: 'ctx-client', version: '1.0' });

        const seen: Seen = { isContext: false, hasRequestId: false };

        await register(mcpServer, seen);

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

        await trigger(client);

        expect(seen.isContext).toBe(true);
        expect(seen.hasRequestId).toBe(true);
    });

    const logLevelsThroughContext = ['debug', 'info', 'warning', 'error'] as const;

    //it.each for each log level, test that logging message is sent to client
    it.each(logLevelsThroughContext)('should send logging message to client for %s level from ServerContext', async level => {
        const mcpServer = new McpServer(
            { name: 'ctx-test', version: '1.0' },
            {
                capabilities: {
                    logging: {}
                }
            }
        );
        const client = new Client(
            { name: 'ctx-client', version: '1.0' },
            {
                capabilities: {}
            }
        );

        let seen = 0;

        client.setNotificationHandler('notifications/message', notification => {
            seen++;
            expect(notification.params.level).toBe(level);
            return;
        });

        mcpServer.registerTool('ctx-log-test', { inputSchema: z.object({ name: z.string() }) }, async (_args: { name: string }, ctx) => {
            const serverCtx = ctx as ServerContext;
            // Use the new notification API (no sessionId parameter)
            await serverCtx.notification[level]('Test message', { test: 'test' });
            await serverCtx.notification.log({
                level,
                data: 'Test message',
                logger: 'test-logger-namespace'
            });
            return { content: [{ type: 'text', text: 'ok' }] };
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

        const result = await client.request(
            {
                method: 'tools/call',
                params: { name: 'ctx-log-test', arguments: { name: 'ctx-log-test-name' } }
            },
            CallToolResultSchema
        );

        // two messages should have been sent - one from the .log method and one from the .debug/info/warning/error method
        expect(seen).toBe(2);

        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toMatchObject({
            type: 'text',
            text: 'ok'
        });
    });
    describe('ContextInterface API', () => {
        const contextCases: Array<
            [string, (mcpServer: McpServer, seen: Seen) => void | Promise<void>, (client: Client) => Promise<unknown>]
        > = [
            [
                'tool',
                (mcpServer, seen) => {
                    mcpServer.registerTool(
                        'ctx-tool',
                        {
                            inputSchema: z.object({ name: z.string() })
                        },
                        // The test is to ensure that the ctx is compatible with the ContextInterface type
                        (_args: { name: string }, ctx: ContextInterface<ServerRequest, ServerNotification>) => {
                            seen.isContext = ctx instanceof ServerContext;
                            seen.hasRequestId = !!ctx.mcpReq.id;
                            return { content: [{ type: 'text', text: 'ok' }] };
                        }
                    );
                },
                client =>
                    client.request(
                        {
                            method: 'tools/call',
                            params: {
                                name: 'ctx-tool',
                                arguments: {
                                    name: 'ctx-tool-name'
                                }
                            }
                        },
                        CallToolResultSchema
                    )
            ],
            [
                'resource',
                (mcpServer, seen) => {
                    // The test is to ensure that the ctx is compatible with the ContextInterface type
                    mcpServer.registerResource(
                        'ctx-resource',
                        'test://res/1',
                        { title: 'ctx-resource' },
                        async (_uri, ctx: ContextInterface<ServerRequest, ServerNotification>) => {
                            seen.isContext = ctx instanceof ServerContext;
                            seen.hasRequestId = !!ctx.mcpReq.id;
                            return { contents: [{ uri: 'test://res/1', mimeType: 'text/plain', text: 'hello' }] };
                        }
                    );
                },
                client => client.request({ method: 'resources/read', params: { uri: 'test://res/1' } }, ReadResourceResultSchema)
            ],
            [
                'resource template list',
                (mcpServer, seen) => {
                    // The test is to ensure that the ctx is compatible with the ContextInterface type
                    const template = new ResourceTemplate('test://items/{id}', {
                        list: async (ctx: ContextInterface<ServerRequest, ServerNotification>) => {
                            seen.isContext = ctx instanceof ServerContext;
                            seen.hasRequestId = !!ctx.mcpReq.id;
                            return { resources: [] };
                        }
                    });
                    mcpServer.registerResource('ctx-template', template, { title: 'ctx-template' }, async (_uri, _vars, _ctx) => ({
                        contents: []
                    }));
                },
                client => client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema)
            ],
            [
                'prompt',
                (mcpServer, seen) => {
                    // The test is to ensure that the ctx is compatible with the ContextInterface type
                    mcpServer.registerPrompt('ctx-prompt', {}, async (ctx: ContextInterface<ServerRequest, ServerNotification>) => {
                        seen.isContext = ctx instanceof ServerContext;
                        seen.hasRequestId = !!ctx.mcpReq.id;
                        return { messages: [] };
                    });
                },
                client => client.request({ method: 'prompts/get', params: { name: 'ctx-prompt', arguments: {} } }, GetPromptResultSchema)
            ]
        ];

        test.each(contextCases)('should pass ServerContext as ctx to %s callbacks', async (_kind, register, trigger) => {
            const mcpServer = new McpServer({ name: 'ctx-test', version: '1.0' });
            const client = new Client({ name: 'ctx-client', version: '1.0' });

            const seen: Seen = { isContext: false, hasRequestId: false };

            await register(mcpServer, seen);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

            await trigger(client);

            expect(seen.isContext).toBe(true);
            expect(seen.hasRequestId).toBe(true);
        });
    });
});
