/**
 * Resources primitive — direct + templated.
 *
 * `McpServer.registerResource` accepts either a fixed URI string (direct
 * resource) or a `ResourceTemplate` (URI template with substitution). One
 * binary, either transport — selected from argv below.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'resources-example', version: '1.0.0' });

    // A direct resource at a fixed URI.
    server.registerResource(
        'app-config',
        'config://app',
        { mimeType: 'application/json', description: 'Static application config' },
        async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"feature":true}' }] })
    );

    // A templated resource: `greeting://{name}`.
    server.registerResource(
        'greeting',
        new ResourceTemplate('greeting://{name}', { list: undefined }),
        { description: 'A greeting for the named subject' },
        async (uri, vars) => ({ contents: [{ uri: uri.href, text: `Hello, ${vars.name}!` }] })
    );

    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    createServer(toNodeHandler(handler)).listen(port, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
