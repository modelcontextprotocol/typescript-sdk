/**
 * Type-checked examples for docs/server.md.
 *
 * Regions are synced into markdown code fences via `pnpm sync:snippets`.
 * Each function wraps a single region. The function name matches the region name.
 *
 * @module
 */

//#region imports
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth
} from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import type { CallToolResult, InputRequiredResult, OAuthMetadata, ResourceLink } from '@modelcontextprotocol/server';
import {
    acceptedContent,
    completable,
    createMcpHandler,
    createRequestStateCodec,
    inputRequired,
    McpServer,
    ResourceTemplate,
    TRACEPARENT_META_KEY
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
//#endregion imports

// ---------------------------------------------------------------------------
// Server instructions
// ---------------------------------------------------------------------------

/** Example: McpServer with instructions for LLM guidance. */
function instructions_basic() {
    //#region instructions_basic
    const server = new McpServer(
        { name: 'db-server', version: '1.0.0' },
        {
            instructions:
                'Always call list_tables before running queries. Use validate_schema before migrate_schema for safe migrations. Results are limited to 1000 rows.'
        }
    );
    //#endregion instructions_basic
    return server;
}

// ---------------------------------------------------------------------------
// Tools, resources, and prompts
// ---------------------------------------------------------------------------

/** Example: Registering a tool with inputSchema, outputSchema, and structuredContent. */
function registerTool_basic(server: McpServer) {
    //#region registerTool_basic
    server.registerTool(
        'calculate-bmi',
        {
            title: 'BMI Calculator',
            description: 'Calculate Body Mass Index',
            inputSchema: z.object({
                weightKg: z.number(),
                heightM: z.number()
            }),
            outputSchema: z.object({ bmi: z.number() })
        },
        async ({ weightKg, heightM }) => {
            const output = { bmi: weightKg / (heightM * heightM) };
            return {
                content: [{ type: 'text', text: JSON.stringify(output) }],
                structuredContent: output
            };
        }
    );
    //#endregion registerTool_basic
}

/** Example: Tool returning resource_link content items. */
function registerTool_resourceLink(server: McpServer) {
    //#region registerTool_resourceLink
    server.registerTool(
        'list-files',
        {
            title: 'List Files',
            description: 'Returns files as resource links without embedding content'
        },
        async (): Promise<CallToolResult> => {
            const links: ResourceLink[] = [
                {
                    type: 'resource_link',
                    uri: 'file:///projects/readme.md',
                    name: 'README',
                    mimeType: 'text/markdown'
                },
                {
                    type: 'resource_link',
                    uri: 'file:///projects/config.json',
                    name: 'Config',
                    mimeType: 'application/json'
                }
            ];
            return { content: links };
        }
    );
    //#endregion registerTool_resourceLink
}

/** Example: Tool with explicit error handling using isError. */
function registerTool_errorHandling(server: McpServer) {
    //#region registerTool_errorHandling
    server.registerTool(
        'fetch-data',
        {
            description: 'Fetch data from a URL',
            inputSchema: z.object({ url: z.string() })
        },
        async ({ url }): Promise<CallToolResult> => {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    return {
                        content: [{ type: 'text', text: `HTTP ${res.status}: ${res.statusText}` }],
                        isError: true
                    };
                }
                const text = await res.text();
                return { content: [{ type: 'text', text }] };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Failed: ${error instanceof Error ? error.message : String(error)}` }],
                    isError: true
                };
            }
        }
    );
    //#endregion registerTool_errorHandling
}

/** Example: Tool with annotations hinting at behavior. */
function registerTool_annotations(server: McpServer) {
    //#region registerTool_annotations
    server.registerTool(
        'delete-file',
        {
            description: 'Delete a file from the project',
            inputSchema: z.object({ path: z.string() }),
            annotations: {
                title: 'Delete File',
                destructiveHint: true,
                idempotentHint: true
            }
        },
        async ({ path }): Promise<CallToolResult> => {
            // ... perform deletion ...
            return { content: [{ type: 'text', text: `Deleted ${path}` }] };
        }
    );
    //#endregion registerTool_annotations
}

/** Example: Advertising icons a client can render in its UI for a tool. */
function registerTool_icons(server: McpServer) {
    //#region registerTool_icons
    server.registerTool(
        'generate-chart',
        {
            title: 'Generate Chart',
            description: 'Render a chart from a series of numbers',
            inputSchema: z.object({ data: z.array(z.number()) }),
            // Icons a client may render in its UI. `src` is required; `mimeType`,
            // `sizes`, and `theme` ('light' | 'dark') are optional hints.
            icons: [
                { src: 'https://example.com/icons/chart.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
                { src: 'https://example.com/icons/chart-48.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'light' }
            ]
        },
        async ({ data }): Promise<CallToolResult> => {
            // ... render chart ...
            return { content: [{ type: 'text', text: `Charted ${data.length} points` }] };
        }
    );
    //#endregion registerTool_icons
}

/** Example: Registering a static resource at a fixed URI. */
function registerResource_static(server: McpServer) {
    //#region registerResource_static
    server.registerResource(
        'config',
        'config://app',
        {
            title: 'Application Config',
            description: 'Application configuration data',
            mimeType: 'text/plain'
        },
        async uri => ({
            contents: [{ uri: uri.href, text: 'App configuration here' }]
        })
    );
    //#endregion registerResource_static
}

/** Example: Dynamic resource with ResourceTemplate and listing. */
function registerResource_template(server: McpServer) {
    //#region registerResource_template
    server.registerResource(
        'user-profile',
        new ResourceTemplate('user://{userId}/profile', {
            list: async () => ({
                resources: [
                    { uri: 'user://123/profile', name: 'Alice' },
                    { uri: 'user://456/profile', name: 'Bob' }
                ]
            })
        }),
        {
            title: 'User Profile',
            description: 'User profile data',
            mimeType: 'application/json'
        },
        async (uri, { userId }) => ({
            contents: [
                {
                    uri: uri.href,
                    text: JSON.stringify({ userId, name: 'Example User' })
                }
            ]
        })
    );
    //#endregion registerResource_template
}

/** Example: Registering a prompt with argsSchema. */
function registerPrompt_basic(server: McpServer) {
    //#region registerPrompt_basic
    server.registerPrompt(
        'review-code',
        {
            title: 'Code Review',
            description: 'Review code for best practices and potential issues',
            argsSchema: z.object({
                code: z.string()
            })
        },
        ({ code }) => ({
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `Please review this code:\n\n${code}`
                    }
                }
            ]
        })
    );
    //#endregion registerPrompt_basic
}

/** Example: Prompt with completable argsSchema for autocompletion. */
function registerPrompt_completion(server: McpServer) {
    //#region registerPrompt_completion
    server.registerPrompt(
        'review-code',
        {
            title: 'Code Review',
            description: 'Review code for best practices',
            argsSchema: z.object({
                language: completable(z.string().describe('Programming language'), value =>
                    ['typescript', 'javascript', 'python', 'rust', 'go'].filter(lang => lang.startsWith(value))
                )
            })
        },
        ({ language }) => ({
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `Review this ${language} code for best practices.`
                    }
                }
            ]
        })
    );
    //#endregion registerPrompt_completion
}

// ---------------------------------------------------------------------------
// Extension capabilities
// ---------------------------------------------------------------------------

/** Example: Declare an extension capability with its settings. */
function extensionCapabilities_register(server: McpServer) {
    //#region extensionCapabilities_register
    server.server.registerCapabilities({
        extensions: { 'com.example/feature-flags': { flags: ['dark-mode', 'beta-search'] } }
    });
    //#endregion extensionCapabilities_register
}

// ---------------------------------------------------------------------------
// Cache hints
// ---------------------------------------------------------------------------

/** Example: cache hints via ServerOptions.cacheHints and a per-resource cacheHint. */
function cacheHints_basic() {
    //#region cacheHints_basic
    const server = new McpServer(
        { name: 'my-server', version: '1.0.0' },
        {
            cacheHints: {
                // The tool list is the same for every caller and rarely changes:
                'tools/list': { ttlMs: 60_000, cacheScope: 'public' }
            }
        }
    );

    server.registerResource(
        'config',
        'config://app',
        {
            mimeType: 'text/plain',
            // Wins field-by-field over a cacheHints['resources/read'] entry;
            // cacheScope stays at the 'private' default here.
            cacheHint: { ttlMs: 300_000 }
        },
        async uri => ({
            contents: [{ uri: uri.href, text: 'App configuration here' }]
        })
    );
    //#endregion cacheHints_basic
    return server;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Example: Server with logging capability + tool that logs progress messages. */
function registerTool_logging() {
    //#region logging_capability
    const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { logging: {} } });
    //#endregion logging_capability

    //#region registerTool_logging
    server.registerTool(
        'fetch-data',
        {
            description: 'Fetch data from an API',
            inputSchema: z.object({ url: z.string() })
        },
        async ({ url }, ctx): Promise<CallToolResult> => {
            await ctx.mcpReq.log('info', `Fetching ${url}`);
            const res = await fetch(url);
            await ctx.mcpReq.log('debug', `Response status: ${res.status}`);
            const text = await res.text();
            return { content: [{ type: 'text', text }] };
        }
    );
    //#endregion registerTool_logging
    return server;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Example: Tool that sends progress notifications during a long-running operation. */
function registerTool_progress(server: McpServer) {
    //#region registerTool_progress
    server.registerTool(
        'process-files',
        {
            description: 'Process files with progress updates',
            inputSchema: z.object({ files: z.array(z.string()) })
        },
        async ({ files }, ctx): Promise<CallToolResult> => {
            const progressToken = ctx.mcpReq._meta?.progressToken;

            for (let i = 0; i < files.length; i++) {
                // ... process files[i] ...

                if (progressToken !== undefined) {
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: {
                            progressToken,
                            progress: i + 1,
                            total: files.length,
                            message: `Processed ${files[i]}`
                        }
                    });
                }
            }

            return { content: [{ type: 'text', text: `Processed ${files.length} files` }] };
        }
    );
    //#endregion registerTool_progress
}

/** Example: Tool that reads W3C Trace Context from request `_meta`. */
function registerTool_traceContext(server: McpServer) {
    //#region registerTool_traceContext
    server.registerTool(
        'traced-operation',
        {
            description: 'Operation that participates in distributed tracing',
            inputSchema: z.object({ query: z.string() })
        },
        async ({ query }, ctx): Promise<CallToolResult> => {
            // e.g. '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
            const traceparent = ctx.mcpReq._meta?.[TRACEPARENT_META_KEY];
            if (typeof traceparent === 'string') {
                // Continue the caller's trace, e.g. start a child span with your
                // OpenTelemetry tracer using this trace context.
            }

            return { content: [{ type: 'text', text: `Results for ${query}` }] };
        }
    );
    //#endregion registerTool_traceContext
}

// ---------------------------------------------------------------------------
// Change notifications
// ---------------------------------------------------------------------------

/** Example: hand-wired resources/subscribe handlers + sendResourceUpdated (2025-era). */
function subscriptions_legacy() {
    //#region subscriptions_legacy
    const server = new McpServer(
        { name: 'my-server', version: '1.0.0' },
        { capabilities: { resources: { subscribe: true, listChanged: true } } }
    );

    const subscriptions = new Set<string>();
    server.server.setRequestHandler('resources/subscribe', async request => {
        subscriptions.add(request.params.uri);
        return {};
    });
    server.server.setRequestHandler('resources/unsubscribe', async request => {
        subscriptions.delete(request.params.uri);
        return {};
    });

    // When the underlying data changes:
    async function onConfigChanged() {
        if (subscriptions.has('config://app')) {
            await server.server.sendResourceUpdated({ uri: 'config://app' });
        }
    }
    //#endregion subscriptions_legacy
    return onConfigChanged;
}

/** Example: publishing change events through the createMcpHandler notify facade (2026-07-28). */
function subscriptions_notify(buildServer: () => McpServer) {
    //#region subscriptions_notify
    const handler = createMcpHandler(() => buildServer());

    // When the underlying data changes:
    handler.notify.resourceUpdated('config://app');
    handler.notify.toolsChanged();
    //#endregion subscriptions_notify
    return handler;
}

// ---------------------------------------------------------------------------
// Server-initiated requests
// ---------------------------------------------------------------------------

/** Example: Tool that uses sampling to request an LLM completion from the client. */
function registerTool_sampling(server: McpServer) {
    //#region registerTool_sampling
    server.registerTool(
        'summarize',
        {
            description: 'Summarize text using the client LLM',
            inputSchema: z.object({ text: z.string() })
        },
        async ({ text }, ctx): Promise<CallToolResult> => {
            const response = await ctx.mcpReq.requestSampling({
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Please summarize:\n\n${text}`
                        }
                    }
                ],
                maxTokens: 500
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Model (${response.model}): ${JSON.stringify(response.content)}`
                    }
                ]
            };
        }
    );
    //#endregion registerTool_sampling
}

/** Example: Tool that uses form elicitation to collect user input. */
function registerTool_elicitation(server: McpServer) {
    //#region registerTool_elicitation
    server.registerTool(
        'collect-feedback',
        {
            description: 'Collect user feedback via a form',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult> => {
            const result = await ctx.mcpReq.elicitInput({
                mode: 'form',
                message: 'Please share your feedback:',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        rating: {
                            type: 'number',
                            title: 'Rating (1\u20135)',
                            minimum: 1,
                            maximum: 5
                        },
                        comment: { type: 'string', title: 'Comment' }
                    },
                    required: ['rating']
                }
            });
            if (result.action === 'accept') {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Thanks! ${JSON.stringify(result.content)}`
                        }
                    ]
                };
            }
            return { content: [{ type: 'text', text: 'Feedback declined.' }] };
        }
    );
    //#endregion registerTool_elicitation
}

