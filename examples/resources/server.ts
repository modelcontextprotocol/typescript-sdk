/**
 * Resources primitive — direct + templated.
 *
 * `McpServer.registerResource` accepts either a fixed URI string (direct
 * resource) or a `ResourceTemplate` (URI template with substitution). One
 * binary, either transport.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';

import { runServerFromArgs } from '../harness.js';

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

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
