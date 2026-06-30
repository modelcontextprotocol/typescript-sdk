/**
 * Companion example for `docs-v2/servers/tools.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory client and produces the output the page quotes
 * verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/tools.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region registerTool_search
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const catalog = [
    { name: 'Espresso cup', price: 12 },
    { name: 'Travel mug', price: 24 },
    { name: 'Mug rack', price: 36 }
];

const server = new McpServer({ name: 'catalog', version: '1.0.0' });

server.registerTool(
    'search',
    {
        description: 'Search the product catalog',
        inputSchema: z.object({
            query: z.string().describe('Substring to match against product names'),
            limit: z.number().int().max(50).optional()
        })
    },
    async ({ query, limit }) => {
        const hits = catalog.filter(product => product.name.toLowerCase().includes(query.toLowerCase()));
        const names = hits.slice(0, limit ?? 10).map(product => product.name);
        return { content: [{ type: 'text', text: names.join('\n') }] };
    }
);
//#endregion registerTool_search

//#region registerTool_structured
server.registerTool(
    'product-details',
    {
        description: 'Look up one product by its exact name',
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ name: z.string(), price: z.number() })
    },
    async ({ name }) => {
        const product = catalog.find(candidate => candidate.name === name);
        if (!product) throw new Error(`No product named ${name}`);
        const output = { name: product.name, price: product.price };
        return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output
        };
    }
);
//#endregion registerTool_structured

//#region registerTool_annotations
server.registerTool(
    'clear-catalog',
    {
        title: 'Clear the catalog',
        description: 'Remove every product from the catalog',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async () => {
        catalog.length = 0;
        return { content: [{ type: 'text', text: 'Catalog cleared' }] };
    }
);
//#endregion registerTool_annotations

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client drives the calls whose
// output servers/tools.md quotes verbatim. Any MCP client behaves the same.
// Imported dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'tools-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Call it" — the happy path the page quotes.
//#region callTool_search
const result = await client.callTool({ name: 'search', arguments: { query: 'mug' } });
console.log(result.content);
//#endregion callTool_search

// "Send arguments the schema rejects" — the rejection the page quotes.
//#region callTool_invalid
const rejected = await client.callTool({ name: 'search', arguments: { query: 'mug', limit: 999 } });
console.log(rejected);
//#endregion callTool_invalid

// "Return structured output" — the structured result the page quotes.
const details = await client.callTool({ name: 'product-details', arguments: { name: 'Travel mug' } });
console.log(details);

// Proof for the page's ::: tip — `.describe()` lands in the JSON Schema that
// `tools/list` advertises for the `query` argument. Throws (non-zero exit) if
// the claim is false.
const { tools } = await client.listTools();
const searchTool = tools.find(tool => tool.name === 'search');
const properties = searchTool?.inputSchema.properties as Record<string, { description?: string }> | undefined;
if (properties?.['query']?.description !== 'Substring to match against product names') {
    throw new Error(`tools.md tip claim failed: query.description is ${JSON.stringify(properties?.['query'])}`);
}

await client.close();
await server.close();
