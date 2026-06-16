/**
 * A dual-era stdio server fixture: `eraSupport: 'dual-era'` on an otherwise
 * ordinary hand-constructed McpServer connected to the unchanged
 * StdioServerTransport. Spawned as a real child process by
 * `test/server/dualEraStdio.test.ts`.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const server = new McpServer(
    { name: 'dual-era-stdio-fixture', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: 'dual-era stdio fixture', eraSupport: 'dual-era' }
);

server.registerTool('echo', { description: 'Echoes the input text', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
    content: [{ type: 'text', text }]
}));

await server.connect(new StdioServerTransport());

const exit = async () => {
    await server.close();
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
};

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
