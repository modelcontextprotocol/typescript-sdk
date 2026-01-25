/* eslint-disable unicorn/no-process-exit */
/**
 * Simple Streamable HTTP Client Example using Builder Pattern
 *
 * This example demonstrates using the Client.builder() fluent API
 * to create and configure an MCP client with:
 * - Builder pattern configuration
 * - Universal middleware (logging)
 * - Outgoing middleware (retry logic)
 * - Tool call middleware (instrumentation)
 * - Sampling request handler
 * - Elicitation request handler
 * - Roots list handler
 * - Error handlers (onError, onProtocolError)
 *
 * Run with: npx tsx src/simpleStreamableHttpBuilder.ts
 */

import { createInterface } from 'node:readline';

import type {
    CallToolRequest,
    ClientMiddleware,
    GetPromptRequest,
    ListPromptsRequest,
    ListResourcesRequest,
    ListToolsRequest,
    OutgoingMiddleware,
    ReadResourceRequest,
    ToolCallMiddleware
} from '@modelcontextprotocol/client';
import {
    CallToolResultSchema,
    Client,
    getDisplayName,
    GetPromptResultSchema,
    isTextContent,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListToolsResultSchema,
    LoggingMessageNotificationSchema
,
    ReadResourceResultSchema,
    StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';

// Create readline interface for user input
const readline = createInterface({
    input: process.stdin,
    output: process.stdout
});

// Track received notifications
let notificationCount = 0;

// Global client and transport
let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;
let serverUrl = 'http://localhost:3000/mcp';
let sessionId: string | undefined;

// ═══════════════════════════════════════════════════════════════════════════
// Custom Middleware Examples
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for MCP client logging middleware.
 */
export interface ClientLoggingMiddlewareOptions {
    /** Log level */
    level?: 'debug' | 'info' | 'warn' | 'error';
    /** Custom logger function */
    logger?: (level: string, message: string, data?: unknown) => void;
}

/**
 * Creates a logging middleware for MCP client operations.
 *
 * @example
 * ```typescript
 * client.useMiddleware(createClientLoggingMiddleware({ level: 'debug' }));
 * ```
 */
export function createClientLoggingMiddleware(options: ClientLoggingMiddlewareOptions = {}): ClientMiddleware {
    const { level = 'info', logger = console.log } = options;

    return async (ctx, next) => {
        logger(level, `${ctx.direction} ${ctx.type}: ${ctx.method}`, {
            direction: ctx.direction,
            type: ctx.type,
            method: ctx.method,
            requestId: ctx.requestId
        });

        const start = Date.now();

        try {
            const result = await next();
            const duration = Date.now() - start;
            logger(level, `← ${ctx.type}: ${ctx.method} (${duration}ms)`, {
                direction: ctx.direction,
                type: ctx.type,
                method: ctx.method,
                requestId: ctx.requestId,
                duration
            });
            return result;
        } catch (error) {
            const duration = Date.now() - start;
            logger('error', `✗ ${ctx.type}: ${ctx.method} (${duration}ms)`, {
                direction: ctx.direction,
                type: ctx.type,
                method: ctx.method,
                requestId: ctx.requestId,
                duration,
                error
            });
            throw error;
        }
    };
}


/**
 * Options for retry middleware.
 */
interface RetryMiddlewareOptions {
    /** Maximum number of retries */
    maxRetries?: number;
    /** Base delay between retries in ms */
    baseDelay?: number;
    /** Function to determine if an error is retryable */
    isRetryable?: (error: unknown) => boolean;
}
/**
 * Creates a retry middleware for outgoing MCP requests.
 *
 * @example
 * ```typescript
 * client.useOutgoingMiddleware(createRetryMiddleware({
 *   maxRetries: 3,
 *   baseDelay: 100,
 * }));
 * ```
 */
export function createRetryMiddleware(options: RetryMiddlewareOptions = {}): OutgoingMiddleware {
    const { maxRetries = 3, baseDelay = 100, isRetryable = () => true } = options;

    return async (ctx, next) => {
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                return await next();
            } catch (error) {
                lastError = error;

                if (attempt > maxRetries || !isRetryable(error)) {
                    throw error;
                }

                // Exponential backoff
                const delay = baseDelay * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    };
}


/**
 * Custom tool call instrumentation middleware.
 * Logs tool calls with timing information.
 */
const toolCallInstrumentationMiddleware: ToolCallMiddleware = async (ctx, next) => {
    console.log(`\n[TOOL CALL] Starting: ${ctx.params.name}`);
    console.log(`[TOOL CALL] Arguments: ${JSON.stringify(ctx.params.arguments || {})}`);

    const start = performance.now();
    try {
        const result = await next();
        const duration = (performance.now() - start).toFixed(2);
        console.log(`[TOOL CALL] Completed: ${ctx.params.name} (${duration}ms)`);
        return result;
    } catch (error) {
        const duration = (performance.now() - start).toFixed(2);
        console.log(`[TOOL CALL] Failed: ${ctx.params.name} (${duration}ms) - ${error}`);
        throw error;
    }
};

/**
 * Custom request timing middleware.
 * Tracks timing for all outgoing requests.
 */
const requestTimingMiddleware: ClientMiddleware = async (ctx, next) => {
    const start = performance.now();
    try {
        const result = await next();
        const duration = (performance.now() - start).toFixed(2);
        console.log(`[TIMING] ${ctx.direction} ${ctx.method} completed in ${duration}ms`);
        return result;
    } catch (error) {
        const duration = (performance.now() - start).toFixed(2);
        console.log(`[TIMING] ${ctx.direction} ${ctx.method} failed in ${duration}ms`);
        throw error;
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// Main Function
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('MCP Interactive Client (Builder Pattern Example)');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('Features demonstrated:');
    console.log('  - Builder pattern for client configuration');
    console.log('  - Universal middleware (logging, timing)');
    console.log('  - Outgoing middleware (retry logic)');
    console.log('  - Tool call middleware (instrumentation)');
    console.log('  - Sampling request handler');
    console.log('  - Elicitation request handler');
    console.log('  - Roots list handler');
    console.log('  - Error handlers (onError, onProtocolError)');
    console.log('═══════════════════════════════════════════════════════════════');

    // Connect to server immediately
    await connect();

    // Print help and start the command loop
    printHelp();
    commandLoop();
}

function printHelp(): void {
    console.log('\nAvailable commands:');
    console.log('  connect [url]              - Connect to MCP server (default: http://localhost:3000/mcp)');
    console.log('  disconnect                 - Disconnect from server');
    console.log('  reconnect                  - Reconnect to the server');
    console.log('  list-tools                 - List available tools');
    console.log('  call-tool <name> [args]    - Call a tool with optional JSON arguments');
    console.log('  greet [name]               - Call the greet tool');
    console.log('  multi-greet [name]         - Call the multi-greet tool with notifications');
    console.log('  context-demo [msg]         - Call the context-demo tool');
    console.log('  admin-action <action>      - Call admin-action (no auth)');
    console.log('  admin-action-auth <action> - Call admin-action with auth token');
    console.log('  error-test <type>          - Test error handling (application/validation)');
    console.log('  list-prompts               - List available prompts');
    console.log('  get-prompt <name> [args]   - Get a prompt with optional JSON arguments');
    console.log('  list-resources             - List available resources');
    console.log('  read-resource <uri>        - Read a specific resource by URI');
    console.log('  session-info               - Read session info resource');
    console.log('  help                       - Show this help');
    console.log('  quit                       - Exit the program');
}

function commandLoop(): void {
    readline.question('\n> ', async (input) => {
        const args = input.trim().split(/\s+/);
        const command = args[0]?.toLowerCase();

        try {
            switch (command) {
                case 'connect': {
                    await connect(args[1]);
                    break;
                }

                case 'disconnect': {
                    await disconnect();
                    break;
                }

                case 'reconnect': {
                    await reconnect();
                    break;
                }

                case 'list-tools': {
                    await listTools();
                    break;
                }

                case 'call-tool': {
                    if (args.length < 2) {
                        console.log('Usage: call-tool <name> [args]');
                    } else {
                        const toolName = args[1]!;
                        let toolArgs = {};
                        if (args.length > 2) {
                            try {
                                toolArgs = JSON.parse(args.slice(2).join(' '));
                            } catch {
                                console.log('Invalid JSON arguments. Using empty args.');
                            }
                        }
                        await callTool(toolName, toolArgs);
                    }
                    break;
                }

                case 'greet': {
                    await callTool('greet', { name: args[1] || 'World' });
                    break;
                }

                case 'multi-greet': {
                    console.log('Calling multi-greet tool (watch for notifications)...');
                    await callTool('multi-greet', { name: args[1] || 'World' });
                    break;
                }

                case 'context-demo': {
                    await callTool('context-demo', { message: args.slice(1).join(' ') || 'Hello from client!' });
                    break;
                }

                case 'admin-action': {
                    if (args.length < 2) {
                        console.log('Usage: admin-action <action>');
                    } else {
                        // Call without requiresAdmin flag - should work
                        await callTool('admin-action', { action: args[1] });
                    }
                    break;
                }

                case 'admin-action-auth': {
                    if (args.length < 2) {
                        console.log('Usage: admin-action-auth <action>');
                    } else {
                        // Call with requiresAdmin but provide token
                        await callTool('admin-action', {
                            action: args[1],
                            requiresAdmin: true,
                            adminToken: 'demo-token-123'
                        });
                    }
                    break;
                }

                case 'error-test': {
                    if (args.length < 2) {
                        console.log('Usage: error-test <application|validation>');
                    } else {
                        await callTool('error-test', { errorType: args[1] });
                    }
                    break;
                }

                case 'list-prompts': {
                    await listPrompts();
                    break;
                }

                case 'get-prompt': {
                    if (args.length < 2) {
                        console.log('Usage: get-prompt <name> [args]');
                    } else {
                        const promptName = args[1]!;
                        let promptArgs = {};
                        if (args.length > 2) {
                            try {
                                promptArgs = JSON.parse(args.slice(2).join(' '));
                            } catch {
                                console.log('Invalid JSON arguments. Using empty args.');
                            }
                        }
                        await getPrompt(promptName, promptArgs);
                    }
                    break;
                }

                case 'list-resources': {
                    await listResources();
                    break;
                }

                case 'read-resource': {
                    if (args.length < 2) {
                        console.log('Usage: read-resource <uri>');
                    } else {
                        await readResource(args[1]!);
                    }
                    break;
                }

                case 'session-info': {
                    await readResource('https://example.com/session/info');
                    break;
                }

                case 'help': {
                    printHelp();
                    break;
                }

                case 'quit':
                case 'exit': {
                    await cleanup();
                    return;
                }

                default: {
                    if (command) {
                        console.log(`Unknown command: ${command}`);
                    }
                    break;
                }
            }
        } catch (error) {
            console.error(`Error executing command: ${error}`);
        }

        // Continue the command loop
        commandLoop();
    });
}

/**
 * Connect to the MCP server using the builder pattern.
 *
 * The builder provides a fluent API for configuring the client:
 * - .name() and .version() set client info
 * - .capabilities() configures client capabilities
 * - .useMiddleware() adds universal middleware
 * - .useOutgoingMiddleware() adds outgoing-only middleware
 * - .useToolCallMiddleware() adds tool call specific middleware
 * - .onSamplingRequest() handles sampling requests from server
 * - .onElicitation() handles elicitation requests from server
 * - .onRootsList() handles roots list requests from server
 * - .onError() handles application errors
 * - .onProtocolError() handles protocol errors
 * - .build() creates the configured Client instance
 */
async function connect(url?: string): Promise<void> {
    if (client) {
        console.log('Already connected. Disconnect first.');
        return;
    }

    if (url) {
        serverUrl = url;
    }

    console.log(`\nConnecting to ${serverUrl}...`);

    try {
        // Create a new client using the builder pattern
        client = Client.builder()
            .name('builder-example-client')
            .version('1.0.0')

            // ─── Capabilities ───
            // Enable sampling, elicitation, and roots capabilities
            .capabilities({
                sampling: {},
                elicitation: { form: {} },
                roots: { listChanged: true }
            })

            // ─── Universal Middleware ───
            // Logging middleware for all requests
            .useMiddleware(
                createClientLoggingMiddleware({
                    level: 'debug',
                    logger: (level, message, data) => {
                        const timestamp = new Date().toISOString();
                        console.log(`[${timestamp}] [CLIENT ${level.toUpperCase()}] ${message}`);
                        if (data) {
                            console.log(`[${timestamp}] [CLIENT ${level.toUpperCase()}] Data:`, JSON.stringify(data, null, 2));
                        }
                    }
                })
            )

            // Custom timing middleware
            .useMiddleware(requestTimingMiddleware)

            // ─── Outgoing Middleware ───
            // Retry middleware for transient failures
            .useOutgoingMiddleware(
                createRetryMiddleware({
                    maxRetries: 3,
                    baseDelay: 100,
                    isRetryable: (error) => {
                        // Retry on network errors
                        const message = error instanceof Error ? error.message : String(error);
                        return (
                            message.includes('ECONNREFUSED') ||
                            message.includes('ETIMEDOUT') ||
                            message.includes('network')
                        );
                    }
                })
            )

            // ─── Tool Call Middleware ───
            .useToolCallMiddleware(toolCallInstrumentationMiddleware)

            // ─── Request Handlers ───

            // Sampling request handler (when server requests LLM completion)
            .onSamplingRequest(async (params) => {
                console.log('\n[SAMPLING] Received sampling request from server');
                console.log('[SAMPLING] Messages:', JSON.stringify(params, null, 2));

                // In a real implementation, this would call an LLM
                // For demo, return a simulated response
                return {
                    role: 'assistant',
                    content: {
                        type: 'text',
                        text: 'This is a simulated sampling response from the client.'
                    },
                    model: 'simulated-model-v1'
                };
            })

            // Elicitation handler (when server requests user input)
            .onElicitation(async (params) => {
                const elicitParams = params as { mode?: string; message?: string; requestedSchema?: unknown };
                console.log('\n[ELICITATION] Received elicitation request from server');
                console.log('[ELICITATION] Mode:', elicitParams.mode);
                console.log('[ELICITATION] Message:', elicitParams.message);

                if (elicitParams.mode === 'form') {
                    // For demo, auto-accept with sample data
                    console.log('[ELICITATION] Auto-accepting form with sample data');
                    return {
                        action: 'accept',
                        content: {
                            name: 'Demo User',
                            email: 'demo@example.com',
                            confirmed: true
                        }
                    };
                }

                // Decline other modes
                console.log('[ELICITATION] Declining non-form elicitation');
                return { action: 'decline' };
            })

            // Roots list handler (when server requests filesystem roots)
            .onRootsList(async () => {
                console.log('\n[ROOTS] Received roots list request from server');
                return {
                    roots: [
                        { uri: 'file:///workspace', name: 'Workspace' },
                        { uri: 'file:///home/user', name: 'Home Directory' },
                        { uri: 'file:///tmp', name: 'Temporary Files' }
                    ]
                };
            })

            // ─── Error Handlers ───
            .onError((error, ctx) => {
                console.error(`\n[CLIENT ERROR] ${ctx.type}: ${error.message}`);
                console.error(`[CLIENT ERROR] Request ID: ${ctx.requestId}`);
                // Return the original error (could also transform it)
                return error;
            })
            .onProtocolError((error, ctx) => {
                console.error(`\n[PROTOCOL ERROR] ${ctx.method}: ${error.message}`);
                console.error(`[PROTOCOL ERROR] Request ID: ${ctx.requestId}`);
            })

            .build();

        // Set up client error handler
        client.onerror = (error) => {
            console.error('\n[CLIENT] Error event:', error);
        };

        // Create transport with optional session ID for reconnection
        transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
            sessionId: sessionId
        });

        // Set up notification handler for logging messages
        client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
            notificationCount++;
            console.log(`\n[NOTIFICATION #${notificationCount}] ${notification.params.level}: ${notification.params.data}`);
            process.stdout.write('> ');
        });

        // Connect the client
        await client.connect(transport);
        sessionId = transport.sessionId;
        console.log('Connected to MCP server');
        console.log('Session ID:', sessionId);
    } catch (error) {
        console.error('Failed to connect:', error);
        client = null;
        transport = null;
    }
}

