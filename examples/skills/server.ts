/**
 * Serves the `skills/` folder next to this file as MCP skills (SEP-2640),
 * under the `examples` prefix: one `loadSkills` call at startup, attached to
 * every server instance.
 *
 * One binary, either transport — selected by `--http --port <N>` (defaults to
 * stdio). See `examples/CONTRIBUTING.md` for the canonical shape.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// Load once: the catalog keeps metadata only and serves every server below.
const skills = await loadSkills(siblingPath(import.meta.url, 'skills'), { prefix: 'examples' });

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'skills-example', version: '1.0.0' });
    skills.attach(mcp);
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
