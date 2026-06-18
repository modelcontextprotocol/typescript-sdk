/**
 * `supportedProtocolVersions`: support a protocol version not yet in the SDK.
 * The first version in the list is the fallback when the client requests an
 * unsupported one. One binary, either transport.
 */
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';

import { runServerFromArgs } from '../harness.js';

// Add support for a newer protocol version (first in list is fallback).
const CUSTOM_VERSIONS = ['2026-01-01', ...SUPPORTED_PROTOCOL_VERSIONS];

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

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
