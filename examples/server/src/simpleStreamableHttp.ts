import { randomUUID } from 'node:crypto';

import {
    createProtectedResourceMetadataRouter,
    getOAuthProtectedResourceMetadataUrl,
    requireBearerAuth,
    setupAuthServer
} from '@modelcontextprotocol/examples-shared';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type {
    CallToolResult,
    ElicitResult,
    GetPromptResult,
    PrimitiveSchemaDefinition,
    ReadResourceResult,
    ResourceLink
} from '@modelcontextprotocol/server';
import {
    ElicitResultSchema,
    InMemoryTaskMessageQueue,
    InMemoryTaskStore,
    isInitializeRequest,
    McpServer
} from '@modelcontextprotocol/server';
import cors from 'cors';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

import { InMemoryEventStore } from './inMemoryEventStore.js';

// Check for OAuth flag
const useOAuth = process.argv.includes('--oauth');
const strictOAuth = process.argv.includes('--oauth-strict');
const dangerousLoggingEnabled = process.argv.includes('--dangerous-logging-enabled');

// Create shared task store for demonstration
const taskStore = new InMemoryTaskStore();

// Create an MCP server with implementation details
const getServer = () => {
    const server = new McpServer(
        {
            name: 'simple-streamable-http-server',
            version: '1.0.0',
            icons: [{ src: './mcp.svg', sizes: ['512x512'], mimeType: 'image/svg+xml' }],
            websiteUrl: 'https://github.com/modelcontextprotocol/typescript-sdk'
        },
        {
            capabilities: { logging: {}, tasks: { requests: { tools: { call: {} } } } },
            taskStore, // Enable task support
            taskMessageQueue: new InMemoryTaskMessageQueue()
        }
    );

    // Register a simple tool that returns a greeting
    server.registerTool(
        'greet',
        {
            title: 'Greeting Tool', // Display name for UI
            description: 'A simple greeting tool',
            inputSchema: z.object({
                name: z.string().describe('Name to greet')
            })
        },
        async ({ name }): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Hello, ${name}!`
                    }
                ]
            };
        }
    );

    // Register a tool that sends multiple greetings with notifications (with annotations)
    server.registerTool(
        'multi-greet',
        {
            description: 'A tool that sends different greetings with delays between them',
            inputSchema: z.object({
                name: z.string().describe('Name to greet')
            }),
            annotations: {
                title: 'Multiple Greeting Tool',
                readOnlyHint: true,
                openWorldHint: false
            }
        },
        async ({ name }, ctx): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

            await ctx.mcpReq.log('debug', `Starting multi-greet for ${name}`);

            await sleep(1000); // Wait 1 second before first greeting

            await ctx.mcpReq.log('info', `Sending first greeting to ${name}`);

            await sleep(1000); // Wait another second before second greeting

            await ctx.mcpReq.log('info', `Sending second greeting to ${name}`);

            return {
                content: [
                    {
                        type: 'text',
                        text: `Good morning, ${name}!`
                    }
                ]
            };
        }
    );
    // Register a tool that demonstrates form elicitation (user input collection with a schema)
    // This creates a closure that captures the server instance
    server.registerTool(
        'collect-user-info',
        {
            description: 'A tool that collects user information through form elicitation',
            inputSchema: z.object({
                infoType: z.enum(['contact', 'preferences', 'feedback']).describe('Type of information to collect')
            })
        },
        async ({ infoType }, ctx): Promise<CallToolResult> => {
            let message: string;
            let requestedSchema: {
                type: 'object';
                properties: Record<string, PrimitiveSchemaDefinition>;
                required?: string[];
            };

            switch (infoType) {
                case 'contact': {
                    message = 'Please provide your contact information';
                    requestedSchema = {
                        type: 'object',
                        properties: {
                            name: {
                                type: 'string',
                                title: 'Full Name',
                                description: 'Your full name'
                            },
                            email: {
                                type: 'string',
                                title: 'Email Address',
                                description: 'Your email address',
                                format: 'email'
                            },
                            phone: {
                                type: 'string',
                                title: 'Phone Number',
                                description: 'Your phone number (optional)'
                            }
                        },
                        required: ['name', 'email']
                    };
                    break;
                }
                case 'preferences': {
                    message = 'Please set your preferences';
                    requestedSchema = {
                        type: 'object',
                        properties: {
                            theme: {
                                type: 'string',
                                title: 'Theme',
                                description: 'Choose your preferred theme',
                                enum: ['light', 'dark', 'auto'],
                                enumNames: ['Light', 'Dark', 'Auto']
                            },
                            notifications: {
                                type: 'boolean',
                                title: 'Enable Notifications',
                                description: 'Would you like to receive notifications?',
                                default: true
                            },
                            frequency: {
                                type: 'string',
                                title: 'Notification Frequency',
                                description: 'How often would you like notifications?',
                                enum: ['daily', 'weekly', 'monthly'],
                                enumNames: ['Daily', 'Weekly', 'Monthly']
                            }
                        },
                        required: ['theme']
                    };
                    break;
                }
                case 'feedback': {
                    message = 'Please provide your feedback';
                    requestedSchema = {
                        type: 'object',
                        properties: {
                            rating: {
                                type: 'integer',
                                title: 'Rating',
                                description: 'Rate your experience (1-5)',
                                minimum: 1,
                                maximum: 5
                            },
                            comments: {
                                type: 'string',
                                title: 'Comments',
                                description: 'Additional comments (optional)',
                                maxLength: 500
                            },
                            recommend: {
                                type: 'boolean',
                                title: 'Would you recommend this?',
                                description: 'Would you recommend this to others?'
                            }
                        },
                        required: ['rating', 'recommend']
                    };
                    break;
                }
                default: {
                    throw new Error(`Unknown info type: ${infoType}`);
                }
            }

            try {
                // Use sendRequest through the ctx parameter to elicit input
                const result = await ctx.mcpReq.send(
                    {
                        method: 'elicitation/create',
                        params: {
                            mode: 'form',
                            message,
                            requestedSchema
                        }
                    },
                    ElicitResultSchema
                );

                if (result.action === 'accept') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Thank you! Collected ${infoType} information: ${JSON.stringify(result.content, null, 2)}`
                            }
                        ]
                    };
                } else if (result.action === 'decline') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No information was collected. User declined ${infoType} information request.`
                            }
                        ]
                    };
                } else {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Information collection was cancelled by the user.`
                            }
                        ]
                    };
                }
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error collecting ${infoType} information: ${error}`
                        }
                    ]
                };
            }
        }
    );

    // Register a simple prompt with title
    server.registerPrompt(
        'greeting-template',
        {
            title: 'Greeting Template', // Display name for UI
            description: 'A simple greeting prompt template',
            argsSchema: z.object({
                name: z.string().describe('Name to include in greeting')
            })
        },
        async ({ name }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Please greet ${name} in a friendly manner.`
                        }
                    }
                ]
            };
        }
    );

    // Register a tool specifically for testing resumability
    server.registerTool(
        'start-notification-stream',
        {
            description: 'Starts sending periodic notifications for testing resumability',
            inputSchema: z.object({
                interval: z.number().describe('Interval in milliseconds between notifications').default(100),
                count: z.number().describe('Number of notifications to send (0 for 100)').default(50)
            })
        },
        async ({ interval, count }, ctx): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
            let counter = 0;

            while (count === 0 || counter < count) {
                counter++;
                try {
                    await ctx.mcpReq.log('info', `Periodic notification #${counter} at ${new Date().toISOString()}`);
                } catch (error) {
                    console.error('Error sending notification:', error);
                }
                // Wait for the specified interval
                await sleep(interval);
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Started sending periodic notifications every ${interval}ms`
                    }
                ]
            };
        }
    );

    // Create a simple resource at a fixed URI
    server.registerResource(
        'greeting-resource',
        'https://example.com/greetings/default',
        {
            title: 'Default Greeting', // Display name for UI
            description: 'A simple greeting resource',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'https://example.com/greetings/default',
                        text: 'Hello, world!'
                    }
                ]
            };
        }
    );

    // Create additional resources for ResourceLink demonstration
    server.registerResource(
        'example-file-1',
        'file:///example/file1.txt',
        {
            title: 'Example File 1',
            description: 'First example file for ResourceLink demonstration',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'file:///example/file1.txt',
                        text: 'This is the content of file 1'
                    }
                ]
            };
        }
    );

    server.registerResource(
        'example-file-2',
        'file:///example/file2.txt',
        {
            title: 'Example File 2',
            description: 'Second example file for ResourceLink demonstration',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'file:///example/file2.txt',
                        text: 'This is the content of file 2'
                    }
                ]
            };
        }
    );

    // Register a tool that returns ResourceLinks
    server.registerTool(
        'list-files',
        {
            title: 'List Files with ResourceLinks',
            description: 'Returns a list of files as ResourceLinks without embedding their content',
            inputSchema: z.object({
                includeDescriptions: z.boolean().optional().describe('Whether to include descriptions in the resource links')
            })
        },
        async ({ includeDescriptions = true }): Promise<CallToolResult> => {
            const resourceLinks: ResourceLink[] = [
                {
                    type: 'resource_link',
                    uri: 'https://example.com/greetings/default',
                    name: 'Default Greeting',
                    mimeType: 'text/plain',
                    ...(includeDescriptions && { description: 'A simple greeting resource' })
                },
                {
                    type: 'resource_link',
                    uri: 'file:///example/file1.txt',
                    name: 'Example File 1',
                    mimeType: 'text/plain',
                    ...(includeDescriptions && { description: 'First example file for ResourceLink demonstration' })
                },
                {
                    type: 'resource_link',
                    uri: 'file:///example/file2.txt',
                    name: 'Example File 2',
                    mimeType: 'text/plain',
                    ...(includeDescriptions && { description: 'Second example file for ResourceLink demonstration' })
                }
            ];

            return {
                content: [
                    {
                        type: 'text',
                        text: 'Here are the available files as resource links:'
                    },
                    ...resourceLinks,
                    {
                        type: 'text',
                        text: '\nYou can read any of these resources using their URI.'
                    }
                ]
            };
        }
    );

    // Register a long-running tool that demonstrates task execution
    // Using the experimental tasks API - WARNING: may change without notice
    server.experimental.tasks.registerToolTask(
        'delay',
        {
            title: 'Delay',
            description: 'A simple tool that delays for a specified duration, useful for testing task execution',
            inputSchema: z.object({
                duration: z.number().describe('Duration in milliseconds').default(5000)
            })
        },
        {
            async createTask({ duration }, ctx) {
                // Create the task
                const task = await ctx.task.store.createTask({
                    ttl: ctx.task.requestedTtl
                });

                // Simulate out-of-band work
                (async () => {
                    await new Promise(resolve => setTimeout(resolve, duration));
                    await ctx.task.store.storeTaskResult(task.taskId, 'completed', {
                        content: [
                            {
                                type: 'text',
                                text: `Completed ${duration}ms delay`
                            }
                        ]
                    });
                })();

                // Return CreateTaskResult with the created task
                return {
                    task
                };
            },
            async getTask(_args, ctx) {
                return await ctx.task.store.getTask(ctx.task.id);
            },
            async getTaskResult(_args, ctx) {
                const result = await ctx.task.store.getTaskResult(ctx.task.id);
                return result as CallToolResult;
            }
        }
    );

    // Register a tool that demonstrates bidirectional task support:
    // Server creates a task, then elicits input from client using elicitInputStream
    // Using the experimental tasks API - WARNING: may change without notice
    server.experimental.tasks.registerToolTask(
        'collect-user-info-task',
        {
            title: 'Collect Info with Task',
            description: 'Collects user info via elicitation with task support using elicitInputStream',
            inputSchema: z.object({
                infoType: z.enum(['contact', 'preferences']).describe('Type of information to collect').default('contact')
            })
        },
        {
            async createTask({ infoType }, ctx) {
                // Create the server-side task
                const task = await ctx.task.store.createTask({
                    ttl: ctx.task.requestedTtl
                });

                // Perform async work that makes a nested elicitation request using elicitInputStream
                (async () => {
                    try {
                        const message = infoType === 'contact' ? 'Please provide your contact information' : 'Please set your preferences';

                        // Define schemas with proper typing for PrimitiveSchemaDefinition
                        const contactSchema: {
                            type: 'object';
                            properties: Record<string, PrimitiveSchemaDefinition>;
                            required: string[];
                        } = {
                            type: 'object',
                            properties: {
                                name: { type: 'string', title: 'Full Name', description: 'Your full name' },
                                email: { type: 'string', title: 'Email', description: 'Your email address' }
                            },
                            required: ['name', 'email']
                        };

                        const preferencesSchema: {
                            type: 'object';
                            properties: Record<string, PrimitiveSchemaDefinition>;
                            required: string[];
                        } = {
                            type: 'object',
                            properties: {
                                theme: { type: 'string', title: 'Theme', enum: ['light', 'dark', 'auto'] },
                                notifications: { type: 'boolean', title: 'Enable Notifications', default: true }
                            },
                            required: ['theme']
                        };

                        const requestedSchema = infoType === 'contact' ? contactSchema : preferencesSchema;

                        // Use elicitInputStream to elicit input from client
                        // This demonstrates the streaming elicitation API
                        // Access via server.server to get the underlying Server instance
                        const stream = server.server.experimental.tasks.elicitInputStream({
                            mode: 'form',
                            message,
                            requestedSchema
                        });

                        let elicitResult: ElicitResult | undefined;
                        for await (const msg of stream) {
                            if (msg.type === 'result') {
                                elicitResult = msg.result as ElicitResult;
                            } else if (msg.type === 'error') {
                                throw msg.error;
                            }
                        }

                        if (!elicitResult) {
                            throw new Error('No result received from elicitation');
                        }

                        let resultText: string;
                        if (elicitResult.action === 'accept') {
                            resultText = `Collected ${infoType} info: ${JSON.stringify(elicitResult.content, null, 2)}`;
                        } else if (elicitResult.action === 'decline') {
                            resultText = `User declined to provide ${infoType} information`;
                        } else {
                            resultText = 'User cancelled the request';
                        }

                        await taskStore.storeTaskResult(task.taskId, 'completed', {
                            content: [{ type: 'text', text: resultText }]
                        });
                    } catch (error) {
                        console.error('Error in collect-user-info-task:', error);
                        await taskStore.storeTaskResult(task.taskId, 'failed', {
                            content: [{ type: 'text', text: `Error: ${error}` }],
                            isError: true
                        });
                    }
                })();

                return { task };
            },
            async getTask(_args, ctx) {
                return await ctx.task.store.getTask(ctx.task.id);
            },
            async getTaskResult(_args, ctx) {
                const result = await ctx.task.store.getTaskResult(ctx.task.id);
                return result as CallToolResult;
            }
        }
    );

    return server;
};

const MCP_PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;
const AUTH_PORT = process.env.MCP_AUTH_PORT ? Number.parseInt(process.env.MCP_AUTH_PORT, 10) : 3001;

const app = createMcpExpressApp();

// Enable CORS for browser-based clients (demo only)
// This allows cross-origin requests and exposes WWW-Authenticate header for OAuth
// WARNING: This configuration is for demo purposes only. In production, you should restrict this to specific origins and configure CORS yourself.
app.use(
    cors({
        exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Last-Event-Id', 'Mcp-Protocol-Version'],
        origin: '*' // WARNING: This allows all origins to access the MCP server. In production, you should restrict this to specific origins.
    })
);

// Set up OAuth if enabled
let authMiddleware = null;
if (useOAuth) {
    // Create auth middleware for MCP endpoints
    const mcpServerUrl = new URL(`http://localhost:${MCP_PORT}/mcp`);
    const authServerUrl = new URL(`http://localhost:${AUTH_PORT}`);

    setupAuthServer({ authServerUrl, mcpServerUrl, strictResource: strictOAuth, demoMode: true, dangerousLoggingEnabled });

    // Add protected resource metadata route to the MCP server
    // This allows clients to discover the auth server
    // Pass the resource path so metadata is served at /.well-known/oauth-protected-resource/mcp
    app.use(createProtectedResourceMetadataRouter('/mcp'));

    authMiddleware = requireBearerAuth({
        requiredScopes: [],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
        strictResource: strictOAuth,
        expectedResource: mcpServerUrl
    });
}

// Map to store transports by session ID
const transports: { [sessionId: string]: NodeStreamableHTTPServerTransport } = {};

// MCP POST endpoint with optional auth
const mcpPostHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
        console.log(`Received MCP request for session: ${sessionId}`);
    } else {
        console.log('Request body:', req.body);
    }

    if (useOAuth && req.app.locals.auth) {
        console.log('Authenticated user:', req.app.locals.auth);
    }
    try {
        let transport: NodeStreamableHTTPServerTransport;
        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request
            const eventStore = new InMemoryEventStore();
            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore, // Enable resumability
                onsessioninitialized: sessionId => {
                    // Store the transport by session ID when session is initialized
                    // This avoids race conditions where requests might come in before the session is stored
                    console.log(`Session initialized with ID: ${sessionId}`);
                    transports[sessionId] = transport;
                }
            });

            // Set up onclose handler to clean up transport when closed
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`Transport closed for session ${sid}, removing from transports map`);
                    delete transports[sid];
                }
            };

            // Connect the transport to the MCP server BEFORE handling the request
            // so responses can flow back through the same transport
            const server = getServer();
            await server.connect(transport);

            await transport.handleRequest(req, res, req.body);
            return; // Already handled
        } else {
            // Invalid request - no session ID or not initialization request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32_000,
                    message: 'Bad Request: No valid session ID provided'
                },
                id: null
            });
            return;
        }

        // Handle the request with existing transport - no need to reconnect
        // The existing transport is already connected to the server
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32_603,
                    message: 'Internal server error'
                },
                id: null
            });
        }
    }
};

