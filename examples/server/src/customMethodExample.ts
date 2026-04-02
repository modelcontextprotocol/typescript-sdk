#!/usr/bin/env node
/**
 * Demonstrates custom (non-standard) request and notification methods.
 *
 * The Protocol class exposes setCustomRequestHandler / setCustomNotificationHandler /
 * sendCustomRequest / sendCustomNotification for vendor-specific methods that are not
 * part of the MCP spec. Params and results are validated against user-provided Zod
 * schemas, and handlers receive the same context (cancellation, task support,
 * bidirectional send/notify) as standard handlers.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import { z } from 'zod';

const SearchParamsSchema = z.object({
    query: z.string(),
    limit: z.number().int().positive().optional()
});

const SearchResultSchema = z.object({
    results: z.array(z.object({ id: z.string(), title: z.string() })),
    total: z.number()
});

const AnalyticsParamsSchema = z.object({
    event: z.string(),
    properties: z.record(z.string(), z.unknown()).optional()
});

const AnalyticsResultSchema = z.object({ recorded: z.boolean() });

const StatusUpdateParamsSchema = z.object({
    status: z.enum(['idle', 'busy', 'error']),
    detail: z.string().optional()
});

async function main() {
    const server = new Server({ name: 'custom-method-server', version: '1.0.0' }, { capabilities: {} });
    const client = new Client({ name: 'custom-method-client', version: '1.0.0' }, { capabilities: {} });

    server.setCustomRequestHandler('acme/search', SearchParamsSchema, async (params, ctx) => {
        console.log(`[server] acme/search query="${params.query}" limit=${params.limit ?? 'unset'} (req ${ctx.mcpReq.id})`);
        return {
            results: [
                { id: 'r1', title: `Result for "${params.query}"` },
                { id: 'r2', title: 'Another result' }
            ],
            total: 2
        };
    });

    server.setCustomRequestHandler('acme/analytics', AnalyticsParamsSchema, async params => {
        console.log(`[server] acme/analytics event="${params.event}"`);
        return { recorded: true };
    });

    client.setCustomNotificationHandler('acme/statusUpdate', StatusUpdateParamsSchema, params => {
        console.log(`[client] acme/statusUpdate status=${params.status} detail=${params.detail ?? '<none>'}`);
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const searchResult = await client.sendCustomRequest('acme/search', { query: 'widgets', limit: 5 }, SearchResultSchema);
    console.log(`[client] received ${searchResult.total} results, first: "${searchResult.results[0]?.title}"`);

    const analyticsResult = await client.sendCustomRequest('acme/analytics', { event: 'page_view' }, AnalyticsResultSchema);
    console.log(`[client] analytics recorded=${analyticsResult.recorded}`);

    await server.sendCustomNotification('acme/statusUpdate', { status: 'busy', detail: 'indexing' });

    // Validation error: wrong param type (limit must be a number)
    try {
        await client.sendCustomRequest('acme/search', { query: 'widgets', limit: 'five' }, SearchResultSchema);
        console.error('[client] expected validation error but request succeeded');
    } catch (error) {
        console.log(`[client] validation error (expected): ${(error as Error).message}`);
    }

    await client.close();
    await server.close();
}

await main();
