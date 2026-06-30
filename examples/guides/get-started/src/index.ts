/**
 * The `src/index.ts` the get-started tutorials build: the weather server from
 * `docs/get-started/first-server.md` plus the `about` resource that
 * `docs/get-started/first-client.md` adds.
 *
 * `firstClient.examples.ts` (one directory up) spawns this file over stdio
 * exactly as the tutorial reader's client does — `npx tsx src/index.ts` from
 * the project root. Keep `get-alerts` in lockstep with
 * `firstServer.examples.ts`, and `registerResource` in lockstep with the
 * `firstClient_registerResource` region in `firstClient.examples.ts` (the
 * harness there asserts on the values this file advertises).
 *
 * @module
 */
/* eslint-disable no-console */
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

    // Added by docs/get-started/first-client.md ("Add a resource and read it").
    server.registerResource(
        'about',
        'weather://about',
        { title: 'About this server', mimeType: 'text/plain' },
        async uri => ({
            contents: [{ uri: uri.href, text: 'Alert data comes from the US National Weather Service.' }]
        })
    );

    return server;
}

void serveStdio(createServer);
console.error('weather MCP server running on stdio');
