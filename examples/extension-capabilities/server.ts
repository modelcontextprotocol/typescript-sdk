/**
 * Declares one extension capability, `com.example/feature-flags`, with a small
 * settings object. The entry is advertised to every peer — by the `initialize`
 * result on legacy connections and by `server/discover` on modern ones.
 *
 * One binary, either transport — selected by `--http --port <N>` (defaults to
 * stdio). See `examples/CONTRIBUTING.md` for the canonical shape.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'extension-capabilities-server', version: '1.0.0' });

    // Declare the extension and its settings before connecting.
    mcp.server.registerCapabilities({
        extensions: { 'com.example/feature-flags': { flags: ['dark-mode', 'beta-search'] } }
    });

    return mcp;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    // `createMcpHonoApp()` arms localhost host/origin validation by default;
    // bind loopback explicitly to match.
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
