/**
 * Type-checked examples for `client.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { Prompt, Resource, Tool } from '@modelcontextprotocol/core';

import { Client } from './client.js';
import { SSEClientTransport } from './sse.js';
import { StdioClientTransport } from './stdio.js';
import { StreamableHTTPClientTransport } from './streamableHttp.js';

/**
 * Example: Using listChanged to automatically track tool and prompt updates.
 */
function ClientOptions_listChanged() {
    //#region ClientOptions_listChanged
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
    //#endregion ClientOptions_listChanged
    return client;
}

/**
 * Example: Connect to a local server process over stdio.
 */
async function Client_connect_stdio() {
    //#region Client_connect_stdio
    const client = new Client({ name: 'my-client', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: 'my-mcp-server' });
    await client.connect(transport);
    //#endregion Client_connect_stdio
    return client;
}

/**
 * Example: Connect with Streamable HTTP, falling back to legacy SSE.
 */
async function Client_connect_sseFallback(url: string) {
    //#region Client_connect_sseFallback
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
    //#endregion Client_connect_sseFallback
}

/**
 * Example: Call a tool on the connected server.
 */
async function Client_callTool_basic(client: Client) {
    //#region Client_callTool_basic
    const result = await client.callTool({
        name: 'calculate-bmi',
        arguments: { weightKg: 70, heightM: 1.75 }
    });

    // Tool-level errors are returned in the result, not thrown
    if (result.isError) {
        console.error('Tool error:', result.content);
        return;
    }

    console.log(result.content);
    //#endregion Client_callTool_basic
}

/**
 * Example: Access machine-readable structured output from a tool call.
 */
async function Client_callTool_structuredOutput(client: Client) {
    //#region Client_callTool_structuredOutput
    const result = await client.callTool({
        name: 'calculate-bmi',
        arguments: { weightKg: 70, heightM: 1.75 }
    });

    // Machine-readable output for the client application
    if (result.structuredContent) {
        console.log(result.structuredContent); // e.g. { bmi: 22.86 }
    }
    //#endregion Client_callTool_structuredOutput
}

/**
 * Example: Handle a sampling request from the server.
 */
function Client_setRequestHandler_sampling(client: Client) {
    //#region Client_setRequestHandler_sampling
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
    //#endregion Client_setRequestHandler_sampling
}

/**
 * Example: List tools with cursor-based pagination.
 */
async function Client_listTools_pagination(client: Client) {
    //#region Client_listTools_pagination
    const allTools: Tool[] = [];
    let cursor: string | undefined;
    do {
        const { tools, nextCursor } = await client.listTools({ cursor });
        allTools.push(...tools);
        cursor = nextCursor;
    } while (cursor);
    console.log(
        'Available tools:',
        allTools.map(t => t.name)
    );
    //#endregion Client_listTools_pagination
}

/**
 * Example: List prompts with cursor-based pagination.
 */
async function Client_listPrompts_pagination(client: Client) {
    //#region Client_listPrompts_pagination
    const allPrompts: Prompt[] = [];
    let cursor: string | undefined;
    do {
        const { prompts, nextCursor } = await client.listPrompts({ cursor });
        allPrompts.push(...prompts);
        cursor = nextCursor;
    } while (cursor);
    console.log(
        'Available prompts:',
        allPrompts.map(p => p.name)
    );
    //#endregion Client_listPrompts_pagination
}

/**
 * Example: List resources with cursor-based pagination.
 */
async function Client_listResources_pagination(client: Client) {
    //#region Client_listResources_pagination
    const allResources: Resource[] = [];
    let cursor: string | undefined;
    do {
        const { resources, nextCursor } = await client.listResources({ cursor });
        allResources.push(...resources);
        cursor = nextCursor;
    } while (cursor);
    console.log(
        'Available resources:',
        allResources.map(r => r.name)
    );
    //#endregion Client_listResources_pagination
}
