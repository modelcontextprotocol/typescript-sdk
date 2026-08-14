/**
 * A dual-era stdio server fixture: the connection-pinned `serveStdio` entry
 * over an ordinary `McpServer` factory. Spawned as a real child process by
 * `test/server/dualEraStdio.test.ts`; each spawned process serves exactly one
 * connection, pinned to the era its client opens with.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const handle = serveStdio(() => {
    const server = new McpServer(
        { name: 'dual-era-stdio-fixture', version: '1.0.0' },
        { capabilities: { tools: {} }, instructions: 'dual-era stdio fixture' }
    );
    server.registerTool(
        'echo',
        { description: 'Echoes the input text', inputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({
            content: [{ type: 'text', text }]
        })
    );
    return server;
});

const exit = async () => {
    await handle.close();
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
};

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
