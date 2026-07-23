/**
 * Regression coverage for #2232: `sendToolListChanged()` (and the equivalent
 * resource/prompt notifications) carry no `relatedRequestId`, so on a
 * stateless Streamable HTTP transport — which has no standalone GET SSE
 * stream for the transport to fall back to — a list-changed notification
 * fired from inside a request handler has nowhere to go and is silently
 * dropped, even though the response stream for the *current* request is
 * right there and able to carry it.
 */
import type { CallToolResult } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

async function readFullSSEBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let body = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
    }
    return body;
}

function buildServer(): McpServer {
    const mcpServer = new McpServer(
        { name: 'stateless-list-changed-test', version: '1.0.0' },
        { capabilities: { tools: { listChanged: true } } }
    );

    const hidden = mcpServer.registerTool(
        'hidden-tool',
        { description: 'Starts disabled', inputSchema: z.object({}) },
        async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: 'hidden' }] })
    );
    hidden.disable();

    mcpServer.registerTool(
        'enable-hidden',
        { description: 'Enables hidden-tool from inside its own handler', inputSchema: z.object({}) },
        async (): Promise<CallToolResult> => {
            hidden.enable();
            return { content: [{ type: 'text', text: 'enabled hidden-tool' }] };
        }
    );

    return mcpServer;
}

function postRequest(body: unknown): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(body)
    });
}

describe('stateless Streamable HTTP — tools/list_changed emitted from inside a tools/call handler', () => {
    it('delivers notifications/tools/list_changed on the same response stream as the tools/call result', async () => {
        const mcpServer = buildServer();
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcpServer.connect(transport);

        await transport.handleRequest(
            postRequest({
                jsonrpc: '2.0',
                id: 'init-1',
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } }
            })
        );

        const response = await transport.handleRequest(
            postRequest({
                jsonrpc: '2.0',
                id: 'call-1',
                method: 'tools/call',
                params: { name: 'enable-hidden', arguments: {} }
            })
        );

        expect(response.status).toBe(200);
        const body = await readFullSSEBody(response);

        // The tool call itself always succeeds — this is not in question.
        expect(body).toContain('enabled hidden-tool');

        // This is the bug: on a stateless transport there is no standalone SSE
        // stream for a `relatedRequestId`-less notification to land on, so it
        // is silently dropped instead of riding the current request's stream.
        expect(body).toContain('notifications/tools/list_changed');

        await transport.close();
        await mcpServer.close();
    });
});
