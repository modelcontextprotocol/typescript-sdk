#!/usr/bin/env node
/**
 * Registering vendor-specific (non-spec) JSON-RPC methods on a `Server`.
 *
 * Custom methods use the 3-arg form of `setRequestHandler` / `setNotificationHandler`:
 * pass the method string, a params schema, and the handler. The same overload is
 * available on `Client` (for server→client custom methods) — you do NOT need a raw
 * `Protocol` instance for this.
 *
 * To call these from the client side, use:
 *   await client.request({ method: 'acme/search', params: { query: 'widgets' } }, SearchResult)
 *   await client.notification({ method: 'acme/tick', params: { n: 1 } })
 * See examples/client/src/customMethodExample.ts.
 */

import { Server, StdioServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';

const SearchParams = z.object({ query: z.string() });
const TickParams = z.object({ n: z.number() });

const server = new Server({ name: 'custom-method-server', version: '1.0.0' }, { capabilities: {} });

server.setRequestHandler('acme/search', SearchParams, async (params, ctx) => {
    console.log('[server] acme/search query=' + params.query);
    await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'start', pct: 0 } });
    const hits = [params.query, params.query + '-result'];
    await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'done', pct: 100 } });
    return { hits };
});

server.setNotificationHandler('acme/tick', TickParams, p => {
    console.log('[server] acme/tick n=' + p.n);
});

await server.connect(new StdioServerTransport());
