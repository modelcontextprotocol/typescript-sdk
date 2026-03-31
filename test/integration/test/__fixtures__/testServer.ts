import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';

const transport = new StdioServerTransport();

const server = new McpServer({
    name: 'test-server',
    version: '1.0.0'
});

await server.connect(transport);

const exit = async () => {
    await server.close();
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
};

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
