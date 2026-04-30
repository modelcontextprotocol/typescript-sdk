/**
 * Shared MCP conformance server setup. Registers all tools/resources/prompts on a
 * fresh {@linkcode McpServer}. Consumed by both conformance entry points so the
 * dual-target harness exercises the same handler set against:
 *  - {@linkcode ./everythingServer.ts} — `transport.connect()` / `NodeStreamableHTTPServerTransport`
 *  - {@linkcode ./everythingServerHandleHttp.ts} — `handleHttp()` / `shttpHandler`
 */

import { randomUUID } from 'node:crypto';

import type {
    CallToolResult,
    EventId,
    EventStore,
    GetPromptResult,
    ReadResourceResult,
    ServerContext,
    StreamId
} from '@modelcontextprotocol/server';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const resourceSubscriptions = new Set<string>();
const watchedResourceContent = 'Watched resource content';

/** Sample base64-encoded 1×1 red PNG pixel for testing. */
export const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/** Sample base64-encoded minimal WAV file for testing. */
export const TEST_AUDIO_BASE64 = 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAA=';

/** In-memory {@linkcode EventStore} for SEP-1699 SSE resumability. */
export function createEventStore(): EventStore {
    const data = new Map<string, { eventId: string; message: unknown; streamId: string }>();
    return {
        async storeEvent(streamId: StreamId, message: unknown): Promise<EventId> {
            const eventId = `${streamId}::${Date.now()}_${randomUUID()}`;
            data.set(eventId, { eventId, message, streamId });
            return eventId;
        },
        async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
            return data.get(eventId)?.streamId;
        },
        async replayEventsAfter(
            lastEventId: EventId,
            { send }: { send: (eventId: EventId, message: unknown) => Promise<void> }
        ): Promise<StreamId> {
            const streamId = lastEventId.split('::')[0] || lastEventId;
            const eventsToReplay: Array<[string, { message: unknown }]> = [];
            for (const [eventId, ev] of data.entries()) {
                if (ev.streamId === streamId && eventId > lastEventId) {
                    eventsToReplay.push([eventId, ev]);
                }
            }
            eventsToReplay.sort(([a], [b]) => a.localeCompare(b));
            for (const [eventId, { message }] of eventsToReplay) {
                if (message && typeof message === 'object' && Object.keys(message).length > 0) {
                    await send(eventId, message);
                }
            }
            return streamId;
        }
    };
}

export interface SetupOptions {
    /**
     * Hook for the SEP-1699 reconnection test. Called mid-handler to forcibly close the
     * current SSE stream so the client must reconnect with `Last-Event-ID`.
     * The two entry points wire this differently (transport-map lookup vs `ctx.http?.closeSSE`).
     */
    closeSSEForReconnectTest: (ctx: ServerContext) => void;
}

/**
 * Builds a fully-registered conformance {@linkcode McpServer}. All registrations are
 * stateless on the server instance, so the entry point decides whether to create one
 * per session (transport.connect path) or one shared instance (handleHttp path).
 */
