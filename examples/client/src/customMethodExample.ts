#!/usr/bin/env node
/**
 * Calling vendor-specific (non-spec) JSON-RPC methods from a `Client`.
 *
 * - Send a custom request: `client.request({ method, params }, resultSchema)`
 * - Send a custom notification: `client.notification({ method, params })`
 * - Receive a custom notification: `client.setNotificationHandler(ZodSchemaWithMethodLiteral, handler)`
 *
 * Pair with the server in examples/server/src/customMethodExample.ts.
 */

import { Client, StdioClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';

const SearchResult = z.object({ hits: z.array(z.string()) });

const ProgressNotification = z.object({
    method: z.literal('acme/searchProgress'),
    params: z.object({ stage: z.string(), pct: z.number() })
});

const client = new Client({ name: 'custom-method-client', version: '1.0.0' }, { capabilities: {} });

client.setNotificationHandler(ProgressNotification, n => {
    console.log(`[client] progress: ${n.params.stage} ${n.params.pct}%`);
});

await client.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', '../server/src/customMethodExample.ts'] }));

const r = await client.request({ method: 'acme/search', params: { query: 'widgets' } }, SearchResult);
console.log('[client] hits=' + JSON.stringify(r.hits));

await client.notification({ method: 'acme/tick', params: { n: 1 } });
await client.notification({ method: 'acme/tick', params: { n: 2 } });

await client.close();
