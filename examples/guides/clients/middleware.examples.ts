/**
 * Companion example for `docs/clients/middleware.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness at the
 * bottom routes every middleware stack into an in-process `createMcpHandler`
 * — no port, no socket — and produces the output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/clients/middleware.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { Client, withLogging, withOAuth } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// "Write a middleware"
// ---------------------------------------------------------------------------

//#region middleware_create
import { applyMiddlewares, createMiddleware, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const tagRequests = createMiddleware(async (next, input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Request-Source', 'reports-cli');
    return next(input, { ...init, headers });
});

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
    fetch: applyMiddlewares(tagRequests)(fetch)
});
//#endregion middleware_create
void transport;

// ---------------------------------------------------------------------------
// "Compose several middlewares" — the stub base fetch makes the order
// observable without any network.
// ---------------------------------------------------------------------------

//#region middleware_order
const stamp = (name: string) =>
    createMiddleware(async (next, input, init) => {
        console.log(`-> ${name}`);
        const response = await next(input, init);
        console.log(`<- ${name}`);
        return response;
    });

const base = async () => new Response('ok');
await applyMiddlewares(stamp('retry'), stamp('auth'), stamp('trace'))(base)('http://localhost:3000/mcp');
//#endregion middleware_order

// ---------------------------------------------------------------------------
// "Use the built-in logging middleware"
// ---------------------------------------------------------------------------

//#region middleware_logging
const loggedFetch = applyMiddlewares(tagRequests, withLogging())(fetch);
//#endregion middleware_logging
void loggedFetch;

// ---------------------------------------------------------------------------
// "Combine middleware with an auth provider" — never invoked: a working
// `OAuthClientProvider` is the reader's, not this program's (docs/clients/oauth.md).
// ---------------------------------------------------------------------------

/** Example: OAuth expressed as one layer of a middleware stack. */
function authenticatedTransport(provider: OAuthClientProvider) {
    //#region middleware_withOAuth
    const serverUrl = new URL('http://localhost:3000/mcp');
    const authed = new StreamableHTTPClientTransport(serverUrl, {
        fetch: applyMiddlewares(withOAuth(provider, serverUrl), withLogging({ statusLevel: 400 }))(fetch)
    });
    //#endregion middleware_withOAuth
    return authed;
}
void authenticatedTransport;

// ---------------------------------------------------------------------------
// "Inspect the response"
// ---------------------------------------------------------------------------

//#region middleware_inspect
const observeStatus = createMiddleware(async (next, input, init) => {
    const response = await next(input, init);
    if (typeof init?.body === 'string') {
        const { method } = JSON.parse(init.body) as { method?: string };
        console.log(`${method ?? 'response'} -> HTTP ${response.status}`);
    }
    return response;
});
//#endregion middleware_inspect

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-process `createMcpHandler` stands in
// for the network: `serverFetch` has the same shape as global `fetch`, so the
// exact middleware values defined in the regions above compose onto it
// unchanged. Each block connects a real Client over Streamable HTTP and calls
// one tool; the console output is what the page quotes verbatim.
// ---------------------------------------------------------------------------

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'reports', version: '1.0.0' });
    server.registerTool('ping', { description: 'Reply with pong', inputSchema: z.object({ tag: z.string() }) }, async ({ tag }) => ({
        content: [{ type: 'text', text: `pong ${tag}` }]
    }));
    return server;
});
type AnyFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
const serverFetch: AnyFetch = (url, init) => handler.fetch(new Request(url, init));

async function drive(fetchImpl: AnyFetch): Promise<void> {
    const client = new Client({ name: 'middleware-docs-harness', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { fetch: fetchImpl }));
    await client.callTool({ name: 'ping', arguments: { tag: 'docs' } });
    await client.close();
}

// "Use the built-in logging middleware" — the lines the page quotes. The default
// logger derives each duration from `performance.now()`; pin it while this stack
// runs so the quoted output is reproducible byte for byte.
console.log('--- withLogging');
const realNow = performance.now.bind(performance);
performance.now = () => 0;
await drive(applyMiddlewares(tagRequests, withLogging())(serverFetch));
performance.now = realNow;

// "Inspect the response" — the method -> status lines the page quotes.
console.log('--- inspect');
await drive(applyMiddlewares(observeStatus)(serverFetch));

await handler.close();
