/**
 * Companion example for `docs/advanced/low-level-server.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness between the
 * regions connects in-memory clients and produces every output the page quotes
 * verbatim, exiting non-zero on drift.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/advanced/low-level-server.examples.ts        # from examples/
 *
 * `lowLevel_serve` lives in a never-invoked wrapper: `serveStdio` would bind
 * this process's real stdin/stdout, so that one region is typecheck-only.
 *
 * @module
 */
/* eslint-disable no-console, import/no-duplicates */
// Harness imports. The page's lead block (the first region) carries its own
// `Server` import so the rendered fence stands alone.
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// "Build the server and list your tools by hand"
// ---------------------------------------------------------------------------

//#region lowLevel_listTools
import { Server } from '@modelcontextprotocol/server';

const catalog = [
    { name: 'Espresso cup', price: 12 },
    { name: 'Travel mug', price: 24 },
    { name: 'Mug rack', price: 36 }
];

const server = new Server({ name: 'catalog', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler('tools/list', async () => ({
    tools: [
        {
            name: 'search',
            description: 'Search the product catalog',
            inputSchema: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Substring to match against product names' } },
                required: ['query']
            }
        }
    ]
}));
//#endregion lowLevel_listTools

// ---------------------------------------------------------------------------
// "Handle tools/call yourself"
// ---------------------------------------------------------------------------

//#region lowLevel_callTool
server.setRequestHandler('tools/call', async request => {
    if (request.params.name !== 'search') {
        return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    const { query } = request.params.arguments as { query: string };
    const hits = catalog.filter(product => product.name.toLowerCase().includes(query.toLowerCase()));
    return { content: [{ type: 'text', text: hits.map(product => product.name).join('\n') }] };
});
//#endregion lowLevel_callTool

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client drives the calls whose
// output low-level-server.md quotes verbatim. Imported dynamically so the
// page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport, ProtocolError } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'low-level-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// The handler answers a valid call exactly like the McpServer version.
const result = await client.callTool({ name: 'search', arguments: { query: 'mug' } });
console.log(result.content);

// Nothing validated `query`, so a wrongly-typed argument reaches the handler
// and crashes it: the client sees a JSON-RPC error, not a tool result.
const crashed = await client.callTool({ name: 'search', arguments: { query: 42 } }).catch((error: unknown) => error);
if (!(crashed instanceof ProtocolError)) {
    throw new Error(`low-level-server.md expected the unvalidated call to reject: ${JSON.stringify(crashed)}`);
}
console.log(`${crashed.name} ${crashed.code}: ${crashed.message}`);

// ---------------------------------------------------------------------------
// "Validate arguments yourself"
// ---------------------------------------------------------------------------

//#region lowLevel_validate
const SearchArguments = fromJsonSchema<{ query: string }>({
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query']
});

server.setRequestHandler('tools/call', async request => {
    if (request.params.name !== 'search') {
        return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    const parsed = await SearchArguments['~standard'].validate(request.params.arguments ?? {});
    if (parsed.issues) {
        return { content: [{ type: 'text', text: parsed.issues.map(issue => issue.message).join('; ') }], isError: true };
    }
    const hits = catalog.filter(product => product.name.toLowerCase().includes(parsed.value.query.toLowerCase()));
    return { content: [{ type: 'text', text: hits.map(product => product.name).join('\n') }] };
});
//#endregion lowLevel_validate

// The same wrongly-typed call now comes back as an ordinary isError result.
const rejected = await client.callTool({ name: 'search', arguments: { query: 42 } });
console.log(rejected);
if (rejected.isError !== true) {
    throw new Error(`low-level-server.md expected the validated call to return isError: ${JSON.stringify(rejected)}`);
}

await client.close();
await server.close();

// ---------------------------------------------------------------------------
// "Serve it with the same entry points" — typecheck-only. `serveStdio` would
// take over this process's stdin/stdout, so the harness never calls this.
// ---------------------------------------------------------------------------

function lowLevel_serve() {
    //#region lowLevel_serve
    serveStdio(() => server);
    createMcpHandler(() => server);
    //#endregion lowLevel_serve
}
void lowLevel_serve;

// ---------------------------------------------------------------------------
// "Reach the low level from McpServer"
// ---------------------------------------------------------------------------

//#region lowLevel_escapeHatch
const mcp = new McpServer({ name: 'catalog', version: '1.0.0' }, { capabilities: { resources: { subscribe: true } } });

mcp.registerTool(
    'search',
    { description: 'Search the product catalog', inputSchema: z.object({ query: z.string() }) },
    async ({ query }) => {
        const names = catalog.filter(product => product.name.includes(query)).map(product => product.name);
        return { content: [{ type: 'text', text: names.join('\n') }] };
    }
);

const subscriptions = new Set<string>();
mcp.server.setRequestHandler('resources/subscribe', async request => {
    subscriptions.add(request.params.uri);
    return {};
});
//#endregion lowLevel_escapeHatch

// Harness: prove the page's claim for the section above — `registerTool` still
// owns `tools/list`, and the hand-registered handler answers
// `resources/subscribe` on the same connection.
const mcpClient = new Client({ name: 'low-level-docs-harness', version: '1.0.0' });
const [mcpClientTransport, mcpServerTransport] = InMemoryTransport.createLinkedPair();
await mcp.connect(mcpServerTransport);
await mcpClient.connect(mcpClientTransport);

const { tools } = await mcpClient.listTools();
await mcpClient.subscribeResource({ uri: 'demo://config' });
if (tools.length !== 1 || tools[0]?.name !== 'search' || !subscriptions.has('demo://config')) {
    throw new Error(`low-level-server.md escape-hatch claim failed: ${JSON.stringify({ tools, subscriptions: [...subscriptions] })}`);
}

await mcpClient.close();
await mcp.close();