/** Example: Tool that requests the client's filesystem roots. */
function registerTool_roots(server: McpServer) {
    //#region registerTool_roots
    server.registerTool(
        'list-workspace-files',
        {
            description: 'List files across all workspace roots',
            inputSchema: z.object({})
        },
        async (_args, _ctx): Promise<CallToolResult> => {
            const { roots } = await server.server.listRoots();
            const summary = roots.map(r => `${r.name ?? r.uri}: ${r.uri}`).join('\n');
            return { content: [{ type: 'text', text: summary }] };
        }
    );
    //#endregion registerTool_roots
}

/** Example: write-once tool requesting input via an input_required return (2026-07-28). */
function registerTool_inputRequired(server: McpServer) {
    //#region registerTool_inputRequired
    server.registerTool(
        'deploy',
        {
            description: 'Deploy after user confirmation',
            inputSchema: z.object({ env: z.string() })
        },
        async ({ env }, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
            if (confirmed?.confirm !== true) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: `Deploy to ${env}?`,
                            requestedSchema: {
                                type: 'object',
                                properties: { confirm: { type: 'boolean' } },
                                required: ['confirm']
                            }
                        })
                    }
                });
            }
            return { content: [{ type: 'text', text: `Deployed to ${env}` }] };
        }
    );
    //#endregion registerTool_inputRequired
}

