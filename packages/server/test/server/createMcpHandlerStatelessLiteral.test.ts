/**
 * Wire-level continuity twin for the "Unsupported protocol version" rejection,
 * exercised through `createMcpHandler(factory, { legacy: 'stateless' })`.
 *
 * The legacy slot routes 2025-era traffic through the untouched streamable HTTP
 * transport, so the rejection site (and therefore the wire bytes deployed
 * clients sniff — see streamableHttpUnsupportedVersionLiteral.test.ts for the
 * go-sdk substring dependency) is the same one the standalone transport test
 * pins. This twin asserts the bytes hold on the sugar path itself: HTTP 400,
 * code -32000, and the literal substring `Unsupported protocol version`, with
 * the supported-versions suffix derived from `SUPPORTED_PROTOCOL_VERSIONS`.
 */
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { createMcpHandler } from '../../src/server/createMcpHandler.js';
import { McpServer } from '../../src/server/mcp.js';

interface JSONRPCErrorBody {
    jsonrpc: string;
    id: unknown;
    error: { code: number; message: string };
}

function factory(): McpServer {
    const mcpServer = new McpServer({ name: 'literal-twin', version: '1.0.0' });
    mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return mcpServer;
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...headers
        },
        body: JSON.stringify(body)
    });
}

describe('createMcpHandler legacy:"stateless" — unsupported protocol version wire literal continuity', () => {
    it('rejects an unsupported MCP-Protocol-Version header with HTTP 400, code -32000, and the sniffed literal substring', async () => {
        const handler = createMcpHandler(factory, { legacy: 'stateless' });

        // The probe header is an unsupported 2025-era version string: that is what a
        // deployed 2025 client can actually send. (A 2026-or-later header on a body
        // without an envelope claim is a header/body cross-check disagreement and is
        // answered by the classifier before legacy serving is reached.)
        const response = await handler.fetch(
            postRequest({ jsonrpc: '2.0', id: 'tools-1', method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2024-01-01' })
        );

        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toContain('application/json');

        const rawBody = await response.text();
        // The substring deployed clients (go-sdk) sniff must appear verbatim in the wire bytes.
        expect(rawBody).toContain('Unsupported protocol version');

        const body = JSON.parse(rawBody) as JSONRPCErrorBody;
        expect(body.jsonrpc).toBe('2.0');
        expect(body.id).toBeNull();
        expect(body.error.code).toBe(-32_000);
        expect(body.error.message).toBe(
            `Bad Request: Unsupported protocol version: 2024-01-01 (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`
        );
    });

    it('keeps serving supported 2025-era traffic on the same path (the rejection is header-keyed, not blanket)', async () => {
        const handler = createMcpHandler(factory, { legacy: 'stateless' });

        const response = await handler.fetch(
            postRequest({ jsonrpc: '2.0', id: 'tools-1', method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-11-25' })
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('"tools"');
    });
});
