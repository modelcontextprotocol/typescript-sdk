/**
 * Example: Custom Protocol Version Support
 *
 * This demonstrates how to support protocol versions not yet in the SDK.
 * When a client (like Claude Code) uses a newer protocol version, you can
 * add support for it without waiting for an SDK update.
 *
 * Run with: pnpm tsx src/customProtocolVersion.ts
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { LATEST_PROTOCOL_VERSION, McpServer, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';

// Add support for a newer protocol version
// The server will pass these to the transport automatically during connect()
const CUSTOM_VERSIONS = ['2026-01-01', ...SUPPORTED_PROTOCOL_VERSIONS];

const server = new McpServer(
    { name: 'custom-protocol-server', version: '1.0.0' },
    {
        supportedProtocolVersions: CUSTOM_VERSIONS,
        protocolVersion: LATEST_PROTOCOL_VERSION, // fallback for unsupported versions
        capabilities: { tools: {} }
    }
);

// Register a tool that shows the protocol configuration
server.registerTool(
    'get-protocol-info',
    {
        title: 'Protocol Info',
        description: 'Returns protocol version configuration',
        inputSchema: {}
    },
    async (): Promise<CallToolResult> => ({
        content: [
            {
                type: 'text',
                text: JSON.stringify(
                    {
                        supportedVersions: CUSTOM_VERSIONS,
                        fallbackVersion: LATEST_PROTOCOL_VERSION
                    },
                    null,
                    2
                )
            }
        ]
    })
);

// Create transport - no need to configure versions here,
// server passes them automatically during connect()
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
    console.log(`MCP server with custom protocol versions on port ${PORT}`);
    console.log(`Supported versions: ${CUSTOM_VERSIONS.join(', ')}`);
});