/** Example: HMAC-protected requestState via createRequestStateCodec + the verify hook. */
function requestState_codec() {
    //#region requestState_codec
    const stateCodec = createRequestStateCodec<{ step: string }>({
        key: crypto.getRandomValues(new Uint8Array(32)), // >= 32 bytes; share across instances in a fleet
        ttlSeconds: 600
    });

    const server = new McpServer(
        { name: 'my-server', version: '1.0.0' },
        { capabilities: { tools: {} }, requestState: { verify: stateCodec.verify } }
    );
    //#endregion requestState_codec

    //#region requestState_mintDecode
    server.registerTool(
        'wipe-cache',
        { description: 'Confirm, then pick a scope, then wipe', inputSchema: z.object({}) },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const state = ctx.mcpReq.requestState<{ step: string }>();

            if (state?.step !== 'confirmed') {
                const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
                if (confirmed?.confirm !== true) {
                    return inputRequired({
                        inputRequests: {
                            confirm: inputRequired.elicit({
                                message: 'Really wipe the cache?',
                                requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                            })
                        }
                    });
                }
                // Mint only what the response above already proved: the user confirmed.
                return inputRequired({
                    inputRequests: {
                        scope: inputRequired.elicit({
                            message: 'Which scope?',
                            requestedSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'] }
                        })
                    },
                    requestState: await stateCodec.mint({ step: 'confirmed' })
                });
            }

            const scope = acceptedContent<{ scope: string }>(ctx.mcpReq.inputResponses, 'scope');
            return { content: [{ type: 'text', text: `Wiped ${scope?.scope ?? 'all'}` }] };
        }
    );
    //#endregion requestState_mintDecode
    return server;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** Example: Stateful Streamable HTTP transport with session management. */
