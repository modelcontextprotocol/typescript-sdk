import { McpServer } from '@modelcontextprotocol/sdk-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk-server';

const transport = new StdioServerTransport();

const server = new McpServer({
    name: 'test-server',
    version: '1.0.0'
});

await server.connect(transport);

const exit = async () => {
    await server.close();
    process.exit(0);
};

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
