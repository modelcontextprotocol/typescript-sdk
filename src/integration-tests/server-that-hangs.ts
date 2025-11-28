import { setTimeout } from 'node:timers';
import process from 'node:process';
import { McpServer } from '../server/mcp.js';
import { StdioServerTransport } from '../server/stdio.js';

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

const doNotExitImmediately = async (signal: NodeJS.Signals) => {
    await server.sendLoggingMessage({
        level: 'debug',
        data: `received signal ${signal}`
    });
    setTimeout(() => process.exit(0), 30 * 1000);
};

transport.onclose = () => {
    server.sendLoggingMessage({
        level: 'debug',
        data: 'transport: onclose called. This should never happen'
    });
};

process.stdin.on('close', hadErr => {
    server.sendLoggingMessage({
        level: 'debug',
        data: 'stdin closed. Error: ' + hadErr
    });
});
process.on('SIGINT', doNotExitImmediately);
process.on('SIGTERM', doNotExitImmediately);