async function streamableHttp_stateful() {
    //#region streamableHttp_stateful
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });

    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID()
    });

    await server.connect(transport);
    //#endregion streamableHttp_stateful
}

/** Example: Stateless Streamable HTTP transport (no session persistence). */
async function streamableHttp_stateless() {
    //#region streamableHttp_stateless
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });

    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });

    await server.connect(transport);
    //#endregion streamableHttp_stateless
}

/** Example: Streamable HTTP with JSON response mode (no SSE). */
async function streamableHttp_jsonResponse() {
    //#region streamableHttp_jsonResponse
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });

    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true
    });

    await server.connect(transport);
    //#endregion streamableHttp_jsonResponse
}

/** Example: stdio transport for local process-spawned integrations. */
async function stdio_basic() {
    //#region stdio_basic
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    //#endregion stdio_basic
}

/** Example: serveStdio serving both protocol eras on stdio from one factory. */
function serveStdio_basic() {
    //#region serveStdio_basic
    serveStdio(() => {
        const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        // register tools/resources/prompts once; the same factory serves both eras
        return server;
    });
    //#endregion serveStdio_basic
}

/** Example: createMcpHandler serving both protocol eras over HTTP from one factory. */
function createMcpHandler_basic() {
    //#region createMcpHandler_basic
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        // register tools/resources/prompts once; the same factory serves both eras
        return server;
    });
    //#endregion createMcpHandler_basic
    return handler;
}

