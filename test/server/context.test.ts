import { z } from 'zod/v4';
import { Client } from '../../src/client/index.js';
import { McpServer, ResourceTemplate } from '../../src/server/mcp.js';
import { Context } from '../../src/server/context.js';
import {
    CallToolResultSchema,
    GetPromptResultSchema,
    ListResourcesResultSchema,
    LoggingMessageNotificationSchema,
    ReadResourceResultSchema,
    ServerNotification,
    ServerRequest
} from '../../src/types.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { RequestHandlerExtra } from '../../src/shared/protocol.js';

describe('Context', () => {
    /***
     * Test: `extra` provided to callbacks is Context (parameterized)
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
                        (_args: { name: string }, extra) => {
                            seen.isContext = extra instanceof Context;
                            seen.hasRequestId = !!extra.requestId;
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
                    mcpServer.registerResource('ctx-resource', 'test://res/1', { title: 'ctx-resource' }, async (_uri, extra) => {
                        seen.isContext = extra instanceof Context;
                        seen.hasRequestId = !!extra.requestId;
                        return { contents: [{ uri: 'test://res/1', mimeType: 'text/plain', text: 'hello' }] };
                    });
                },
                client => client.request({ method: 'resources/read', params: { uri: 'test://res/1' } }, ReadResourceResultSchema)
            ],
            [
                'resource template list',
                (mcpServer, seen) => {
                    const template = new ResourceTemplate('test://items/{id}', {
                        list: async extra => {
                            seen.isContext = extra instanceof Context;
                            seen.hasRequestId = !!extra.requestId;
                            return { resources: [] };
                        }
                    });
                    mcpServer.registerResource('ctx-template', template, { title: 'ctx-template' }, async (_uri, _vars, _extra) => ({
                        contents: []
                    }));
                },
                client => client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema)
            ],
            [
                'prompt',
                (mcpServer, seen) => {
                    mcpServer.registerPrompt('ctx-prompt', {}, async extra => {
                        seen.isContext = extra instanceof Context;
                        seen.hasRequestId = !!extra.requestId;
                        return { messages: [] };
                    });
                },
                client => client.request({ method: 'prompts/get', params: { name: 'ctx-prompt', arguments: {} } }, GetPromptResultSchema)
            ]
        ];

    test.each(contextCases)('should pass Context as extra to %s callbacks', async (_kind, register, trigger) => {
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
    it.each(logLevelsThroughContext)('should send logging message to client for %s level from Context', async level => {
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

        client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
            seen++;
            expect(notification.params.level).toBe(level);
            expect(notification.params.data).toBe('Test message');
            expect(notification.params.test).toBe('test');
            expect(notification.params.sessionId).toBe('sample-session-id');
            return;
        });

        mcpServer.registerTool('ctx-log-test', { inputSchema: z.object({ name: z.string() }) }, async (_args: { name: string }, extra) => {
            await extra[level]('Test message', { test: 'test' }, 'sample-session-id');
            await extra.log(
                {
                    level,
                    data: 'Test message',
                    logger: 'test-logger-namespace'
                },
                'sample-session-id'
            );
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
    describe('Legacy RequestHandlerExtra API', () => {
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
                        // The test is to ensure that the extra is compatible with the RequestHandlerExtra type
                        (_args: { name: string }, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
                            seen.isContext = extra instanceof Context;
                            seen.hasRequestId = !!extra.requestId;
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
                    // The test is to ensure that the extra is compatible with the RequestHandlerExtra type
                    mcpServer.registerResource(
                        'ctx-resource',
                        'test://res/1',
                        { title: 'ctx-resource' },
                        async (_uri, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
                            seen.isContext = extra instanceof Context;
                            seen.hasRequestId = !!extra.requestId;
                            return { contents: [{ uri: 'test://res/1', mimeType: 'text/plain', text: 'hello' }] };
                        }
                    );
                },
                client => client.request({ method: 'resources/read', params: { uri: 'test://res/1' } }, ReadResourceResultSchema)
            ],
            [
                'resource template list',
                (mcpServer, seen) => {
                    // The test is to ensure that the extra is compatible with the RequestHandlerExtra type
                    const template = new ResourceTemplate('test://items/{id}', {
                        list: async (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
                            seen.isContext = extra instanceof Context;
                            seen.hasRequestId = !!extra.requestId;
                            return { resources: [] };
                        }
                    });
                    mcpServer.registerResource('ctx-template', template, { title: 'ctx-template' }, async (_uri, _vars, _extra) => ({
                        contents: []
                    }));
                },
                client => client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema)
            ],
            [
                'prompt',
                (mcpServer, seen) => {
                    // The test is to ensure that the extra is compatible with the RequestHandlerExtra type
                    mcpServer.registerPrompt('ctx-prompt', {}, async (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
                        seen.isContext = extra instanceof Context;
                        seen.hasRequestId = !!extra.requestId;
                        return { messages: [] };
                    });
                },
                client => client.request({ method: 'prompts/get', params: { name: 'ctx-prompt', arguments: {} } }, GetPromptResultSchema)
            ]
        ];

        test.each(contextCases)('should pass Context as extra to %s callbacks', async (_kind, register, trigger) => {
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
