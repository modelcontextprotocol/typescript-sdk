/**
 * Runnable, type-checked companion for `docs-v2/clients/connect.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's code fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift).
 *
 * The page's main program — connect over Streamable HTTP, read what the server
 * told you, close — runs for real: the harness below builds a `createMcpHandler`
 * server and routes `globalThis.fetch` for `http://localhost:3000/mcp` into
 * `handler.fetch`, so the HTTP regions execute in-process without binding a
 * port. The output the page quotes verbatim is whatever this file prints.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/clients/connect.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { SSEClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Harness (not shown on the page). A `createMcpHandler` server answers the
// page's `http://localhost:3000/mcp` URL in-process: `globalThis.fetch` for
// that host is routed into `handler.fetch`, so the page's HTTP regions run
// verbatim against a real Streamable HTTP server without binding a port.
// ---------------------------------------------------------------------------

const handler = createMcpHandler(() => {
    const server = new McpServer(
        { name: 'travel', version: '2.1.0' },
        { instructions: 'Call list-trips before book-trip. Dates are ISO 8601.' }
    );
    server.registerTool(
        'list-trips',
        { description: 'List the trips on file', inputSchema: z.object({ year: z.number().int() }) },
        async ({ year }) => ({ content: [{ type: 'text', text: `No trips in ${year}` }] })
    );
    return server;
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).host === 'localhost:3000') return handler.fetch(request);
    return realFetch(input, init);
}) as typeof fetch;

// ## Create a client and connect over HTTP

//#region connect_streamableHttp
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

await client.connect(transport);
//#endregion connect_streamableHttp

// ## Read what the server told you at connect time

//#region connect_introspect
console.log(client.getServerVersion());
console.log(client.getServerCapabilities());
console.log(client.getInstructions());
//#endregion connect_introspect

// ## Disconnect cleanly

//#region connect_close
await transport.terminateSession();
await client.close();
//#endregion connect_close

await handler.close();
globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
// The remaining transports cannot run inside this self-terminating harness —
// stdio spawns a process, the SSE fallback needs a legacy server — so their
// regions live in wrapper functions that typecheck but are never called.
// ---------------------------------------------------------------------------

// ## Connect to a local process over stdio

async function connect_stdio() {
    //#region connect_stdio
    const client = new Client({ name: 'my-client', version: '1.0.0' });

    const transport = new StdioClientTransport({ command: 'node', args: ['server.js'] });

    await client.connect(transport);
    //#endregion connect_stdio
}

// ## Fall back to SSE for legacy servers

async function connect_sseFallback(url: string) {
    //#region connect_sseFallback
    try {
        const client = new Client({ name: 'my-client', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        return client;
    } catch {
        const client = new Client({ name: 'my-client', version: '1.0.0' });
        await client.connect(new SSEClientTransport(new URL(url)));
        return client;
    }
    //#endregion connect_sseFallback
}

void connect_stdio;
void connect_sseFallback;
