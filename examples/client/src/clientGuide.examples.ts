/**
 * Type-checked examples for docs/client.md.
 *
 * Regions are synced into markdown code fences via `pnpm sync:snippets`.
 * Each function wraps a single region. The function name matches the region name.
 *
 * @module
 */

import {
    applyMiddlewares,
    CallToolResultSchema,
    Client,
    ClientCredentialsProvider,
    createMiddleware,
    PrivateKeyJwtProvider,
    SSEClientTransport,
    StdioClientTransport,
    StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';

// ---------------------------------------------------------------------------
// Connecting to a server
// ---------------------------------------------------------------------------

/** Example: Streamable HTTP transport. */
async function connect_streamableHttp() {
    //#region connect_streamableHttp
    const client = new Client({ name: 'my-client', version: '1.0.0' });

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

    await client.connect(transport);
    //#endregion connect_streamableHttp
}

/** Example: stdio transport for local process-spawned servers. */
async function connect_stdio() {
    //#region connect_stdio
    const client = new Client({ name: 'my-client', version: '1.0.0' });

    const transport = new StdioClientTransport({
        command: 'node',
        args: ['server.js']
    });

    await client.connect(transport);
    //#endregion connect_stdio
}

/** Example: Try Streamable HTTP, fall back to legacy SSE. */
async function connect_sseFallback(url: string) {
    //#region connect_sseFallback
    const baseUrl = new URL(url);

    try {
        // Try modern Streamable HTTP transport first
        const client = new Client({ name: 'my-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(baseUrl);
        await client.connect(transport);
        return { client, transport };
    } catch {
        // Fall back to legacy SSE transport
        const client = new Client({ name: 'my-client', version: '1.0.0' });
        const transport = new SSEClientTransport(baseUrl);
        await client.connect(transport);
        return { client, transport };
    }
    //#endregion connect_sseFallback
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Example: Client credentials auth for service-to-service communication. */
async function auth_clientCredentials() {
    //#region auth_clientCredentials
    const authProvider = new ClientCredentialsProvider({
        clientId: 'my-service',
        clientSecret: 'my-secret'
    });

    const client = new Client({ name: 'my-client', version: '1.0.0' });

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });

    await client.connect(transport);
    //#endregion auth_clientCredentials
}

/** Example: Private key JWT auth. */
async function auth_privateKeyJwt(pemEncodedKey: string) {
    //#region auth_privateKeyJwt
    const authProvider = new PrivateKeyJwtProvider({
        clientId: 'my-service',
        privateKey: pemEncodedKey,
        algorithm: 'RS256'
    });

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });
    //#endregion auth_privateKeyJwt
    return transport;
}

// ---------------------------------------------------------------------------
// Using server features
// ---------------------------------------------------------------------------

/** Example: List and call tools. */
async function callTool_basic(client: Client) {
    //#region callTool_basic
    const { tools } = await client.listTools();
    console.log(
        'Available tools:',
        tools.map(t => t.name)
    );

    const result = await client.callTool({
        name: 'calculate-bmi',
        arguments: { weightKg: 70, heightM: 1.75 }
    });
    console.log(result.content);
    //#endregion callTool_basic
}

/** Example: List and read resources. */
async function readResource_basic(client: Client) {
    //#region readResource_basic
    const { resources } = await client.listResources();
    console.log(
        'Available resources:',
        resources.map(r => r.name)
    );

    const { contents } = await client.readResource({ uri: 'config://app' });
    for (const item of contents) {
        console.log(item);
    }
    //#endregion readResource_basic
}

/** Example: List and get prompts. */
async function getPrompt_basic(client: Client) {
    //#region getPrompt_basic
    const { prompts } = await client.listPrompts();
    console.log(
        'Available prompts:',
        prompts.map(p => p.name)
    );

    const { messages } = await client.getPrompt({
        name: 'review-code',
        arguments: { code: 'console.log("hello")' }
    });
    console.log(messages);
    //#endregion getPrompt_basic
}

