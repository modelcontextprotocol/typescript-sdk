/**
 * Resources primitive — direct, templated, and subscribable.
 *
 * `McpServer.registerResource` accepts either a fixed URI string (direct
 * resource) or a `ResourceTemplate` (URI template with substitution). The
 * `counter://value` resource is mutable: the `increment` tool bumps it and
 * announces the change — in-band to this connection (2025-era subscribers
 * tracked per connection, 2026-07-28 listen streams routed by the entry), and
 * on the handler's notifier for clients on other requests. One binary, either
 * transport — selected from argv below.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const COUNTER_URI = 'counter://value';

// The counter is application state, shared by every connection; which URIs a
// connection subscribed to is connection state, tracked inside buildServer.
let counter = 0;

function buildServer(reqCtx: McpRequestContext, publishUpdated?: (uri: string) => void): McpServer {
    const server = new McpServer(
        { name: 'resources-example', version: '1.0.0' },
        { capabilities: { resources: { subscribe: true, listChanged: true } } }
    );

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

    // A mutable resource — the subscription story's subject.
    server.registerResource(
        'counter',
        COUNTER_URI,
        { mimeType: 'text/plain', description: 'A number the increment tool bumps' },
        async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: String(counter) }] })
    );

    // resources/subscribe bookkeeping is the application's: the SDK routes the
    // two verbs, and which URIs THIS connection watches lives here.
    const subscribedUris = new Set<string>();
    server.server.setRequestHandler('resources/subscribe', request => {
        subscribedUris.add(request.params.uri);
        return {};
    });
    server.server.setRequestHandler('resources/unsubscribe', request => {
        subscribedUris.delete(request.params.uri);
        return {};
    });

    server.registerTool('increment', { description: `Bump ${COUNTER_URI} by one` }, async () => {
        counter += 1;
        if (publishUpdated) {
            // Per-request serving: this instance answers one request and is gone,
            // so the change is published on the entry's notifier for the listen
            // streams other requests hold open.
            publishUpdated(COUNTER_URI);
        } else if (reqCtx.era === 'modern' || subscribedUris.has(COUNTER_URI)) {
            // Connection serving (stdio): announce in-band. The entry routes it
            // onto 2026-07-28 listen streams; on a 2025-era connection it goes
            // only to subscribers — unsolicited per-resource updates are wrong.
            await server.server.sendResourceUpdated({ uri: COUNTER_URI }).catch(() => {});
        }
        return { content: [{ type: 'text', text: String(counter) }] };
    });

    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(reqCtx => buildServer(reqCtx));
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(reqCtx => buildServer(reqCtx, uri => handler.notify.resourceUpdated(uri)));
    createServer(toNodeHandler(handler)).listen(port, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
