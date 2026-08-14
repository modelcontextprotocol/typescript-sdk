/**
 * Self-contained test bodies for custom (non-spec, vendor-prefixed) methods.
 *
 * v2 registers these via the schema'd overloads: `setRequestHandler('<vendor>/x',
 * { params, result }, handler)` and `setNotificationHandler('<vendor>/x',
 * { params }, handler)`; the requesting side passes the matching result schema to
 * `request()`. Each test builds its own server (via factory) and client, wires
 * them with {@link wire} (with `allowCustomMethods` so the wire sniffer permits
 * the vendor methods), and asserts. Params schemas carry a defaulted field so
 * the handler observably receives the schema's parse output, not raw wire params.
 */

import { Client } from '@modelcontextprotocol/client';
import { McpServer, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

verifies('custom-methods:server-handler:roundtrip', async ({ transport }: TestArgs) => {
    const SearchParams = z.object({ query: z.string(), limit: z.number().int().default(5) });
    const SearchResult = z.object({ hits: z.array(z.string()), total: z.number() });

    const received: Array<z.output<typeof SearchParams>> = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
        s.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, params => {
            received.push(params);
            return { hits: [`doc-1 for ${params.query}`, `doc-2 for ${params.query}`].slice(0, params.limit), total: 2 };
        });
        return s;
    };
    const client = new Client({ name: 'c', version: '0' });

    await using _ = await wire(transport, makeServer, client, { allowCustomMethods: true });

    const full = await client.request({ method: 'acme/search', params: { query: 'streamable http' } }, SearchResult);
    // The defaulted `limit` proves the handler got the schema's parse output, not the raw wire params.
    expect(received).toEqual([{ query: 'streamable http', limit: 5 }]);
    expect(full).toEqual({ hits: ['doc-1 for streamable http', 'doc-2 for streamable http'], total: 2 });

    const limited = await client.request({ method: 'acme/search', params: { query: 'sse', limit: 1 } }, SearchResult);
    expect(received).toEqual([
        { query: 'streamable http', limit: 5 },
        { query: 'sse', limit: 1 }
    ]);
    expect(limited).toEqual({ hits: ['doc-1 for sse'], total: 2 });
});

verifies('custom-methods:client-handler:roundtrip', async ({ transport }: TestArgs) => {
    const LookupParams = z.object({ key: z.string(), scope: z.string().default('workspace') });
    const LookupResult = z.object({ value: z.string(), found: z.boolean() });

    const received: Array<z.output<typeof LookupParams>> = [];
    const lookups: Array<z.output<typeof LookupResult>> = [];

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('read-config', { inputSchema: z.object({ key: z.string() }) }, async ({ key }, ctx) => {
            // relatedRequestId keeps the server→client request on the in-flight POST stream for streamableHttp.
            const lookup = await s.server.request({ method: 'acme/configLookup', params: { key } }, LookupResult, {
                relatedRequestId: ctx.mcpReq.id
            });
            lookups.push(lookup);
            return { content: [{ type: 'text', text: `${key}=${lookup.value}` }] };
        });
        return s;
    };

    const client = new Client({ name: 'c', version: '0' });
    client.setRequestHandler('acme/configLookup', { params: LookupParams, result: LookupResult }, params => {
        received.push(params);
        return { value: `resolved:${params.key}`, found: true };
    });

    await using _ = await wire(transport, makeServer, client, { allowCustomMethods: true });

    const result = await client.callTool({ name: 'read-config', arguments: { key: 'editor.theme' } });

    // The defaulted `scope` proves the client handler got the schema's parse output, not the raw wire params.
    expect(received).toEqual([{ key: 'editor.theme', scope: 'workspace' }]);
    expect(lookups).toEqual([{ value: 'resolved:editor.theme', found: true }]);
    expect(result.content).toEqual([{ type: 'text', text: 'editor.theme=resolved:editor.theme' }]);
});

verifies('custom-methods:params-validation-error', async ({ transport }: TestArgs) => {
    const ConvertParams = z.object({ celsius: z.number() });
    const ConvertResult = z.object({ fahrenheit: z.number() });

    const invocations: Array<z.output<typeof ConvertParams>> = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
        s.setRequestHandler('acme/convertTemperature', { params: ConvertParams, result: ConvertResult }, params => {
            invocations.push(params);
            return { fahrenheit: params.celsius * 1.8 + 32 };
        });
        return s;
    };
    const client = new Client({ name: 'c', version: '0' });

    await using _ = await wire(transport, makeServer, client, { allowCustomMethods: true });

    // A conforming call first proves the handler is reachable, so the later "not invoked" check is meaningful.
    await expect(client.request({ method: 'acme/convertTemperature', params: { celsius: 20 } }, ConvertResult)).resolves.toEqual({
        fahrenheit: 68
    });
    expect(invocations).toEqual([{ celsius: 20 }]);

    expect(ProtocolErrorCode.InvalidParams).toBe(-32_602);
    await expect(client.request({ method: 'acme/convertTemperature', params: { celsius: 'warm' } }, ConvertResult)).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('Invalid params for acme/convertTemperature')
    });
    expect(invocations).toEqual([{ celsius: 20 }]);
});

verifies('custom-methods:notification-handler', async ({ transport }: TestArgs) => {
    const HeartbeatParams = z.object({ seq: z.number().int(), source: z.string().default('unspecified') });

    const clientReceived: Array<z.output<typeof HeartbeatParams>> = [];
    const serverReceived: Array<z.output<typeof HeartbeatParams>> = [];

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.server.setNotificationHandler('acme/heartbeat', { params: HeartbeatParams }, params => {
            serverReceived.push(params);
        });
        s.registerTool('sync-data', { inputSchema: z.object({ batches: z.number().int() }) }, async ({ batches }, ctx) => {
            for (let seq = 1; seq <= batches; seq++) {
                await ctx.mcpReq.notify({ method: 'acme/heartbeat', params: { seq, source: 'sync-job' } });
            }
            return { content: [{ type: 'text', text: `synced ${batches} batches` }] };
        });
        return s;
    };

    const client = new Client({ name: 'c', version: '0' });
    client.setNotificationHandler('acme/heartbeat', { params: HeartbeatParams }, params => {
        clientReceived.push(params);
    });

    await using _ = await wire(transport, makeServer, client, { allowCustomMethods: true });

    const result = await client.callTool({ name: 'sync-data', arguments: { batches: 2 } });
    expect(result.content).toEqual([{ type: 'text', text: 'synced 2 batches' }]);

    await vi.waitFor(() => expect(clientReceived).toHaveLength(2));
    expect(clientReceived).toEqual([
        { seq: 1, source: 'sync-job' },
        { seq: 2, source: 'sync-job' }
    ]);

    // Same registration works on the server side; `source` is omitted so the applied default proves schema validation ran.
    await client.notification({ method: 'acme/heartbeat', params: { seq: 3 } });
    await vi.waitFor(() => expect(serverReceived).toHaveLength(1));
    expect(serverReceived).toEqual([{ seq: 3, source: 'unspecified' }]);
});
