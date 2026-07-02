/**
 * `supportedProtocolVersions`: support a protocol version not yet in the SDK.
 * The first version in the list is the fallback when the client requests an
 * unsupported one. One binary, either transport.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer, SUPPORTED_LEGACY_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// Add support for a newer protocol version (first in list is fallback).
const CUSTOM_VERSIONS = ['2026-01-01', ...SUPPORTED_LEGACY_PROTOCOL_VERSIONS];

function buildServer(): McpServer {
    const server = new McpServer(
        { name: 'custom-protocol-server', version: '1.0.0' },
        { supportedProtocolVersions: CUSTOM_VERSIONS, capabilities: { tools: {} } }
    );

    server.registerTool('get-protocol-info', { description: 'Returns protocol version configuration' }, async () => ({
        content: [{ type: 'text', text: JSON.stringify({ supportedVersions: CUSTOM_VERSIONS }) }]
    }));

    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    createServer(toNodeHandler(handler)).listen(port, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
