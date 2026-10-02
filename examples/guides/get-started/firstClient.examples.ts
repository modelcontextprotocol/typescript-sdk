/**
 * Runnable, type-checked companion for `docs/get-started/first-client.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's code fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). The
 * top-level regions are one linear program — the `src/client.ts` the tutorial
 * builds — and the file runs for real: `StdioClientTransport` spawns
 * `./src/index.ts` (the tutorial's weather server, checked in next to this
 * file) over stdio, prints every output the page quotes verbatim, asserts each
 * one in the harness blocks, and exits non-zero on any drift.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx firstClient.examples.ts        # from examples/guides/get-started/
 *
 * Two regions live in never-invoked wrappers because the program cannot
 * execute them hermetically: `firstClient_callTool` reaches the live NWS API
 * (the page describes its weather-dependent output in prose instead of
 * quoting it), and `firstClient_registerResource` is the server-side line the
 * page has the reader add to `src/index.ts` — `./src/index.ts` already carries
 * it, and the `listResources` assertion below fails if the two drift apart.
 *
 * @module
 */
/* eslint-disable no-console */
import { dirname } from 'node:path';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/server';

// Harness: anchor the working directory so the transport below resolves
// `src/index.ts` against this directory no matter where the file is launched
// from. The tutorial reader runs `npx tsx src/client.ts` from the project root,
// where the same relative path holds.
chdir(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// "Connect to a server"
// ---------------------------------------------------------------------------

//#region firstClient_connect
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'my-first-client', version: '1.0.0' });

const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts']
});

await client.connect(transport);
//#endregion firstClient_connect

// ---------------------------------------------------------------------------
// "List the server's tools"
// ---------------------------------------------------------------------------

//#region firstClient_listTools
const { tools } = await client.listTools();
for (const tool of tools) {
    console.log(tool.name, '—', tool.description);
}
//#endregion firstClient_listTools

// Harness: the page quotes the loop's one line verbatim.
if (tools.length !== 1 || tools[0]?.name !== 'get-alerts' || tools[0].description !== 'Get the active weather alerts for a US state') {
    throw new Error(`first-client.md listTools output drifted: ${JSON.stringify(tools)}`);
}

// ---------------------------------------------------------------------------
// "Call a tool" — typecheck-only. The happy path hits the live NWS API, so the
// page describes that output in prose; nothing here is quoted verbatim.
// ---------------------------------------------------------------------------

async function firstClient_callTool() {
    //#region firstClient_callTool
    const result = await client.callTool({ name: 'get-alerts', arguments: { state: 'CA' } });

    for (const block of result.content) {
        if (block.type === 'text') console.log(block.text);
    }
    //#endregion firstClient_callTool
}
void firstClient_callTool;

// Harness: the page's "Call a tool" tip quotes the SDK's rejection of
// `{ state: 'California' }` verbatim. The rejection happens before the handler
// (and therefore before any network call), so it runs here for real.
const rejected = await client.callTool({ name: 'get-alerts', arguments: { state: 'California' } });
const rejectedBlock = rejected.content[0];
const quotedRejection =
    'Input validation error: Invalid arguments for tool get-alerts: state: Too big: expected string to have <=2 characters';
if (rejected.isError !== true || rejectedBlock?.type !== 'text' || rejectedBlock.text !== quotedRejection) {
    throw new Error(`first-client.md tip output drifted from the SDK: ${JSON.stringify(rejected)}`);
}
console.log(rejectedBlock.text);

// ---------------------------------------------------------------------------
// "Add a resource and read it" — the server-side half is the one line the page
// has the reader add to the weather project's `src/index.ts`. It is
// typecheck-only here; `./src/index.ts` (the server this program spawned)
// already registers it, and the assertions below prove the two agree.
// ---------------------------------------------------------------------------

function firstClient_registerResource(server: McpServer) {
    //#region firstClient_registerResource
    server.registerResource('about', 'weather://about', { title: 'About this server', mimeType: 'text/plain' }, async uri => ({
        contents: [{ uri: uri.href, text: 'Alert data comes from the US National Weather Service.' }]
    }));
    //#endregion firstClient_registerResource
}
void firstClient_registerResource;

//#region firstClient_readResource
const { resources } = await client.listResources();
console.log(resources);

const { contents } = await client.readResource({ uri: 'weather://about' });
console.log(contents);
//#endregion firstClient_readResource

// Harness: the page quotes both logs above verbatim; pin the values they
// depend on so a drift in `./src/index.ts` fails the run instead of silently
// changing the page.
if (resources.length !== 1 || resources[0]?.uri !== 'weather://about' || resources[0].title !== 'About this server') {
    throw new Error(`first-client.md listResources output drifted: ${JSON.stringify(resources)}`);
}
const aboutContents = contents[0];
if (
    contents.length !== 1 ||
    aboutContents === undefined ||
    aboutContents.uri !== 'weather://about' ||
    !('text' in aboutContents) ||
    aboutContents.text !== 'Alert data comes from the US National Weather Service.'
) {
    throw new Error(`first-client.md readResource output drifted: ${JSON.stringify(contents)}`);
}

// ---------------------------------------------------------------------------
// "Close the connection"
// ---------------------------------------------------------------------------

//#region firstClient_close
await client.close();
//#endregion firstClient_close