// Set up routes with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.post('/mcp', authMiddleware, mcpPostHandler);
} else {
    app.post('/mcp', mcpPostHandler);
}

// Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
const mcpGetHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    if (useOAuth && req.app.locals.auth) {
        console.log('Authenticated SSE connection from user:', req.app.locals.auth);
    }

    // Check for Last-Event-ID header for resumability
    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
        console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
        console.log(`Establishing new SSE stream for session ${sessionId}`);
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};

// Set up GET route with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.get('/mcp', authMiddleware, mcpGetHandler);
} else {
    app.get('/mcp', mcpGetHandler);
}

// Handle DELETE requests for session termination (according to MCP spec)
const mcpDeleteHandler = async (req: Request, res: Response) => {
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
        console.error('Error handling session termination:', error);
        if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
        }
    }
};

// Set up DELETE route with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.delete('/mcp', authMiddleware, mcpDeleteHandler);
} else {
    app.delete('/mcp', mcpDeleteHandler);
}

app.listen(MCP_PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`MCP Streamable HTTP Server listening on port ${MCP_PORT}`);
    if (useOAuth) {
        console.log(`  Protected Resource Metadata: http://localhost:${MCP_PORT}/.well-known/oauth-protected-resource/mcp`);
    }
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
        try {
            console.log(`Closing transport for session ${sessionId}`);
            await transports[sessionId]!.close();
            delete transports[sessionId];
        } catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    console.log('Server shutdown complete');
    process.exit(0);
});
