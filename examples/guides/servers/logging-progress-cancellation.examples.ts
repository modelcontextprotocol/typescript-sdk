/**
 * Companion example for `docs/servers/logging-progress-cancellation.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * server regions connects an in-memory client and produces the output the
 * page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/logging-progress-cancellation.examples.ts   # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// "Log to the client" — the logging capability is declared at construction.
//#region logging_capability
const server = new McpServer({ name: 'file-processor', version: '1.0.0' }, { capabilities: { logging: {} } });
//#endregion logging_capability

// "Route SDK diagnostics" — keep local SDK output off the stdio protocol channel.
//#region sdkLogger_stderr
const sdkLogger = {
    debug: (...args: unknown[]) => console.error('[debug]', ...args),
    info: (...args: unknown[]) => console.error('[info]', ...args),
    warn: (...args: unknown[]) => console.error('[warn]', ...args),
    error: (...args: unknown[]) => console.error('[error]', ...args)
};

const diagnosticServer = new McpServer({ name: 'file-processor', version: '1.0.0' }, { logger: sdkLogger });
//#endregion sdkLogger_stderr
void diagnosticServer;

// "Report progress from a handler" — the page's lead block.
//#region registerTool_progress
server.registerTool(
    'process-files',
    {
        description: 'Process files with progress updates',
        inputSchema: z.object({ files: z.array(z.string()) })
    },
    async ({ files }, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;

        for (let i = 0; i < files.length; i++) {
            // ... process files[i] ...

            if (progressToken !== undefined) {
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: { progressToken, progress: i + 1, total: files.length, message: `Processed ${files[i]}` }
                });
            }
        }

        return { content: [{ type: 'text', text: `Processed ${files.length} files` }] };
    }
);
//#endregion registerTool_progress

// "Log to the client" — `ctx.mcpReq.log(level, data)` inside a handler.
//#region registerTool_logging
server.registerTool(
    'validate-records',
    {
        description: 'Validate records before import',
        inputSchema: z.object({ records: z.array(z.string()) })
    },
    async ({ records }, ctx) => {
        await ctx.mcpReq.log('info', `Validating ${records.length} records`);
        const invalid = records.filter(record => !record.endsWith('.csv'));
        if (invalid.length > 0) {
            await ctx.mcpReq.log('warning', { invalid });
        }
        return { content: [{ type: 'text', text: `${records.length - invalid.length} of ${records.length} records are valid` }] };
    }
);
//#endregion registerTool_logging

// "Stop work when the request is cancelled" — check `ctx.mcpReq.signal`.
//#region registerTool_abort
server.registerTool(
    'scan-archive',
    {
        description: 'Scan every page of the archive',
        inputSchema: z.object({ pages: z.number().int() })
    },
    async ({ pages }, ctx) => {
        let scanned = 0;
        for (let page = 0; page < pages; page++) {
            if (ctx.mcpReq.signal.aborted) {
                console.error(`Stopped after ${scanned} of ${pages} pages: ${ctx.mcpReq.signal.reason}`);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100)); // ... scan one page ...
            scanned++;
        }
        return { content: [{ type: 'text', text: `Scanned ${scanned} pages` }] };
    }
);
//#endregion registerTool_abort

// "Pass the signal to your own I/O" — registered for the page, never called by
// the harness (it would hit the network).
//#region registerTool_forwardSignal
const SOURCE_URLS = {
    readme: 'https://example.com/sources/readme.md',
    changelog: 'https://example.com/sources/changelog.md'
};

server.registerTool(
    'fetch-source',
    {
        description: 'Download one of the known source files',
        inputSchema: z.object({ source: z.enum(['readme', 'changelog']) })
    },
    async ({ source }, ctx) => {
        const response = await fetch(SOURCE_URLS[source], { signal: ctx.mcpReq.signal });
        return { content: [{ type: 'text', text: await response.text() }] };
    }
);
//#endregion registerTool_forwardSignal

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client drives the calls whose
// output the page quotes verbatim. Any MCP client behaves the same.
// Imported dynamically so the page's server regions stay self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'lpc-docs-harness', version: '1.0.0' });

// "Log to the client" — the client surfaces `notifications/message`.
//#region setNotificationHandler_message
client.setNotificationHandler('notifications/message', notification => {
    console.log(notification.params.level, notification.params.data);
});
//#endregion setNotificationHandler_message

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Report progress from a handler" — `onprogress` opts the call in.
//#region callTool_onprogress
const result = await client.callTool(
    { name: 'process-files', arguments: { files: ['a.csv', 'b.csv', 'c.csv'] } },
    { onprogress: update => console.log(update) }
);
console.log(result.content);
//#endregion callTool_onprogress

// "Skip progress when the client did not ask" — same call, no `onprogress`.
//#region callTool_noProgress
const quiet = await client.callTool({ name: 'process-files', arguments: { files: ['d.csv', 'e.csv'] } });
console.log(quiet.content);
//#endregion callTool_noProgress

// "Log to the client" — both `log` calls land before the result.
const validated = await client.callTool({ name: 'validate-records', arguments: { records: ['a.csv', 'b.txt'] } });
console.log(validated.content);

// "Stop work when the request is cancelled".
//#region callTool_abort
const controller = new AbortController();
const scan = client.callTool({ name: 'scan-archive', arguments: { pages: 40 } }, { signal: controller.signal });

// the end user clicks Stop while the scan runs
setTimeout(() => controller.abort('the end user clicked Stop'), 5);

await scan.catch(error => console.log(String(error)));
//#endregion callTool_abort

// Give the cancelled handler time to observe the abort and stop.
await new Promise(resolve => setTimeout(resolve, 250));

await client.close();
await server.close();
