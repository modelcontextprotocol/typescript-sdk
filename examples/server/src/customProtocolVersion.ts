/**
 * Example: Restricting Protocol Versions
 *
 * Demonstrates pinning `supportedProtocolVersions` to a subset of the SDK's
 * stateful versions (e.g. for compatibility testing against older clients).
 *
 * Only versions in STATEFUL_PROTOCOL_VERSIONS negotiate via the `initialize`
 * handshake; revisions after 2025-11-25 negotiate per-request and are ignored
 * by the handshake.
 *
 * Run with: pnpm tsx src/customProtocolVersion.ts
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, STATEFUL_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';

// Pin to the two most recent stateful versions (newest first is preferred).
const PINNED_VERSIONS = STATEFUL_PROTOCOL_VERSIONS.slice(0, 2);

const server = new McpServer(
    { name: 'pinned-protocol-server', version: '1.0.0' },
    {
        supportedProtocolVersions: PINNED_VERSIONS,
        capabilities: { tools: {} }
    }
);

// Register a tool that shows the protocol configuration
server.registerTool(
    'get-protocol-info',
    {
        title: 'Protocol Info',
        description: 'Returns protocol version configuration'
    },
    async (): Promise<CallToolResult> => ({
        content: [
            {
                type: 'text',
                text: JSON.stringify({ supportedVersions: PINNED_VERSIONS }, null, 2)
            }
        ]
    })
);

// Create transport - server passes versions automatically during connect()
const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
});

await server.connect(transport);

// Simple HTTP server
const PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;

createServer(async (req, res) => {
    if (req.url === '/mcp') {
        await transport.handleRequest(req, res);
    } else {
        res.writeHead(404).end('Not Found');
    }
}).listen(PORT, () => {
    console.log(`MCP server with pinned protocol versions on port ${PORT}`);
    console.log(`Supported versions: ${PINNED_VERSIONS.join(', ')}`);
});
