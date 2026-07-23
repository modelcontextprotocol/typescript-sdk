/**
 * Gateway / distributed-client target server. A plain 2026-era MCP server with
 * a couple of tools and a `request_count` instrumentation tool that returns how
 * many requests have reached this process — `createMcpHandler` builds one
 * server instance per inbound request, so the module-level counter equals the
 * number of MCP requests served (server/discover, tools/call, …). The client
 * asserts against it to PROVE that `connect({ prior })` sent nothing.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

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

// HTTP-only — the request_count proof depends on `createMcpHandler`'s
// per-request factory; on stdio the factory is per-connection and the 2/3/7
// assertions would not hold.
const { port } = parseExampleArgs();

const handler = createMcpHandler(buildServer);
const nodeHandler = toNodeHandler(handler);
// Bind loopback explicitly and apply host/origin validation in front of the
// handler, matching the framework factories' defaults. The guards answer
// rejected requests themselves and never reach `createMcpHandler`, so the
// per-request factory count the client asserts on is unchanged.
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
}).listen(port, '127.0.0.1', () => {
    console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
});