/** Example: Request argument completions. */
async function complete_basic(client: Client) {
    //#region complete_basic
    const { completion } = await client.complete({
        ref: {
            type: 'ref/prompt',
            name: 'review-code'
        },
        argument: {
            name: 'language',
            value: 'type'
        }
    });
    console.log(completion.values); // e.g. ['typescript']
    //#endregion complete_basic
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Example: Handle log messages and list-change notifications. */
function notificationHandler_basic(client: Client) {
    //#region notificationHandler_basic
    // Server log messages (e.g. from ctx.mcpReq.log() in tool handlers)
    client.setNotificationHandler('notifications/message', notification => {
        const { level, data } = notification.params;
        console.log(`[${level}]`, data);
    });

    // Server's resource list changed — re-fetch the list
    client.setNotificationHandler('notifications/resources/list_changed', async () => {
        const { resources } = await client.listResources();
        console.log('Resources changed:', resources.length);
    });
    //#endregion notificationHandler_basic
}

/** Example: Automatic list-change tracking via the listChanged option. */
async function listChanged_basic() {
    //#region listChanged_basic
    const client = new Client(
        { name: 'my-client', version: '1.0.0' },
        {
            listChanged: {
                tools: {
                    onChanged: (error, tools) => {
                        if (error) {
                            console.error('Failed to refresh tools:', error);
                            return;
                        }
                        console.log('Tools updated:', tools);
                    }
                },
                prompts: {
                    onChanged: (error, prompts) => console.log('Prompts updated:', prompts)
                }
            }
        }
    );
    //#endregion listChanged_basic
    return client;
}

// ---------------------------------------------------------------------------
// Handling server-initiated requests
// ---------------------------------------------------------------------------

/** Example: Declare client capabilities for sampling and elicitation. */
function capabilities_declaration() {
    //#region capabilities_declaration
    const client = new Client(
        { name: 'my-client', version: '1.0.0' },
        {
            capabilities: {
                sampling: {},
                elicitation: { form: {} }
            }
        }
    );
    //#endregion capabilities_declaration
    return client;
}

/** Example: Handle a sampling request from the server. */
function sampling_handler(client: Client) {
    //#region sampling_handler
    client.setRequestHandler('sampling/createMessage', async request => {
        const lastMessage = request.params.messages.at(-1);
        console.log('Sampling request:', lastMessage);

        // In production, send messages to your LLM here
        return {
            model: 'my-model',
            role: 'assistant' as const,
            content: {
                type: 'text' as const,
                text: 'Response from the model'
            }
        };
    });
    //#endregion sampling_handler
}

/** Example: Handle an elicitation request from the server. */
function elicitation_handler(client: Client) {
    //#region elicitation_handler
    client.setRequestHandler('elicitation/create', async request => {
        console.log('Server asks:', request.params.message);

        if (request.params.mode === 'form') {
            // Present the schema-driven form to the user
            console.log('Schema:', request.params.requestedSchema);
            return { action: 'accept', content: { confirm: true } };
        }

        return { action: 'decline' };
    });
    //#endregion elicitation_handler
}

// ---------------------------------------------------------------------------
// Advanced patterns
// ---------------------------------------------------------------------------

/** Example: Client middleware that adds a custom header. */
async function middleware_basic() {
    //#region middleware_basic
    const authMiddleware = createMiddleware(async (next, input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('X-Custom-Header', 'my-value');
        return next(input, { ...init, headers });
    });

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
        fetch: applyMiddlewares(authMiddleware)(fetch)
    });
    //#endregion middleware_basic
    return transport;
}

/** Example: Track resumption tokens for SSE reconnection. */
async function resumptionToken_basic(client: Client) {
    //#region resumptionToken_basic
    let lastToken: string | undefined;

    const result = await client.request(
        {
            method: 'tools/call',
            params: { name: 'long-running-task', arguments: {} }
        },
        CallToolResultSchema,
        {
            resumptionToken: lastToken,
            onresumptiontoken: (token: string) => {
                lastToken = token;
                // Persist token to survive restarts
            }
        }
    );
    console.log(result);
    //#endregion resumptionToken_basic
}

// Suppress unused-function warnings (functions exist solely for type-checking)
void connect_streamableHttp;
void connect_stdio;
void connect_sseFallback;
void auth_clientCredentials;
void auth_privateKeyJwt;
void callTool_basic;
void readResource_basic;
void getPrompt_basic;
void complete_basic;
void notificationHandler_basic;
void listChanged_basic;
void capabilities_declaration;
void sampling_handler;
void elicitation_handler;
void middleware_basic;
void resumptionToken_basic;