async function disconnect(): Promise<void> {
    if (!client || !transport) {
        console.log('Not connected.');
        return;
    }

    try {
        await transport.close();
        console.log('Disconnected from MCP server');
        client = null;
        transport = null;
    } catch (error) {
        console.error('Error disconnecting:', error);
    }
}

async function reconnect(): Promise<void> {
    if (client) {
        await disconnect();
    }
    await connect();
}

async function listTools(): Promise<void> {
    if (!client) {
        console.log('Not connected to server.');
        return;
    }

    try {
        const request: ListToolsRequest = {
            method: 'tools/list',
            params: {}
        };
        const result = await client.request(request, ListToolsResultSchema);

        console.log('\nAvailable tools:');
        if (result.tools.length === 0) {
            console.log('  No tools available');
        } else {
            for (const tool of result.tools) {
                console.log(`  - ${tool.name}: ${getDisplayName(tool)} - ${tool.description}`);
            }
        }
    } catch (error) {
        console.log(`Tools not supported by this server (${error})`);
    }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
    if (!client) {
        console.log('Not connected to server.');
        return;
    }

    try {
        const request: CallToolRequest = {
            method: 'tools/call',
            params: {
                name,
                arguments: args
            }
        };

        const result = await client.request(request, CallToolResultSchema);

        console.log('\nTool result:');
        for (const item of result.content) {
            if (isTextContent(item)) {
                console.log(`  ${item.text}`);
            } else {
                console.log(`  [${item.type}]:`, item);
            }
        }
    } catch (error) {
        console.log(`Error calling tool ${name}: ${error}`);
    }
}