/** Example: mounting an McpHttpHandler on node:http via toNodeHandler. */
function createMcpHandler_node(handler: ReturnType<typeof createMcpHandler>) {
    //#region createMcpHandler_node
    createServer(toNodeHandler(handler)).listen(3000);
    // Express: app.all('/mcp', toNodeHandler(handler));
    // behind express.json(): const node = toNodeHandler(handler); app.all('/mcp', (req, res) => void node(req, res, req.body));
    //#endregion createMcpHandler_node
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/** Example: Graceful shutdown for a stateful multi-session HTTP server. */
function shutdown_statefulHttp(app: ReturnType<typeof createMcpExpressApp>, transports: Map<string, NodeStreamableHTTPServerTransport>) {
    //#region shutdown_statefulHttp
    // Capture the http.Server so it can be closed on shutdown
    const httpServer = app.listen(3000);

    process.on('SIGINT', async () => {
        httpServer.close();

        for (const [sessionId, transport] of transports) {
            await transport.close();
            transports.delete(sessionId);
        }

        process.exit(0);
    });
    //#endregion shutdown_statefulHttp
}

/** Example: Graceful shutdown for a stdio server. */
function shutdown_stdio(server: McpServer) {
    //#region shutdown_stdio
    process.on('SIGINT', async () => {
        await server.close();
        process.exit(0);
    });
    //#endregion shutdown_stdio
}

// ---------------------------------------------------------------------------
// DNS rebinding protection
// ---------------------------------------------------------------------------

/** Example: createMcpExpressApp with different host bindings. */
function dnsRebinding_basic() {
    //#region dnsRebinding_basic
    // Default: DNS rebinding protection auto-enabled (host is 127.0.0.1)
    const app = createMcpExpressApp();

    // DNS rebinding protection also auto-enabled for localhost
    const appLocal = createMcpExpressApp({ host: 'localhost' });

    // No automatic protection when binding to all interfaces
    const appOpen = createMcpExpressApp({ host: '0.0.0.0' });
    //#endregion dnsRebinding_basic
    return { app, appLocal, appOpen };
}

/** Example: createMcpExpressApp with allowedHosts for non-localhost binding. */
function dnsRebinding_allowedHosts() {
    //#region dnsRebinding_allowedHosts
    const app = createMcpExpressApp({
        host: '0.0.0.0',
        allowedHosts: ['localhost', '127.0.0.1', 'myhost.local']
    });
    //#endregion dnsRebinding_allowedHosts
    return app;
}

// ---------------------------------------------------------------------------
// Authorization (OAuth resource server)
// ---------------------------------------------------------------------------

/** Example: protecting an HTTP server as an OAuth resource server. */
function auth_resourceServer(
    verifyJwt: (token: string) => Promise<{ sub: string; scopes: string[]; exp: number }>,
    oauthMetadata: OAuthMetadata,
    buildServer: () => McpServer
) {
    //#region auth_resourceServer
    const mcpServerUrl = new URL('https://api.example.com/mcp');

    // Verify tokens however your deployment requires: JWT verification,
    // RFC 7662 introspection, a call to your IdP.
    const verifier: OAuthTokenVerifier = {
        async verifyAccessToken(token) {
            const payload = await verifyJwt(token);
            return { token, clientId: payload.sub, scopes: payload.scopes, expiresAt: payload.exp };
        }
    };

    // Public deployment: allow-list the public host (see DNS rebinding protection).
    const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });

    // Serves /.well-known/oauth-protected-resource/mcp (RFC 9728) and mirrors the
    // authorization server's metadata, so clients can discover your AS.
    app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl }));

    // 401/403 responses carry `WWW-Authenticate: Bearer …` with `resource_metadata`
    // pointing at the document above. That challenge is what starts the client
    // SDK's OAuth flow.
    const auth = requireBearerAuth({
        verifier,
        requiredScopes: ['mcp'],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
    });

    const node = toNodeHandler(createMcpHandler(buildServer));
    app.all('/mcp', auth, (req, res) => void node(req, res, req.body));
    //#endregion auth_resourceServer
    return app;
}

// Suppress unused-function warnings (functions exist solely for type-checking)
void instructions_basic;
void registerTool_basic;
void registerTool_resourceLink;
void registerTool_errorHandling;
void registerTool_annotations;
void registerTool_icons;
void registerTool_logging;
void registerTool_progress;
void registerTool_traceContext;
void registerTool_sampling;
void registerTool_elicitation;
void registerTool_roots;
void registerTool_inputRequired;
void requestState_codec;
void registerResource_static;
void registerResource_template;
void registerPrompt_basic;
void registerPrompt_completion;
void extensionCapabilities_register;
void cacheHints_basic;
void subscriptions_legacy;
void subscriptions_notify;
void streamableHttp_stateful;
void streamableHttp_stateless;
void streamableHttp_jsonResponse;
void stdio_basic;
void serveStdio_basic;
void createMcpHandler_basic;
void createMcpHandler_node;
void shutdown_statefulHttp;
void shutdown_stdio;
void dnsRebinding_basic;
void dnsRebinding_allowedHosts;
void auth_resourceServer;
