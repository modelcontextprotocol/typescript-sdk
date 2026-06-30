/**
 * Runnable, type-checked companion for `docs-v2/get-started/real-host.md`.
 *
 * The page registers an existing server in MCP hosts; its one `ts` fence is
 * the tail of the `src/index.ts` built in `first-server.md` — the entry every
 * host on the page launches. The `//#region` block is synced byte-for-byte
 * into the page by `pnpm sync:snippets` (`pnpm sync:snippets --check` reports
 * drift). Running the file (`npx tsx realHost.examples.ts`) prints the stderr
 * banner the page quotes verbatim, proves over an in-memory client that the
 * launched server advertises exactly the one `get-alerts` tool the page says a
 * host lists, and exits.
 *
 * @module
 */
/* eslint-disable no-console */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// The server from "Build your first server" — one `get-alerts` tool. The page
// adds no server code; this factory is its prerequisite, reproduced here so the
// file is the same `src/index.ts` a host launches with `npx tsx src/index.ts`.
// ---------------------------------------------------------------------------

const NWS_API = 'https://api.weather.gov';

interface AlertsResponse {
    features: { properties: { event?: string; headline?: string } }[];
}

function createServer(): McpServer {
    const server = new McpServer({ name: 'weather', version: '1.0.0' });

    server.registerTool(
        'get-alerts',
        {
            description: 'Get the active weather alerts for a US state',
            inputSchema: z.object({
                state: z.string().length(2).describe('Two-letter US state code, e.g. CA')
            })
        },
        async ({ state }) => {
            const code = state.toUpperCase();
            const url = `${NWS_API}/alerts/active?area=${code}`;
            const res = await fetch(url, { headers: { 'User-Agent': 'mcp-weather-tutorial/1.0' } });
            if (!res.ok) {
                return { content: [{ type: 'text', text: `NWS API error: HTTP ${res.status}` }], isError: true };
            }
            const { features } = (await res.json()) as AlertsResponse;
            if (features.length === 0) {
                return { content: [{ type: 'text', text: `No active alerts for ${code}.` }] };
            }
            const lines = features.map(f => f.properties.headline ?? f.properties.event ?? 'Unnamed alert');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
    );

    return server;
}

//#region realHost_serve
void serveStdio(createServer);
console.error('weather MCP server running on stdio');
//#endregion realHost_serve

// ---------------------------------------------------------------------------
// Harness (not shown on the page). A host's first move after launching the
// command above is `tools/list`; the page claims the result is the single
// `get-alerts` tool. An in-memory client connected to the same factory proves
// it — any MCP host sees the same list over stdio. `serveStdio` above is still
// waiting on stdin, so the harness exits explicitly. Imported dynamically so
// the page's region stays exactly the tail of `src/index.ts`.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const harnessServer = createServer();
const harnessClient = new Client({ name: 'real-host-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await harnessServer.connect(serverTransport);
await harnessClient.connect(clientTransport);

// The list every host shows after it trusts and starts the server.
const { tools } = await harnessClient.listTools();
const names = tools.map(tool => tool.name);
if (names.length !== 1 || names[0] !== 'get-alerts') {
    throw new Error(`real-host.md expects hosts to list exactly [get-alerts], got: ${JSON.stringify(names)}`);
}

await harnessClient.close();
await harnessServer.close();
// `serveStdio` above is still reading stdin; this file runs as a program, so end it here.
// eslint-disable-next-line unicorn/no-process-exit
process.exit(0);
