/**
 * Gateway / distributed-client target server. A plain 2026-era MCP server with
 * a couple of tools and a `request_count` instrumentation tool that returns how
 * many requests have reached this process — `createMcpHandler` builds one
 * server instance per inbound request, so the module-level counter equals the
 * number of MCP requests served (server/discover, tools/call, …). The client
 * asserts against it to PROVE that `connect({ prior })` sent nothing.
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

let requestCount = 0;

function buildServer(): McpServer {
    requestCount++;
    const server = new McpServer({ name: 'gateway-target', version: '1.0.0' });

    server.registerTool('echo', { description: 'Echo the input back', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text }]
    }));

    server.registerTool('uppercase', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text: text.toUpperCase() }]
    }));

    // Exposes the process-wide request count so the client can assert exactly
    // which round trips happened. The factory increment for THIS call has
    // already run by the time the handler executes, so the returned value
    // includes the request_count call itself.
    server.registerTool('request_count', { description: 'Number of MCP requests this server process has received' }, async () => ({
        content: [{ type: 'text', text: String(requestCount) }]
    }));

    return server;
}

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
