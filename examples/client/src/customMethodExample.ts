#!/usr/bin/env node
/**
 * Calling vendor-specific (non-spec) JSON-RPC methods from a `Client`.
 *
 * - Send a custom request: `client.request({ method, params }, resultSchema)`
 * - Send a custom notification: `client.notification({ method, params })` (unchanged from v1)
 * - Receive a custom notification: 3-arg `client.setNotificationHandler(method, paramsSchema, handler)`
 *
 * These overloads are on `Client` and `Server` directly — you do NOT need a raw
 * `Protocol` instance for custom methods.
 *
 * Pair with the server in examples/server/src/customMethodExample.ts.
 */

import { Client, StdioClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';

const SearchResult = z.object({ hits: z.array(z.string()) });
const ProgressParams = z.object({ stage: z.string(), pct: z.number() });

const client = new Client({ name: 'custom-method-client', version: '1.0.0' }, { capabilities: {} });

client.setNotificationHandler('acme/searchProgress', ProgressParams, p => {
    console.log(`[client] progress: ${p.stage} ${p.pct}%`);
});

await client.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', '../server/src/customMethodExample.ts'] }));

const r = await client.request({ method: 'acme/search', params: { query: 'widgets' } }, SearchResult);
console.log('[client] hits=' + JSON.stringify(r.hits));

await client.notification({ method: 'acme/tick', params: { n: 1 } });
await client.notification({ method: 'acme/tick', params: { n: 2 } });

await client.close();