export function createMcpServer(opts: SetupOptions): McpServer {
    const mcpServer = new McpServer(
        { name: 'mcp-conformance-test-server', version: '1.0.0' },
        {
            capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true },
                prompts: { listChanged: true },
                logging: {},
                completions: {}
            }
        }
    );

    function sendLog(
        level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency',
        message: string,
        _data?: unknown
    ) {
        mcpServer.server
            .notification({ method: 'notifications/message', params: { level, logger: 'conformance-test-server', data: _data || message } })
            .catch(() => {
                // Ignore error if no client is connected.
            });
    }

    // ===== TOOLS =====

    mcpServer.registerTool('test_simple_text', { description: 'Tests simple text content response' }, async (): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: 'This is a simple text response for testing.' }] };
    });

    mcpServer.registerTool('test_image_content', { description: 'Tests image content response' }, async (): Promise<CallToolResult> => {
        return { content: [{ type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' }] };
    });

    mcpServer.registerTool('test_audio_content', { description: 'Tests audio content response' }, async (): Promise<CallToolResult> => {
        return { content: [{ type: 'audio', data: TEST_AUDIO_BASE64, mimeType: 'audio/wav' }] };
    });

    mcpServer.registerTool(
        'test_embedded_resource',
        { description: 'Tests embedded resource content response' },
        async (): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: 'resource',
                        resource: { uri: 'test://embedded-resource', mimeType: 'text/plain', text: 'This is an embedded resource content.' }
                    }
                ]
            };
        }
    );

    mcpServer.registerTool(
        'test_multiple_content_types',
        { description: 'Tests response with multiple content types (text, image, resource)' },
        async (): Promise<CallToolResult> => {
            return {
                content: [
                    { type: 'text', text: 'Multiple content types test:' },
                    { type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' },
                    {
                        type: 'resource',
                        resource: {
                            uri: 'test://mixed-content-resource',
                            mimeType: 'application/json',
                            text: JSON.stringify({ test: 'data', value: 123 })
                        }
                    }
                ]
            };
        }
    );

    mcpServer.registerTool(
        'test_tool_with_logging',
        { description: 'Tests tool that emits log messages during execution', inputSchema: z.object({}) },
        async (_args, ctx): Promise<CallToolResult> => {
            await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: 'Tool execution started' } });
            await new Promise(resolve => setTimeout(resolve, 50));
            await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: 'Tool processing data' } });
            await new Promise(resolve => setTimeout(resolve, 50));
            await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: 'Tool execution completed' } });
            return { content: [{ type: 'text', text: 'Tool with logging executed successfully' }] };
        }
    );

    mcpServer.registerTool(
        'test_tool_with_progress',
        { description: 'Tests tool that reports progress notifications', inputSchema: z.object({}) },
        async (_args, ctx): Promise<CallToolResult> => {
            const progressToken = ctx.mcpReq._meta?.progressToken ?? 0;
            console.log('Progress token:', progressToken);
            for (const progress of [0, 50, 100]) {
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: { progressToken, progress, total: 100, message: `Completed step ${progress} of ${100}` }
                });
                if (progress !== 100) await new Promise(resolve => setTimeout(resolve, 50));
            }
            return { content: [{ type: 'text', text: String(progressToken) }] };
        }
    );

    mcpServer.registerTool('test_error_handling', { description: 'Tests error response handling' }, async (): Promise<CallToolResult> => {
        throw new Error('This tool intentionally returns an error for testing');
    });

    mcpServer.registerTool(
        'test_reconnection',
        {
            description:
                'Tests SSE stream disconnection and client reconnection (SEP-1699). Server will close the stream mid-call and send the result after client reconnects.',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
            const sid = ctx.sessionId;
            console.log(`[${sid}] Starting test_reconnection tool...`);
            console.log(`[${sid}] Closing SSE stream to trigger client polling...`);
            opts.closeSSEForReconnectTest(ctx);
            await sleep(100);
            console.log(`[${sid}] test_reconnection tool complete`);
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Reconnection test completed successfully. If you received this, the client properly reconnected after stream closure.'
                    }
                ]
            };
        }
    );

    mcpServer.registerTool(
        'test_sampling',
        {
            description: 'Tests server-initiated sampling (LLM completion request)',
            inputSchema: z.object({ prompt: z.string().describe('The prompt to send to the LLM') })
        },
        async (args: { prompt: string }, ctx): Promise<CallToolResult> => {
            try {
                const result = (await ctx.mcpReq.send({
                    method: 'sampling/createMessage',
                    params: { messages: [{ role: 'user', content: { type: 'text', text: args.prompt } }], maxTokens: 100 }
                })) as { content?: { text?: string }; message?: { content?: { text?: string } } };
                const modelResponse = result.content?.text || result.message?.content?.text || 'No response';
                return { content: [{ type: 'text', text: `LLM response: ${modelResponse}` }] };
            } catch (error) {
                return {
                    content: [
                        { type: 'text', text: `Sampling not supported or error: ${error instanceof Error ? error.message : String(error)}` }
                    ]
                };
            }
        }
    );

    mcpServer.registerTool(
        'test_elicitation',
        {
            description: 'Tests server-initiated elicitation (user input request)',
            inputSchema: z.object({ message: z.string().describe('The message to show the user') })
        },
        async (args: { message: string }, ctx): Promise<CallToolResult> => {
            try {
                const result = await ctx.mcpReq.send({
                    method: 'elicitation/create',
                    params: {
                        message: args.message,
                        requestedSchema: {
                            type: 'object',
                            properties: { response: { type: 'string', description: "User's response" } },
                            required: ['response']
                        }
                    }
                });
                const elicitResult = result as { action?: string; content?: unknown };
                return {
                    content: [
                        {
                            type: 'text',
                            text: `User response: action=${elicitResult.action}, content=${JSON.stringify(elicitResult.content || {})}`
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation not supported or error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        }
    );

    mcpServer.registerTool(
        'test_elicitation_sep1034_defaults',
        { description: 'Tests elicitation with default values per SEP-1034', inputSchema: z.object({}) },
        async (_args, ctx): Promise<CallToolResult> => {
            try {
                const result = await ctx.mcpReq.send({
                    method: 'elicitation/create',
                    params: {
                        message: 'Please review and update the form fields with defaults',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'User name', default: 'John Doe' },
                                age: { type: 'integer', description: 'User age', default: 30 },
                                score: { type: 'number', description: 'User score', default: 95.5 },
                                status: {
                                    type: 'string',
                                    description: 'User status',
                                    enum: ['active', 'inactive', 'pending'],
                                    default: 'active'
                                },
                                verified: { type: 'boolean', description: 'Verification status', default: true }
                            },
                            required: []
                        }
                    }
                });
                const elicitResult = result as { action?: string; content?: unknown };
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation completed: action=${elicitResult.action}, content=${JSON.stringify(elicitResult.content || {})}`
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation not supported or error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        }
    );

    mcpServer.registerTool(
        'test_elicitation_sep1330_enums',
        { description: 'Tests elicitation with enum schema improvements per SEP-1330', inputSchema: z.object({}) },
        async (_args, ctx): Promise<CallToolResult> => {
            try {
                const result = await ctx.mcpReq.send({
                    method: 'elicitation/create',
                    params: {
                        message: 'Please select options from the enum fields',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                untitledSingle: {
                                    type: 'string',
                                    description: 'Select one option',
                                    enum: ['option1', 'option2', 'option3']
                                },
                                titledSingle: {
                                    type: 'string',
                                    description: 'Select one option with titles',
                                    oneOf: [
                                        { const: 'value1', title: 'First Option' },
                                        { const: 'value2', title: 'Second Option' },
                                        { const: 'value3', title: 'Third Option' }
                                    ]
                                },
                                legacyEnum: {
                                    type: 'string',
                                    description: 'Select one option (legacy)',
                                    enum: ['opt1', 'opt2', 'opt3'],
                                    enumNames: ['Option One', 'Option Two', 'Option Three']
                                },
                                untitledMulti: {
                                    type: 'array',
                                    description: 'Select multiple options',
                                    minItems: 1,
                                    maxItems: 3,
                                    items: { type: 'string', enum: ['option1', 'option2', 'option3'] }
                                },
                                titledMulti: {
                                    type: 'array',
                                    description: 'Select multiple options with titles',
                                    minItems: 1,
                                    maxItems: 3,
                                    items: {
                                        anyOf: [
                                            { const: 'value1', title: 'First Choice' },
                                            { const: 'value2', title: 'Second Choice' },
                                            { const: 'value3', title: 'Third Choice' }
                                        ]
                                    }
                                }
                            },
                            required: []
                        }
                    }
                });
                const elicitResult = result as { action?: string; content?: unknown };
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation completed: action=${elicitResult.action}, content=${JSON.stringify(elicitResult.content || {})}`
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation not supported or error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        }
    );

    mcpServer.registerTool(
        'json_schema_2020_12_tool',
        {
            description: 'Tool with JSON Schema 2020-12 features for conformance testing (SEP-1613)',
            inputSchema: z.object({
                name: z.string().optional(),
                address: z.object({ street: z.string().optional(), city: z.string().optional() }).optional()
            })
        },
        async (args: { name?: string; address?: { street?: string; city?: string } }): Promise<CallToolResult> => {
            return { content: [{ type: 'text', text: `JSON Schema 2020-12 tool called with: ${JSON.stringify(args)}` }] };
        }
    );

    // ===== RESOURCES =====

    mcpServer.registerResource(
        'static-text',
        'test://static-text',
        { title: 'Static Text Resource', description: 'A static text resource for testing', mimeType: 'text/plain' },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [{ uri: 'test://static-text', mimeType: 'text/plain', text: 'This is the content of the static text resource.' }]
            };
        }
    );

    mcpServer.registerResource(
        'static-binary',
        'test://static-binary',
        { title: 'Static Binary Resource', description: 'A static binary resource (image) for testing', mimeType: 'image/png' },
        async (): Promise<ReadResourceResult> => {
            return { contents: [{ uri: 'test://static-binary', mimeType: 'image/png', blob: TEST_IMAGE_BASE64 }] };
        }
    );

    mcpServer.registerResource(
        'template',
        new ResourceTemplate('test://template/{id}/data', { list: undefined }),
        { title: 'Resource Template', description: 'A resource template with parameter substitution', mimeType: 'application/json' },
        async (uri, variables): Promise<ReadResourceResult> => {
            const id = variables.id;
            return {
                contents: [
                    {
                        uri: uri.toString(),
                        mimeType: 'application/json',
                        text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${id}` })
                    }
                ]
            };
        }
    );

    mcpServer.registerResource(
        'watched-resource',
        'test://watched-resource',
        { title: 'Watched Resource', description: 'A resource that auto-updates every 3 seconds', mimeType: 'text/plain' },
        async (): Promise<ReadResourceResult> => {
            return { contents: [{ uri: 'test://watched-resource', mimeType: 'text/plain', text: watchedResourceContent }] };
        }
    );

    mcpServer.server.setRequestHandler('resources/subscribe', async request => {
        const uri = request.params.uri;
        resourceSubscriptions.add(uri);
        sendLog('info', `Subscribed to resource: ${uri}`);
        return {};
    });

    mcpServer.server.setRequestHandler('resources/unsubscribe', async request => {
        const uri = request.params.uri;
        resourceSubscriptions.delete(uri);
        sendLog('info', `Unsubscribed from resource: ${uri}`);
        return {};
    });

    // ===== PROMPTS =====

    mcpServer.registerPrompt(
        'test_simple_prompt',
        { title: 'Simple Test Prompt', description: 'A simple prompt without arguments' },
        async (): Promise<GetPromptResult> => {
            return { messages: [{ role: 'user', content: { type: 'text', text: 'This is a simple prompt for testing.' } }] };
        }
    );

    mcpServer.registerPrompt(
        'test_prompt_with_arguments',
        {
            title: 'Prompt With Arguments',
            description: 'A prompt with required arguments',
            argsSchema: z.object({ arg1: z.string().describe('First test argument'), arg2: z.string().describe('Second test argument') })
        },
        async (args: { arg1: string; arg2: string }): Promise<GetPromptResult> => {
            return {
                messages: [
                    { role: 'user', content: { type: 'text', text: `Prompt with arguments: arg1='${args.arg1}', arg2='${args.arg2}'` } }
                ]
            };
        }
    );

    mcpServer.registerPrompt(
        'test_prompt_with_embedded_resource',
        {
            title: 'Prompt With Embedded Resource',
            description: 'A prompt that includes an embedded resource',
            argsSchema: z.object({ resourceUri: z.string().describe('URI of the resource to embed') })
        },
        async (args: { resourceUri: string }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'resource',
                            resource: { uri: args.resourceUri, mimeType: 'text/plain', text: 'Embedded resource content for testing.' }
                        }
                    },
                    { role: 'user', content: { type: 'text', text: 'Please process the embedded resource above.' } }
                ]
            };
        }
    );

    mcpServer.registerPrompt(
        'test_prompt_with_image',
        { title: 'Prompt With Image', description: 'A prompt that includes image content' },
        async (): Promise<GetPromptResult> => {
            return {
                messages: [
                    { role: 'user', content: { type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' } },
                    { role: 'user', content: { type: 'text', text: 'Please analyze the image above.' } }
                ]
            };
        }
    );

    // ===== LOGGING =====

    mcpServer.server.setRequestHandler('logging/setLevel', async request => {
        const level = request.params.level;
        sendLog('info', `Log level set to: ${level}`);
        return {};
    });

    // ===== COMPLETION =====

    mcpServer.server.setRequestHandler('completion/complete', async () => {
        return { completion: { values: [], total: 0, hasMore: false } };
    });

    return mcpServer;
}
