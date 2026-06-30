/**
 * Runnable, type-checked companion for `docs-v2/serving/web-standard.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's code fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). On a
 * web-standard runtime the default export's `fetch` IS the request path, so the
 * harness below the regions calls it directly with the page's curl request,
 * prints the response the page quotes verbatim, and exits non-zero if it (or
 * the `guarded` / `secured` wrappers' behavior) drifts. No port is ever bound.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/serving/webStandard.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import type { AuthInfo } from '@modelcontextprotocol/server';

//#region createMcpHandler_exportDefault
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool('add-note', { description: 'Append a note', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text: `Saved: ${text}` }]
    }));
    return server;
});

export default handler;
//#endregion createMcpHandler_exportDefault

//#region hostHeaderValidationResponse_guard
import { hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server';

const guarded = {
    async fetch(request: Request): Promise<Response> {
        const rejected =
            hostHeaderValidationResponse(request, ['api.example.com']) ?? originValidationResponse(request, ['app.example.com']);
        return rejected ?? handler.fetch(request);
    }
};
//#endregion hostHeaderValidationResponse_guard

// `verifyToken` stands in for your deployment's token verification (JWT
// validation, RFC 7662 introspection, a call to your IdP). The page points at
// docs-v2/serving/authorization.md for the real thing.
async function verifyToken(request: Request): Promise<AuthInfo> {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    return { token, clientId: 'docs-harness', scopes: ['mcp'], expiresAt: Date.now() / 1000 + 3600 };
}

//#region McpHttpHandler_fetch_authInfo
const secured = {
    async fetch(request: Request): Promise<Response> {
        const authInfo = await verifyToken(request);
        return handler.fetch(request, { authInfo });
    }
};
//#endregion McpHttpHandler_fetch_authInfo

// ---------------------------------------------------------------------------
// Harness (not shown on the page). `handler.fetch` is exactly what a
// web-standard runtime calls on the default export, so calling it with the
// page's curl request IS the deployment path. The page quotes the body
// verbatim. The two wrapper exports the page describes are exercised too:
// `guarded` must answer 403 for a Host outside its allowlist, and `secured`
// must still serve the request.
// ---------------------------------------------------------------------------

const curlRequest = (): Request =>
    new Request('http://127.0.0.1:8787/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });

const response = await handler.fetch(curlRequest());
const text = await response.text();
console.log(text);

const quotedOnPage =
    'event: message\n' +
    'data: {"result":{"tools":[{"name":"add-note","description":"Append a note","inputSchema":{"type":"object",' +
    '"$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"text":{"type":"string"}},"required":["text"]}}]},"jsonrpc":"2.0","id":1}';
if (response.status !== 200 || text.trimEnd() !== quotedOnPage) {
    throw new Error(`web-standard.md "Run it and verify" output drifted from the SDK: ${JSON.stringify(text)}`);
}

// "Protect against DNS rebinding": a Host outside the allowlist never reaches `fetch`.
const guardedResponse = await guarded.fetch(curlRequest());
if (guardedResponse.status !== 403) {
    throw new Error(`web-standard.md guard claim failed: expected 403, got ${guardedResponse.status}`);
}

// "Forward auth and the parsed body": the secured wrapper still serves the request.
const securedResponse = await secured.fetch(curlRequest());
if (securedResponse.status !== 200) {
    throw new Error(`web-standard.md auth claim failed: expected 200, got ${securedResponse.status}`);
}