async function listPrompts(): Promise<void> {
    if (!client) {
        console.log('Not connected to server.');
        return;
    }

    try {
        const request: ListPromptsRequest = {
            method: 'prompts/list',
            params: {}
        };
        const result = await client.request(request, ListPromptsResultSchema);

        console.log('\nAvailable prompts:');
        if (result.prompts.length === 0) {
            console.log('  No prompts available');
        } else {
            for (const prompt of result.prompts) {
                console.log(`  - ${prompt.name}: ${getDisplayName(prompt)} - ${prompt.description}`);
            }
        }
    } catch (error) {
        console.log(`Prompts not supported by this server (${error})`);
    }
}

async function getPrompt(name: string, args: Record<string, unknown>): Promise<void> {
    if (!client) {
        console.log('Not connected to server.');
        return;
    }

    try {
        const request: GetPromptRequest = {
            method: 'prompts/get',
            params: {
                name,
                arguments: args as Record<string, string>
            }
        };

        const result = await client.request(request, GetPromptResultSchema);
        console.log('\nPrompt template:');
        for (const [index, msg] of result.messages.entries()) {
            console.log(`  [${index + 1}] ${msg.role}: ${isTextContent(msg.content) ? msg.content.text : JSON.stringify(msg.content)}`);
        }
    } catch (error) {
        console.log(`Error getting prompt ${name}: ${error}`);
    }
}

