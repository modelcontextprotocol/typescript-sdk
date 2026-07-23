/**
 * Runnable, type-checked companion for `docs/get-started/first-server.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's code fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). The regions
 * are one linear program — the `src/index.ts` the tutorial builds. Running the
 * file (`npx tsx firstServer.examples.ts`) starts that server and then runs the
 * harness below the regions, which proves the validation-error output the page
 * quotes verbatim and exits.
 *
 * @module
 */
/* eslint-disable no-console */

//#region firstServer_registerTool
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

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
//#endregion firstServer_registerTool

//#region firstServer_serve
void serveStdio(createServer);
console.error('weather MCP server running on stdio');
//#endregion firstServer_serve

// ---------------------------------------------------------------------------
// Harness (not shown on the page). The page's ::: tip quotes the SDK's
// validation error for `get-alerts` called with `{ state: 'California' }`
// verbatim; this proves it. A second server instance from the same factory is
// driven by an in-memory client (any MCP client behaves the same), and the
// process exits non-zero if the produced text drifts from what the page quotes.
// `serveStdio` above is still waiting on stdin, so the harness exits explicitly.
// Imported dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const harnessServer = createServer();
const harnessClient = new Client({ name: 'first-server-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await harnessServer.connect(serverTransport);
await harnessClient.connect(clientTransport);

// "Call `get-alerts` with `{ "state": "California" }`" — the rejection the tip quotes.
const rejected = await harnessClient.callTool({ name: 'get-alerts', arguments: { state: 'California' } });
const block = rejected.content[0];
const quotedOnPage =
    'Input validation error: Invalid arguments for tool get-alerts: state: Too big: expected string to have <=2 characters';
if (rejected.isError !== true || block?.type !== 'text' || block.text !== quotedOnPage) {
    throw new Error(`first-server.md tip output drifted from the SDK: ${JSON.stringify(rejected)}`);
}

await harnessClient.close();
await harnessServer.close();
// `serveStdio` above is still reading stdin; this file runs as a program, so end it here.
// eslint-disable-next-line unicorn/no-process-exit
process.exit(0);
