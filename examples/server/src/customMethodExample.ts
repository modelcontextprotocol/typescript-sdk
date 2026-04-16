#!/usr/bin/env node
/**
 * Registering vendor-specific (non-spec) JSON-RPC methods on a `Server`.
 *
 * Custom methods use the Zod-schema form of `setRequestHandler` / `setNotificationHandler`:
 * pass a Zod object schema whose `method` field is `z.literal('<method>')`. The same overload
 * is available on `Client` (for server→client custom methods).
 *
 * To call these from the client side, use:
 *   await client.request({ method: 'acme/search', params: { query: 'widgets' } }, SearchResult)
 *   await client.notification({ method: 'acme/tick', params: { n: 1 } })
 * See examples/client/src/customMethodExample.ts.
 */

import { Server, StdioServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';

const SearchRequest = z.object({
    method: z.literal('acme/search'),
    params: z.object({ query: z.string() })
});

const TickNotification = z.object({
    method: z.literal('acme/tick'),
    params: z.object({ n: z.number() })
});

const server = new Server({ name: 'custom-method-server', version: '1.0.0' }, { capabilities: {} });

server.setRequestHandler(SearchRequest, request => {
    console.log('[server] acme/search query=' + request.params.query);
    return { hits: [request.params.query, request.params.query + '-result'] };
});

server.setNotificationHandler(TickNotification, n => {
    console.log('[server] acme/tick n=' + n.params.n);
});

await server.connect(new StdioServerTransport());
