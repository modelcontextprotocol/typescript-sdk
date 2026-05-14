/**
 * Example: HTTPVersionRoutingTransport
 *
 * A single HTTP endpoint that serves both legacy (2025-11) and modern (2026-06)
 * MCP protocol clients. Version detection uses the Mcp-Method header:
 *
 *   - Present  → modern path (stateless, per-request _meta)
 *   - Absent   → legacy path (initialize → session → requests)
 *
 * One server, one tool registration, both protocol versions work.
 *
 * Test with curl:
 *
 *   # Modern 2026-06 — server/discover
 *   curl -X POST http://localhost:3000/mcp \
 *     -H 'Content-Type: application/json' \
 *     -H 'Mcp-Method: server/discover' \
 *     -H 'MCP-Protocol-Version: 2026-06-30' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"protocolVersion":"2026-06-30"}}}'
 *
 *   # Modern 2026-06 — tools/call
 *   curl -X POST http://localhost:3000/mcp \
 *     -H 'Content-Type: application/json' \
 *     -H 'Mcp-Method: tools/call' \
 *     -H 'MCP-Protocol-Version: 2026-06-30' \
 *     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"greet","arguments":{"name":"World"},"_meta":{"protocolVersion":"2026-06-30","clientCapabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}}'
 *
 *   # Legacy 2025-11 — works as before (initialize → session → tools/call)
 */
import express from 'express';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, HTTPVersionRoutingTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// 1. Create the server (unchanged from any other MCP server)
const server = new McpServer(
    { name: 'routing-example', version: '1.0.0' },
    { capabilities: { logging: {} } },
);

// 2. Register tools (unchanged)
server.registerTool(
    'greet',
    {
        description: 'Greet someone by name',
        inputSchema: { name: z.string().describe('Name to greet') },
    },
    async ({ name }): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `Hello, ${name}!` }],
    }),
);

server.registerTool(
    'add',
    {
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `${a} + ${b} = ${a + b}` }],
    }),
);

// 3. Swap transport class (THE ONLY CHANGE)
const transport = new HTTPVersionRoutingTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
});

// 4. Connect (unchanged)
await server.connect(transport);

// 5. HTTP handler — one route handles both protocol versions
const app = express();
app.use(express.json());

app.all('/mcp', async (req, res) => {
    const webReq = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: Object.fromEntries(
            Object.entries(req.headers)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        ),
        ...(req.method !== 'GET' && req.method !== 'HEAD'
            ? { body: JSON.stringify(req.body) }
            : {}
        ),
    });

    const webRes = await transport.handleRequest(webReq, {
        parsedBody: req.body,
    });

    res.status(webRes.status);
    for (const [key, value] of webRes.headers.entries()) {
        res.setHeader(key, value);
    }

    const contentType = webRes.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
        const body = webRes.body;
        if (body) {
            const reader = body.getReader();
            const pump = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                    (res as unknown as { flush?(): void }).flush?.();
                }
                res.end();
            };
            pump().catch(() => res.end());
        } else {
            res.end();
        }
    } else {
        const text = await webRes.text();
        res.send(text);
    }
});

const PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;
app.listen(PORT, () => {
    console.log(`MCP Version Routing Server listening on port ${PORT}`);
    console.log(`  POST http://localhost:${PORT}/mcp  (both 2025-11 and 2026-06)`);
});

process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await transport.close();
    process.exit(0);
});
