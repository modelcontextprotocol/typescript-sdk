#!/usr/bin/env node

/**
 * MCP Conformance Test Server
 *
 * Server implementing all MCP features for conformance testing.
 * This server is designed to pass all conformance test scenarios.
 */

import { randomUUID } from 'node:crypto';

import type { CallToolResult, GetPromptResult, ReadResourceResult, EventId, EventStore, StreamId } from '@modelcontextprotocol/server';
import { ElicitResultSchema, isInitializeRequest, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { Request, Response } from 'express';
import cors from 'cors';
import express from 'express';
import * as z from 'zod/v4';

// Server state
const resourceSubscriptions = new Set<string>();
const watchedResourceContent = 'Watched resource content';

// Session management
const transports: { [sessionId: string]: NodeStreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: McpServer } = {};

// In-memory event store for SEP-1699 resumability
const eventStoreData = new Map<string, { eventId: string; message: unknown; streamId: string }>();

function createEventStore(): EventStore {
    return {
        async storeEvent(streamId: StreamId, message: unknown): Promise<EventId> {
            const eventId = `${streamId}::${Date.now()}_${randomUUID()}`;
            eventStoreData.set(eventId, { eventId, message, streamId });
            return eventId;
        },
        async replayEventsAfter(
            lastEventId: EventId,
            { send }: { send: (eventId: EventId, message: unknown) => Promise<void> }
        ): Promise<StreamId> {
            const streamId = lastEventId.split('::')[0] || lastEventId;
            const eventsToReplay: Array<[string, { message: unknown }]> = [];
            for (const [eventId, data] of eventStoreData.entries()) {
                if (data.streamId === streamId && eventId > lastEventId) {
                    eventsToReplay.push([eventId, data]);
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

// Sample base64 encoded 1x1 red PNG pixel for testing
const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Sample base64 encoded minimal WAV file for testing
const TEST_AUDIO_BASE64 = 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAA=';

// Function to create a new MCP server instance (one per session)
function createMcpServer(sessionId?: string) {
    const mcpServer = new McpServer(
        {
            name: 'mcp-conformance-test-server',
            version: '1.0.0'
        },
        {
            capabilities: {
                tools: {
                    listChanged: true
                },
                resources: {
                    subscribe: true,
                    listChanged: true
                },
                prompts: {
                    listChanged: true
                },
                logging: {},
                completions: {}
            }
        }
    );

    // Helper to send log messages using the underlying server
    function sendLog(
        level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency',
        message: string,
        _data?: unknown
    ) {
        mcpServer.server
            .notification({
                method: 'notifications/message',
                params: {
                    level,
                    logger: 'conformance-test-server',
                    data: _data || message
                }
            })
            .catch(() => {
                // Ignore error if no client is connected
            });
    }

    // ===== TOOLS =====

    // Simple text tool
    mcpServer.registerTool(
        'test_simple_text',
        {
            description: 'Tests simple text content response'
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [{ type: 'text', text: 'This is a simple text response for testing.' }]
            };
        }
    );

    // Image content tool
    mcpServer.registerTool(
        'test_image_content',
        {
            description: 'Tests image content response'
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [{ type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' }]
            };
        }
    );

    // Audio content tool
    mcpServer.registerTool(
        'test_audio_content',
        {
            description: 'Tests audio content response'
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [{ type: 'audio', data: TEST_AUDIO_BASE64, mimeType: 'audio/wav' }]
            };
        }
    );

    // Embedded resource tool
    mcpServer.registerTool(
        'test_embedded_resource',
        {
            description: 'Tests embedded resource content response'
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: 'resource',
                        resource: {
                            uri: 'test://embedded-resource',
                            mimeType: 'text/plain',
                            text: 'This is an embedded resource content.'
                        }
                    }
                ]
            };
        }
    );

    // Multiple content types tool
    mcpServer.registerTool(
        'test_multiple_content_types',
        {
            description: 'Tests response with multiple content types (text, image, resource)'
        },
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

    // Tool with logging
    mcpServer.registerTool(
        'test_tool_with_logging',
        {
            description: 'Tests tool that emits log messages during execution',
            inputSchema: {}
        },
        async (_args, extra): Promise<CallToolResult> => {
            await extra.sendNotification({
                method: 'notifications/message',
                params: {
                    level: 'info',
                    data: 'Tool execution started'
                }
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            await extra.sendNotification({
                method: 'notifications/message',
                params: {
                    level: 'info',
                    data: 'Tool processing data'
                }
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            await extra.sendNotification({
                method: 'notifications/message',
                params: {
                    level: 'info',
                    data: 'Tool execution completed'
                }
            });
            return {
                content: [{ type: 'text', text: 'Tool with logging executed successfully' }]
            };
        }
    );

    // Tool with progress
    mcpServer.registerTool(
        'test_tool_with_progress',
        {
            description: 'Tests tool that reports progress notifications',
            inputSchema: {}
        },
        async (_args, extra): Promise<CallToolResult> => {
            const progressToken = extra._meta?.progressToken ?? 0;
            console.log('Progress token:', progressToken);
            await extra.sendNotification({
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 0,
                    total: 100,
                    message: `Completed step ${0} of ${100}`
                }
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            await extra.sendNotification({
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 50,
                    total: 100,
                    message: `Completed step ${50} of ${100}`
                }
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            await extra.sendNotification({
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 100,
                    total: 100,
                    message: `Completed step ${100} of ${100}`
                }
            });

            return {
                content: [{ type: 'text', text: String(progressToken) }]
            };
        }
    );

    // Error handling tool
    mcpServer.registerTool(
        'test_error_handling',
        {
            description: 'Tests error response handling'
        },
        async (): Promise<CallToolResult> => {
            throw new Error('This tool intentionally returns an error for testing');
        }
    );

    // SEP-1699: Reconnection test tool - closes SSE stream mid-call to test client reconnection
    mcpServer.registerTool(
        'test_reconnection',
        {
            description:
                'Tests SSE stream disconnection and client reconnection (SEP-1699). Server will close the stream mid-call and send the result after client reconnects.',
            inputSchema: {}
        },
        async (_args, extra): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

            console.log(`[${extra.sessionId}] Starting test_reconnection tool...`);

            // Get the transport for this session
            const transport = extra.sessionId ? transports[extra.sessionId] : undefined;
            if (transport && extra.requestId) {
                // Close the SSE stream to trigger client reconnection
                console.log(`[${extra.sessionId}] Closing SSE stream to trigger client polling...`);
                transport.closeSSEStream(extra.requestId);
            }

            // Wait for client to reconnect (should respect retry field)
            await sleep(100);

            console.log(`[${extra.sessionId}] test_reconnection tool complete`);

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

    // Sampling tool - requests LLM completion from client
    mcpServer.registerTool(
        'test_sampling',
        {
            description: 'Tests server-initiated sampling (LLM completion request)',
            inputSchema: {
                prompt: z.string().describe('The prompt to send to the LLM')
            }
        },
        async (args: { prompt: string }, extra): Promise<CallToolResult> => {
            try {
                // Request sampling from client
                const result = (await extra.sendRequest(
                    {
                        method: 'sampling/createMessage',
                        params: {
                            messages: [
                                {
                                    role: 'user',
                                    content: {
                                        type: 'text',
                                        text: args.prompt
                                    }
                                }
                            ],
                            maxTokens: 100
                        }
                    },
                    z.object({ method: z.literal('sampling/createMessage') }).passthrough()
                )) as { content?: { text?: string }; message?: { content?: { text?: string } } };

                const modelResponse = result.content?.text || result.message?.content?.text || 'No response';

                return {
                    content: [
                        {
                            type: 'text',
                            text: `LLM response: ${modelResponse}`
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Sampling not supported or error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        }
    );

    // Elicitation tool - requests user input from client
    mcpServer.registerTool(
        'test_elicitation',
        {
            description: 'Tests server-initiated elicitation (user input request)',
            inputSchema: {
                message: z.string().describe('The message to show the user')
            }
        },
        async (args: { message: string }, extra): Promise<CallToolResult> => {
            try {
                // Request user input from client
                const result = await extra.sendRequest(
                    {
                        method: 'elicitation/create',
                        params: {
                            message: args.message,
                            requestedSchema: {
                                type: 'object',
                                properties: {
                                    response: {
                                        type: 'string',
                                        description: "User's response"
                                    }
                                },
                                required: ['response']
                            }
                        }
                    },
                    ElicitResultSchema
                );

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

    // SEP-1034: Elicitation with default values for all primitive types
    mcpServer.registerTool(
        'test_elicitation_sep1034_defaults',
        {
            description: 'Tests elicitation with default values per SEP-1034',
            inputSchema: {}
        },
        async (_args, extra): Promise<CallToolResult> => {
            try {
                // Request user input with default values for all primitive types
                const result = await extra.sendRequest(
                    {
                        method: 'elicitation/create',
                        params: {
                            message: 'Please review and update the form fields with defaults',
                            requestedSchema: {
                                type: 'object',
                                properties: {
                                    name: {
                                        type: 'string',
                                        description: 'User name',
                                        default: 'John Doe'
                                    },
                                    age: {
                                        type: 'integer',
                                        description: 'User age',
                                        default: 30
                                    },
                                    score: {
                                        type: 'number',
                                        description: 'User score',
                                        default: 95.5
                                    },
                                    status: {
                                        type: 'string',
                                        description: 'User status',
                                        enum: ['active', 'inactive', 'pending'],
                                        default: 'active'
                                    },
                                    verified: {
                                        type: 'boolean',
                                        description: 'Verification status',
                                        default: true
                                    }
                                },
                                required: []
                            }
                        }
                    },
                    ElicitResultSchema
                );

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

    // SEP-1330: Elicitation with enum schema improvements
    mcpServer.registerTool(
        'test_elicitation_sep1330_enums',
        {
            description: 'Tests elicitation with enum schema improvements per SEP-1330',
            inputSchema: {}
        },
        async (_args, extra): Promise<CallToolResult> => {
            try {
                // Request user input with all 5 enum schema variants
                const result = await extra.sendRequest(
                    {
                        method: 'elicitation/create',
                        params: {
                            message: 'Please select options from the enum fields',
                            requestedSchema: {
                                type: 'object',
                                properties: {
                                    // Untitled single-select enum (basic)
                                    untitledSingle: {
                                        type: 'string',
                                        description: 'Select one option',
                                        enum: ['option1', 'option2', 'option3']
                                    },
                                    // Titled single-select enum (using oneOf with const/title)
                                    titledSingle: {
                                        type: 'string',
                                        description: 'Select one option with titles',
                                        oneOf: [
                                            { const: 'value1', title: 'First Option' },
                                            { const: 'value2', title: 'Second Option' },
                                            { const: 'value3', title: 'Third Option' }
                                        ]
                                    },
                                    // Legacy titled enum (using enumNames - deprecated)
                                    legacyEnum: {
                                        type: 'string',
                                        description: 'Select one option (legacy)',
                                        enum: ['opt1', 'opt2', 'opt3'],
                                        enumNames: ['Option One', 'Option Two', 'Option Three']
                                    },
                                    // Untitled multi-select enum
                                    untitledMulti: {
                                        type: 'array',
                                        description: 'Select multiple options',
                                        minItems: 1,
                                        maxItems: 3,
                                        items: {
                                            type: 'string',
                                            enum: ['option1', 'option2', 'option3']
                                        }
                                    },
                                    // Titled multi-select enum (using anyOf with const/title)
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
                    },
                    ElicitResultSchema
                );

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

    // SEP-1613: JSON Schema 2020-12 conformance test tool
    mcpServer.registerTool(
        'json_schema_2020_12_tool',
        {
            description: 'Tool with JSON Schema 2020-12 features for conformance testing (SEP-1613)',
            inputSchema: {
                name: z.string().optional(),
                address: z
                    .object({
                        street: z.string().optional(),
                        city: z.string().optional()
                    })
                    .optional()
            }
        },
        async (args: { name?: string; address?: { street?: string; city?: string } }): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: 'text',
                        text: `JSON Schema 2020-12 tool called with: ${JSON.stringify(args)}`
                    }
                ]
            };
        }
    );

    // ===== RESOURCES =====

    // Static text resource
    mcpServer.registerResource(
        'static-text',
        'test://static-text',
        {
            title: 'Static Text Resource',
            description: 'A static text resource for testing',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'test://static-text',
                        mimeType: 'text/plain',
                        text: 'This is the content of the static text resource.'
                    }
                ]
            };
        }
    );

    // Static binary resource
    mcpServer.registerResource(
        'static-binary',
        'test://static-binary',
        {
            title: 'Static Binary Resource',
            description: 'A static binary resource (image) for testing',
            mimeType: 'image/png'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'test://static-binary',
                        mimeType: 'image/png',
                        blob: TEST_IMAGE_BASE64
                    }
                ]
            };
        }
    );

    // Resource template
    mcpServer.registerResource(
        'template',
        new ResourceTemplate('test://template/{id}/data', { list: undefined }),
        {
            title: 'Resource Template',
            description: 'A resource template with parameter substitution',
            mimeType: 'application/json'
        },
        async (uri, variables): Promise<ReadResourceResult> => {
            const id = variables.id;
            return {
                contents: [
                    {
                        uri: uri.toString(),
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            id,
                            templateTest: true,
                            data: `Data for ID: ${id}`
                        })
                    }
                ]
            };
        }
    );

    // Watched resource
    mcpServer.registerResource(
        'watched-resource',
        'test://watched-resource',
        {
            title: 'Watched Resource',
            description: 'A resource that auto-updates every 3 seconds',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'test://watched-resource',
                        mimeType: 'text/plain',
                        text: watchedResourceContent
                    }
                ]
            };
        }
    );

    // Subscribe/Unsubscribe handlers
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

    // Simple prompt
    mcpServer.registerPrompt(
        'test_simple_prompt',
        {
            title: 'Simple Test Prompt',
            description: 'A simple prompt without arguments'
        },
        async (): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: 'This is a simple prompt for testing.'
                        }
                    }
                ]
            };
        }
    );

    // Prompt with arguments
    mcpServer.registerPrompt(
        'test_prompt_with_arguments',
        {
            title: 'Prompt With Arguments',
            description: 'A prompt with required arguments',
            argsSchema: {
                arg1: z.string().describe('First test argument'),
                arg2: z.string().describe('Second test argument')
            }
        },
        async (args: { arg1: string; arg2: string }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Prompt with arguments: arg1='${args.arg1}', arg2='${args.arg2}'`
                        }
                    }
                ]
            };
        }
    );

    // Prompt with embedded resource
    mcpServer.registerPrompt(
        'test_prompt_with_embedded_resource',
        {
            title: 'Prompt With Embedded Resource',
            description: 'A prompt that includes an embedded resource',
            argsSchema: {
                resourceUri: z.string().describe('URI of the resource to embed')
            }
        },
        async (args: { resourceUri: string }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'resource',
                            resource: {
                                uri: args.resourceUri,
                                mimeType: 'text/plain',
                                text: 'Embedded resource content for testing.'
                            }
                        }
                    },
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: 'Please process the embedded resource above.'
                        }
                    }
                ]
            };
        }
    );

    // Prompt with image
    mcpServer.registerPrompt(
        'test_prompt_with_image',
        {
            title: 'Prompt With Image',
            description: 'A prompt that includes image content'
        },
        async (): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'image',
                            data: TEST_IMAGE_BASE64,
                            mimeType: 'image/png'
                        }
                    },
                    {
                        role: 'user',
                        content: { type: 'text', text: 'Please analyze the image above.' }
                    }
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
        // Basic completion support - returns empty array for conformance
        // Real implementations would provide contextual suggestions
        return {
            completion: {
                values: [],
                total: 0,
                hasMore: false
            }
        };
    });

    return mcpServer;
}

// ===== EXPRESS APP =====

const app = express();
app.use(express.json());

// Configure CORS to expose Mcp-Session-Id header for browser-based clients
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'last-event-id']
    })
);

// Handle POST requests - stateful mode
app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        let transport: NodeStreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
            // Reuse existing transport for established sessions
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // Create new transport for initialization requests
            const mcpServer = createMcpServer();

            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 5000, // 5 second retry interval for SEP-1699
                onsessioninitialized: (newSessionId: string) => {
                    transports[newSessionId] = transport;
                    servers[newSessionId] = mcpServer;
                    console.log(`Session initialized with ID: ${newSessionId}`);
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    delete transports[sid];
                    if (servers[sid]) {
                        servers[sid].close();
                        delete servers[sid];
                    }
                    console.log(`Session ${sid} closed`);
                }
            };

            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Invalid or missing session ID'
                },
                id: null
            });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Internal server error'
                },
                id: null
            });
        }
    }
});

// Handle GET requests - SSE streams for sessions
app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
        console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
        console.log(`Establishing SSE stream for session ${sessionId}`);
    }

    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error('Error handling SSE stream:', error);
        if (!res.headersSent) {
            res.status(500).send('Error establishing SSE stream');
        }
    }
});

// Handle DELETE requests - session termination
app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    console.log(`Received session termination request for session ${sessionId}`);

    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error('Error handling termination:', error);
        if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
        }
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MCP Conformance Test Server running on http://localhost:${PORT}`);
    console.log(`  - MCP endpoint: http://localhost:${PORT}/mcp`);
});
