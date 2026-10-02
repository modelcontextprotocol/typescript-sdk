/**
 * HTTP request mechanics on the dual-era HTTP entry (`createMcpHandler`),
 * exercised through the wire() entry arms. These are the entry-side siblings
 * of the `hosting:http:*` / `hosting:stateless:*` rows, whose bodies hand-host
 * the streamable HTTP server transport themselves and so never reach
 * `createMcpHandler` when given an entry arm. Every probe here goes through
 * `wired.fetch` against the harness-hosted entry so the HTTP status/body is
 * observed directly; the matrix arm selects which leg of the entry answers it
 * (`entryStateless` → the stateless legacy fallback; `entryModern` → the
 * modern-only strict path).
 */
import { Client } from '@modelcontextprotocol/client';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const LEGACY = '2025-11-25';

/** One ctx-taking factory backing every cell. */
function echoFactory(_ctx?: McpRequestContext): McpServer {
    const server = new McpServer({ name: 'e2e-entry-http', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return server;
}

verifies('typescript:hosting:entry:method-405', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'method-405-client', version: '1.0.0' });
    // No `entry` override: the arm posture (`stateless` on entryStateless,
    // `reject` on entryModern) is the configuration under test.
    await using wired = await wire(transport, echoFactory, client);

    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
        const response = await wired.fetch!(wired.url!, { method });
        expect(response.status).toBe(405);
        const body = (await response.json()) as { jsonrpc: string; error: { code: number; message: string } };
        expect(body.jsonrpc).toBe('2.0');
        expect(body.error.code).toBe(-32_000);
        expect(body.error.message).toMatch(/method not allowed/i);
    }
});

verifies('typescript:hosting:entry:parse-error-400', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'parse-error-client', version: '1.0.0' });
    await using wired = await wire(transport, echoFactory, client);

    const response = await wired.fetch!(wired.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: 'not json'
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32_700);
});

verifies('typescript:hosting:entry:legacy-accept-406', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'accept-406-client', version: '1.0.0' });
    await using wired = await wire(transport, echoFactory, client);

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    // The legacy server transport requires both application/json and
    // text/event-stream on POST: each single-type Accept (and an absent
    // Accept) is rejected at 406 by the fallback the entry delegated to.
    for (const accept of ['application/json', 'text/event-stream', undefined]) {
        const response = await wired.fetch!(wired.url!, {
            method: 'POST',
            headers: {
                'mcp-protocol-version': LEGACY,
                'content-type': 'application/json',
                ...(accept !== undefined && { accept })
            },
            body
        });
        expect(response.status).toBe(406);
    }
});

verifies('typescript:hosting:entry:legacy-content-type-415', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'content-type-415-client', version: '1.0.0' });
    await using wired = await wire(transport, echoFactory, client);

    // A non-JSON Content-Type carrying a syntactically-JSON 2025-era body: the
    // entry classifier reads the body (it does not gate on Content-Type), routes
    // it legacy, and the fallback's transport answers 415 on Content-Type alone.
    const response = await wired.fetch!(wired.url!, {
        method: 'POST',
        headers: {
            'mcp-protocol-version': LEGACY,
            'content-type': 'text/plain',
            accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(response.status).toBe(415);
});

verifies('typescript:hosting:entry:legacy-protocol-version-header-400', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'protocol-version-400-client', version: '1.0.0' });
    await using wired = await wire(transport, echoFactory, client);

    // An unknown (and not modern-era) protocol-version header on a 2025-era
    // body: the entry routes it legacy, and the fallback's transport answers
    // the spec's 400 with the supported version(s) named in the body.
    const response = await wired.fetch!(wired.url!, {
        method: 'POST',
        headers: {
            'mcp-protocol-version': '1999-01-01',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(LEGACY);
});

verifies('typescript:hosting:entry:legacy-protocol-version-default', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'protocol-version-default-client', version: '1.0.0' });
    await using wired = await wire(transport, echoFactory, client);

    // No MCP-Protocol-Version header at all: the legacy fallback assumes the
    // spec's default version, so a 2025-era tools/list still round-trips.
    const response = await wired.fetch!(wired.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"echo"');
});

verifies('typescript:hosting:entry:no-session-id', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'no-session-id-client', version: '1.0.0' });
    await using wired = await wire(transport, echoFactory, client);

    // A typed round trip through the wired client (so both the connect-time
    // negotiation and a follow-up request are recorded), then assert no
    // exchange ever carried an Mcp-Session-Id response header.
    const result = await client.callTool({ name: 'echo', arguments: { text: 'probe' } });
    expect(result.content).toEqual([{ type: 'text', text: 'probe' }]);

    expect(wired.httpLog!.length).toBeGreaterThan(0);
    for (const exchange of wired.httpLog!) {
        expect(exchange.response.headers.get('mcp-session-id')).toBeNull();
    }
});
