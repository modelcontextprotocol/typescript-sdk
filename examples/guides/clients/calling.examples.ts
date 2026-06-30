/**
 * Companion example for `docs/clients/calling.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness around the
 * regions registers the in-memory `orders` server the page's client talks to
 * and produces the output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/clients/calling.examples.ts       # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { completable, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Harness (not shown on the page). The page documents the CLIENT verbs; this
// `orders` server only exists so every block has something real to call and
// every quoted output is real. Any MCP server behaves the same.
// ---------------------------------------------------------------------------

const orders = [
    { id: 'A-1041', customer: 'Ada', items: 3, total: 61.5, currency: 'EUR', status: 'shipped' },
    { id: 'A-1042', customer: 'Lin', items: 1, total: 18, currency: 'EUR', status: 'open' }
];

const server = new McpServer({ name: 'orders', version: '1.0.0' });

server.registerTool(
    'lookup-order',
    {
        description: 'Look up one order by its id',
        inputSchema: z.object({ id: z.string().describe('Order id, e.g. A-1041') })
    },
    async ({ id }) => {
        const order = orders.find(candidate => candidate.id === id);
        if (!order) throw new Error(`No order ${id}`);
        return { content: [{ type: 'text', text: `${order.id}: ${order.items} items, ${order.status}` }] };
    }
);

server.registerTool(
    'order-total',
    {
        description: 'Total of one order',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string(), total: z.number(), currency: z.string() })
    },
    async ({ id }) => {
        const order = orders.find(candidate => candidate.id === id);
        if (!order) throw new Error(`No order ${id}`);
        const output = { id: order.id, total: order.total, currency: order.currency };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }
);

server.registerTool(
    'export-orders',
    {
        description: 'Export every order to the given format',
        inputSchema: z.object({ format: z.string() })
    },
    async ({ format }, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        for (const [index, order] of orders.entries()) {
            if (progressToken !== undefined) {
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: { progressToken, progress: index + 1, total: orders.length, message: `exported ${order.id}` }
                });
            }
        }
        return { content: [{ type: 'text', text: `${orders.length} orders exported as ${format}` }] };
    }
);

server.registerResource(
    'recent-orders',
    'orders://recent',
    { description: 'Ids of the most recent orders', mimeType: 'application/json' },
    async uri => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(orders.map(order => order.id)) }]
    })
);

server.registerPrompt(
    'summarize-order',
    {
        description: 'Write a status update for one order',
        argsSchema: z.object({
            id: z.string().describe('Order id'),
            tone: completable(z.string().describe('Writing tone'), value =>
                ['formal', 'friendly', 'terse'].filter(tone => tone.startsWith(value))
            )
        })
    },
    ({ id, tone }) => ({
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Write a ${tone} status update for order ${id}.` }
            }
        ]
    })
);

const client = new Client({ name: 'orders-cli', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "List the tools and call one" — the names and the content the page quotes.
//#region listTools_callTool
const { tools } = await client.listTools();
console.log(tools.map(tool => tool.name));

const result = await client.callTool({ name: 'lookup-order', arguments: { id: 'A-1041' } });
console.log(result.content);
//#endregion listTools_callTool

// ---------------------------------------------------------------------------
// "Let the SDK walk the pages". `McpServer` answers `tools/list` in one page,
// so the harness swaps in a handler that serves the SAME three definitions two
// per page — the aggregate walk and the per-page call below are both real.
// ---------------------------------------------------------------------------

server.server.setRequestHandler('tools/list', async request =>
    request.params?.cursor === undefined ? { tools: tools.slice(0, 2), nextCursor: 'page-2' } : { tools: tools.slice(2) }
);

// Proof for the page's aggregate claim: against the now-paginating server,
// the no-cursor call still returns every tool, with `nextCursor` cleared.
// Throws (non-zero exit) if the claim is false.
const walked = await client.listTools();
if (walked.tools.length !== tools.length || walked.nextCursor !== undefined) {
    throw new Error(`calling.md claim failed: aggregated walk returned ${JSON.stringify(walked)}`);
}

// The cursor an earlier page of this server handed back in `nextCursor`.
const heldCursor = 'page-2';

// "Let the SDK walk the pages" — one raw page, the output the page quotes.
//#region listTools_onePage
const page = await client.listTools({ cursor: heldCursor });
console.log(
    page.tools.map(tool => tool.name),
    page.nextCursor
);
//#endregion listTools_onePage

// "Read structured output" — the narrowed `structuredContent` the page quotes.
//#region callTool_structured
const details = await client.callTool({ name: 'order-total', arguments: { id: 'A-1041' } });

const total: unknown = details.structuredContent;
if (typeof total === 'object' && total !== null && 'currency' in total) {
    console.log(total);
}
//#endregion callTool_structured

// "Read a resource" — the uri list and the contents the page quotes.
//#region readResource_basic
const { resources } = await client.listResources();
console.log(resources.map(resource => resource.uri));

const { contents } = await client.readResource({ uri: 'orders://recent' });
console.log(contents[0]);
//#endregion readResource_basic

// "Get a prompt" — the prompt names and the filled-in messages the page quotes.
//#region getPrompt_basic
const { prompts } = await client.listPrompts();
console.log(prompts.map(prompt => prompt.name));

const prompt = await client.getPrompt({ name: 'summarize-order', arguments: { id: 'A-1041', tone: 'terse' } });
console.log(prompt.messages);
//#endregion getPrompt_basic

// "Autocomplete an argument" — the suggestions the page quotes.
//#region complete_tone
const { completion } = await client.complete({
    ref: { type: 'ref/prompt', name: 'summarize-order' },
    argument: { name: 'tone', value: 'f' }
});
console.log(completion.values);
//#endregion complete_tone

// "Track progress on a long call" — the progress updates and the final result.
//#region callTool_progress
const exported = await client.callTool(
    { name: 'export-orders', arguments: { format: 'csv' } },
    {
        onprogress: update => console.log(update),
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 600_000
    }
);
console.log(exported.content);
//#endregion callTool_progress

await client.close();
await server.close();
