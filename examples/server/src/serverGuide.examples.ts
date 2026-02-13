/**
 * Type-checked examples for docs/server.md.
 *
 * Regions are synced into markdown code fences via `pnpm sync:snippets`.
 * Each function wraps a single region. The function name matches the region name.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult, ResourceLink } from '@modelcontextprotocol/server';
import { completable, McpServer, ResourceTemplate, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

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

// Suppress unused-function warnings (functions exist solely for type-checking)
void registerTool_basic;
void registerTool_resourceLink;
void registerTool_logging;
void registerTool_sampling;
void registerTool_elicitation;
void registerResource_static;
void registerResource_template;
void registerPrompt_basic;
void registerPrompt_completion;
void streamableHttp_stateful;
void streamableHttp_stateless;
void streamableHttp_jsonResponse;
void stdio_basic;
void dnsRebinding_basic;
void dnsRebinding_allowedHosts;
