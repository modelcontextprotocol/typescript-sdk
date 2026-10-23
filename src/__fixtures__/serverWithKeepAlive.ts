import { setInterval } from 'node:timers';
import { McpServer } from '../server/mcp.js';
import { StdioServerTransport } from '../server/stdio.js';

const transport = new StdioServerTransport();

const server = new McpServer({
    name: 'server-with-keep-alive',
    version: '1.0.0'
});

await server.connect(transport);

// Simulates a real server holding a keep-alive handle (connection pool, file
// watcher, heartbeat timer, ...). A well-behaved server releases its handles
// when the connection closes, and the process then exits naturally.
const keepAlive = setInterval(() => {}, 60_000);

server.server.onclose = () => {
    clearInterval(keepAlive);
};
