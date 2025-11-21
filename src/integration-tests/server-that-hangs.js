import { setTimeout } from 'node:timers';
import process from 'node:process';
import { McpServer } from '../../dist/esm/server/mcp.js';
import { StdioServerTransport } from '../../dist/esm/server/stdio.js';

const transport = new StdioServerTransport();

const server = new McpServer({
    name: 'server-that-hangs',
    version: '1.0.0'
});

await server.connect(transport);

const doNotExitImmediately = async () => {
    setTimeout(() => process.exit(0), 30 * 1000);
};

process.stdin.on('close', doNotExitImmediately);
process.on('SIGINT', doNotExitImmediately);
process.on('SIGTERM', doNotExitImmediately);
