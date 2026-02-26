/**
 * Type-checked examples for `mcp.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { CallToolResult } from '@modelcontextprotocol/core';
import * as z from 'zod/v4';

import { McpServer } from './mcp.js';
import { StdioServerTransport } from './stdio.js';

/**
 * Example: Creating a new McpServer.
 */
function McpServer_basicUsage() {
    //#region McpServer_basicUsage
    const server = new McpServer({
        name: 'my-server',
        version: '1.0.0'
    });
    //#endregion McpServer_basicUsage
    return server;
}

/**
 * Example: Registering a tool with inputSchema and outputSchema.
 */
function McpServer_registerTool_basic(server: McpServer) {
    //#region McpServer_registerTool_basic
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
    //#endregion McpServer_registerTool_basic
}

/**
 * Example: Registering a static resource at a fixed URI.
 */
function McpServer_registerResource_static(server: McpServer) {
    //#region McpServer_registerResource_static
    server.registerResource(
        'config',
        'config://app',
        {
            title: 'Application Config',
            mimeType: 'text/plain'
        },
        async uri => ({
            contents: [{ uri: uri.href, text: 'App configuration here' }]
        })
    );
    //#endregion McpServer_registerResource_static
}

/**
 * Example: Registering a prompt with an argument schema.
 */
function McpServer_registerPrompt_basic(server: McpServer) {
    //#region McpServer_registerPrompt_basic
    server.registerPrompt(
        'review-code',
        {
            title: 'Code Review',
            description: 'Review code for best practices',
            argsSchema: z.object({ code: z.string() })
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
    //#endregion McpServer_registerPrompt_basic
}

/**
 * Example: Connecting an McpServer to a stdio transport.
 */
async function McpServer_connect_stdio() {
    //#region McpServer_connect_stdio
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    //#endregion McpServer_connect_stdio
}

/**
 * Example: Sending a log message to the client.
 */
async function McpServer_sendLoggingMessage_basic(server: McpServer) {
    //#region McpServer_sendLoggingMessage_basic
    await server.sendLoggingMessage({
        level: 'info',
        data: 'Processing complete'
    });
    //#endregion McpServer_sendLoggingMessage_basic
}

/**
 * Example: Logging from inside a tool handler via ctx.mcpReq.log().
 */
function McpServer_registerTool_logging(server: McpServer) {
    //#region McpServer_registerTool_logging
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
    //#endregion McpServer_registerTool_logging
}