async function listResources(): Promise<void> {
    if (!client) {
        console.log('Not connected to server.');
        return;
    }

    try {
        const request: ListResourcesRequest = {
            method: 'resources/list',
            params: {}
        };
        const result = await client.request(request, ListResourcesResultSchema);

        console.log('\nAvailable resources:');
        if (result.resources.length === 0) {
            console.log('  No resources available');
        } else {
            for (const resource of result.resources) {
                console.log(`  - ${resource.name}: ${getDisplayName(resource)} - ${resource.uri}`);
            }
        }
    } catch (error) {
        console.log(`Resources not supported by this server (${error})`);
    }
}

async function readResource(uri: string): Promise<void> {
    if (!client) {
        console.log('Not connected to server.');
        return;
    }

    try {
        const request: ReadResourceRequest = {
            method: 'resources/read',
            params: { uri }
        };

        console.log(`\nReading resource: ${uri}`);
        const result = await client.request(request, ReadResourceResultSchema);

        console.log('Resource contents:');
        for (const content of result.contents) {
            console.log(`  URI: ${content.uri}`);
            if (content.mimeType) {
                console.log(`  Type: ${content.mimeType}`);
            }

            if ('text' in content && typeof content.text === 'string') {
                console.log('  Content:');
                console.log('  ---');
                console.log(
                    content.text
                        .split('\n')
                        .map((line: string) => '  ' + line)
                        .join('\n')
                );
                console.log('  ---');
            } else if ('blob' in content && typeof content.blob === 'string') {
                console.log(`  [Binary data: ${content.blob.length} bytes]`);
            }
        }
    } catch (error) {
        console.log(`Error reading resource ${uri}: ${error}`);
    }
}

async function cleanup(): Promise<void> {
    if (client && transport) {
        try {
            await transport.close();
        } catch (error) {
            console.error('Error closing transport:', error);
        }
    }

    readline.close();
    console.log('\nGoodbye!');
    process.exit(0);
}

// Handle Ctrl+C
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT. Cleaning up...');
    await cleanup();
});

// Start the interactive client
try {
    await main();
} catch (error) {
    console.error('Error running MCP client:', error);
    process.exit(1);
}
