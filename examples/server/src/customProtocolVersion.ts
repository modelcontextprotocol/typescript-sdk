/**
 * Example: Custom Protocol Version Support
 *
 * This demonstrates how to customize the protocol versions a server negotiates.
 * The supported list may contain released protocol versions (SUPPORTED_PROTOCOL_VERSIONS)
 * and — with the explicit allowDraftVersions opt-in — draft versions (DRAFT_PROTOCOL_VERSIONS).
 * Unknown version strings are rejected at construction.
 *
 * First version in the list is used as fallback when a client requests
 * an unsupported version.
 *
 * Run with: pnpm tsx src/customProtocolVersion.ts
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { DRAFT_PROTOCOL_VERSION_2026, McpServer, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';

// Opt in to the draft protocol revision in addition to all released versions.
// Two keys are required: the draft version must be listed explicitly AND
// allowDraftVersions must be true — otherwise construction throws.
// Note: the opt-in only makes this configuration constructible; the SDK does not
// yet negotiate or serve draft protocol versions, so this server still serves
// released-protocol traffic.
const CUSTOM_VERSIONS = [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION_2026];

const server = new McpServer(
    { name: 'custom-protocol-server', version: '1.0.0' },
    {
        supportedProtocolVersions: CUSTOM_VERSIONS,
        allowDraftVersions: true,
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
                text: JSON.stringify({ supportedVersions: CUSTOM_VERSIONS }, null, 2)
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
    console.log(`MCP server with custom protocol versions on port ${PORT}`);
    console.log(`Supported versions: ${CUSTOM_VERSIONS.join(', ')}`);
});
