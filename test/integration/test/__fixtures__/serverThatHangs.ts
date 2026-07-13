import process from 'node:process';
import { setInterval } from 'node:timers';

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const transport = new StdioServerTransport();

const server = new McpServer(
    {
        name: 'server-that-hangs',
        title: 'Test Server that hangs',
        version: '1.0.0'
    },
    {
        capabilities: {
            logging: {}
        }
    }
);

await server.connect(transport);

// Keep process alive even after stdin closes
const keepAlive = setInterval(() => {}, 60_000);

// Prevent transport close from exiting
transport.onclose = () => {
    // Intentionally ignore - we want to test the signal handling
};

const doNotExitImmediately = async (signal: NodeJS.Signals) => {
    try {
        await server.sendLoggingMessage({
            level: 'debug',
            data: `received signal ${signal}`
        });
    } catch {
        // The client may have already closed stdin/stdout while terminating this
        // fixture. Ignore late logging failures so the cleanup test continues to
        // exercise process termination rather than crashing on transport teardown.
    }
    // Clear keepalive but delay exit to simulate slow shutdown
    clearInterval(keepAlive);
    setInterval(() => {}, 30_000);
};

process.on('SIGINT', doNotExitImmediately);
process.on('SIGTERM', doNotExitImmediately);
