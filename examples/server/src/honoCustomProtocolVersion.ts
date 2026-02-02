/**
 * Example MCP server using Hono with custom protocol version support
 *
 * This example demonstrates how to configure custom protocol versions for servers
 * that need to support newer protocol versions not yet in the SDK's default list.
 *
 * Use case: When a client (like Claude Code) uses a newer protocol version that
 * your SDK version doesn't know about, you can add support for it by specifying
 * custom supportedProtocolVersions.
 *
 * Run with: pnpm tsx src/honoCustomProtocolVersion.ts
 */

import { serve } from '@hono/node-server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
    LATEST_PROTOCOL_VERSION,
    McpServer,
    SUPPORTED_PROTOCOL_VERSIONS,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as z from 'zod/v4';

// Define custom protocol versions
// This example shows how to add support for a hypothetical future version
// while maintaining backwards compatibility with all existing versions
const CUSTOM_SUPPORTED_VERSIONS = [
    '2026-01-01', // Hypothetical future version
    ...SUPPORTED_PROTOCOL_VERSIONS // Include all default supported versions
];

// Create the MCP server with custom protocol version support
const server = new McpServer(
    {
        name: 'hono-custom-protocol-server',
        version: '1.0.0'
    },
    {
        // Custom supported versions for protocol negotiation
        supportedProtocolVersions: CUSTOM_SUPPORTED_VERSIONS,
        // Fallback version when client requests an unsupported version
        protocolVersion: LATEST_PROTOCOL_VERSION
    }
);

// Register a tool that reports the server's protocol version capabilities
server.registerTool(
    'get-protocol-info',
    {
        title: 'Protocol Info',
        description: "Returns information about the server's protocol version support",
        inputSchema: {}
    },
    async (): Promise<CallToolResult> => {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(
                        {
                            latestVersion: LATEST_PROTOCOL_VERSION,
                            supportedVersions: CUSTOM_SUPPORTED_VERSIONS,
                            message: 'This server supports custom protocol versions including future versions'
                        },
                        null,
                        2
                    )
                }
            ]
        };
    }
);

// Register a simple echo tool
server.registerTool(
    'echo',
    {
        title: 'Echo Tool',
        description: 'Echoes back the input message',
        inputSchema: { message: z.string().describe('Message to echo') }
    },
    async ({ message }): Promise<CallToolResult> => {
        return {
            content: [{ type: 'text', text: `Echo: ${message}` }]
        };
    }
);

// Create a stateless transport with custom protocol version support
// The transport also needs to know about supported versions to validate
// the mcp-protocol-version header in incoming requests
const transport = new WebStandardStreamableHTTPServerTransport({
    supportedProtocolVersions: CUSTOM_SUPPORTED_VERSIONS
});

// Create the Hono app
const app = new Hono();

// Enable CORS for all origins
app.use(
    '*',
    cors({
        origin: '*',
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
        exposeHeaders: ['mcp-session-id', 'mcp-protocol-version']
    })
);

// Health check endpoint
app.get('/health', c =>
    c.json({
        status: 'ok',
        protocolVersions: {
            latest: LATEST_PROTOCOL_VERSION,
            supported: CUSTOM_SUPPORTED_VERSIONS
        }
    })
);

// MCP endpoint
app.all('/mcp', c => transport.handleRequest(c.req.raw));

// Start the server
const PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;

await server.connect(transport);

console.log(`Starting Hono MCP server with custom protocol version support on port ${PORT}`);
console.log(`Health check: http://localhost:${PORT}/health`);
console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
console.log(`\nSupported protocol versions:`);
for (const v of CUSTOM_SUPPORTED_VERSIONS) console.log(`  - ${v}`);

serve({
    fetch: app.fetch,
    port: PORT
});
