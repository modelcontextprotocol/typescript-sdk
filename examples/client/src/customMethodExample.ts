// Run with: pnpm tsx src/customMethodExample.ts
//
// Demonstrates sending custom (non-standard) requests and receiving custom
// notifications from the server.
//
// The Protocol class exposes sendCustomRequest / setCustomNotificationHandler for
// vendor-specific methods that are not part of the MCP spec. The schema-bundle
// overload of sendCustomRequest gives typed params with pre-send validation.
//
// Pair with: examples/server/src/customMethodExample.ts (start the server first).

import { Client, ProtocolError, ProtocolErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';

const SearchParamsSchema = z.object({
    query: z.string(),
    limit: z.number().int().positive().optional()
});

const SearchResultSchema = z.object({
    results: z.array(z.object({ id: z.string(), title: z.string() })),
    total: z.number()
});

const AnalyticsResultSchema = z.object({ recorded: z.boolean() });

const StatusUpdateParamsSchema = z.object({
    status: z.enum(['idle', 'busy', 'error']),
    detail: z.string().optional()
});

const serverUrl = process.argv[2] ?? 'http://localhost:3000/mcp';

async function main(): Promise<void> {
    const client = new Client({ name: 'custom-method-client', version: '1.0.0' });

    // Register handler for custom server→client notifications before connecting.
    client.setCustomNotificationHandler('acme/statusUpdate', StatusUpdateParamsSchema, params => {
        console.log(`[client] acme/statusUpdate status=${params.status} detail=${params.detail ?? '<none>'}`);
    });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    await client.connect(transport);
    console.log(`[client] connected to ${serverUrl}`);

    // Schema-bundle overload: typed params + pre-send validation, typed result.
    const searchResult = await client.sendCustomRequest(
        'acme/search',
        { query: 'widgets', limit: 5 },
        { params: SearchParamsSchema, result: SearchResultSchema }
    );
    console.log(`[client] acme/search → ${searchResult.total} results, first: "${searchResult.results[0]?.title}"`);

    // Loose overload: bare result schema, untyped params.
    const analyticsResult = await client.sendCustomRequest('acme/analytics', { event: 'page_view' }, AnalyticsResultSchema);
    console.log(`[client] acme/analytics → recorded=${analyticsResult.recorded}`);

    // Pre-send validation: schema-bundle overload rejects bad params before the round-trip.
    try {
        await client.sendCustomRequest(
            'acme/search',
            { query: 'widgets', limit: 'five' } as unknown as z.output<typeof SearchParamsSchema>,
            { params: SearchParamsSchema, result: SearchResultSchema }
        );
        console.error('[client] expected validation error but request succeeded');
    } catch (error) {
        const code = error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams ? 'InvalidParams' : 'unknown';
        console.log(`[client] pre-send validation error (expected, ${code}): ${(error as Error).message}`);
    }

    await transport.close();
}

try {
    await main();
} catch (error) {
    console.error('[client] error:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
