/**
 * Result stamping and cache-field fill, end to end over the dual-era HTTP
 * entry (`createMcpHandler`), with the era boundary asserted on the wire:
 *
 * - 2026-07-28 cells: typed tools/list, resources/read and resources/list
 *   round trips through the negotiating client succeed, and the captured wire
 *   results carry `resultType: 'complete'` plus the required
 *   `ttlMs`/`cacheScope` fields, with three rungs of the documented precedence
 *   observable on the wire: the per-resource hint wins over the per-operation
 *   hint (resources/read), a per-operation hint wins over the defaults
 *   (tools/list), and a result with no configured author is filled with the
 *   `{ ttlMs: 0, cacheScope: 'private' }` defaults (resources/list). The top
 *   rung — a handler-returned value winning over every configured hint — is
 *   pinned at unit level (encodeContract), not here.
 * - 2025-11-25 cells: the same fully cache-hint-configured factory served to a
 *   plain client through the legacy stateless slot answers the same calls with
 *   none of that vocabulary anywhere in the response bytes.
 *
 * Like hosting-entry.test.ts these bodies host the handler's node face on a
 * real node:http listener and do not use `wire()`.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import type { McpHttpHandler, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';

/** The cache-field vocabulary that must never appear on a 2025-era response. */
const CACHE_VOCABULARY = ['"resultType"', '"ttlMs"', '"cacheScope"', '"cacheHint"'] as const;

function modernEnvelope() {
    return {
        [PROTOCOL_VERSION_META_KEY]: MODERN,
        [CLIENT_INFO_META_KEY]: { name: 'e2e-stamping-client', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: {}
    };
}

/**
 * One ctx-taking factory with every cache-hint author configured:
 * - a per-operation hint for tools/list (the funnel-built result with no other author),
 * - a per-operation hint for resources/read AND a per-resource hint on the
 *   registered resource, so the documented precedence (per-resource wins) is
 *   observable on the wire.
 */
function cacheConfiguredFactory(_ctx: McpRequestContext): McpServer {
    const server = new McpServer(
        { name: 'e2e-entry-cache', version: '1.0.0' },
        {
            capabilities: { tools: {}, resources: {} },
            cacheHints: {
                'tools/list': { ttlMs: 60_000, cacheScope: 'public' },
                'resources/read': { ttlMs: 90_000, cacheScope: 'public' }
            }
        }
    );
    server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
        content: [{ type: 'text', text: `hello ${name}` }]
    }));
    server.registerResource('note', 'memo://note', { cacheHint: { ttlMs: 12_000, cacheScope: 'private' } }, async uri => ({
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'cached note' }]
    }));
    return server;
}

interface Endpoint extends AsyncDisposable {
    baseUrl: URL;
    handler: McpHttpHandler;
}

async function startEndpoint(): Promise<Endpoint> {
    const handler = createMcpHandler(cacheConfiguredFactory, { legacy: 'stateless' });
    const httpServer: HttpServer = createServer((req, res) => void handler.node(req, res));
    const baseUrl = await listenOnRandomPort(httpServer);
    return {
        baseUrl,
        handler,
        [Symbol.asyncDispose]: async () => {
            await handler.close();
            await new Promise<void>((resolve, reject) => httpServer.close(error => (error ? reject(error) : resolve())));
        }
    };
}

/** Records every HTTP response body the client receives so wire bytes can be asserted alongside the typed results. */
function recordingFetch(responseBodies: string[]): typeof fetch {
    return async (input, init) => {
        const response = await fetch(input, init);
        responseBodies.push(await response.clone().text());
        return response;
    };
}

/** Parses a captured response body (plain JSON or SSE-framed) into its JSON-RPC messages. */
function jsonRpcMessagesFrom(text: string): Array<Record<string, unknown>> {
    if (text.trim() === '') return [];
    if (text.includes('data: ')) {
        return text
            .split('\n')
            .filter(line => line.startsWith('data: '))
            .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    }
    try {
        const parsed = JSON.parse(text) as Record<string, unknown> | Array<Record<string, unknown>>;
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        return [];
    }
}

/** Finds the wire result of the response message whose result carries the given key. */
function wireResultWith(responseBodies: string[], key: string): Record<string, unknown> | undefined {
    for (const body of responseBodies) {
        for (const message of jsonRpcMessagesFrom(body)) {
            const result = message.result as Record<string, unknown> | undefined;
            if (result && key in result) return result;
        }
    }
    return undefined;
}

verifies('typescript:hosting:entry:modern-cacheable-stamping', async (_args: TestArgs) => {
    await using endpoint = await startEndpoint();

    const responseBodies: string[] = [];
    const client = new Client({ name: 'e2e-stamping-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(endpoint.baseUrl, { fetch: recordingFetch(responseBodies) }));

    try {
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);

        // Typed round trips (the 2026 wire result schemas require the cache
        // fields, so a successful decode is itself part of the assertion).
        const list = (await client.request({ method: 'tools/list', params: { _meta: modernEnvelope() } })) as {
            tools: Array<{ name: string }>;
        };
        expect(list.tools.map(tool => tool.name)).toEqual(['greet']);

        const read = (await client.request({
            method: 'resources/read',
            params: { uri: 'memo://note', _meta: modernEnvelope() }
        })) as { contents: Array<{ text?: string }> };
        expect(read.contents[0]?.text).toBe('cached note');

        const resourceList = (await client.request({ method: 'resources/list', params: { _meta: modernEnvelope() } })) as {
            resources: Array<{ uri: string }>;
        };
        expect(resourceList.resources.map(resource => resource.uri)).toEqual(['memo://note']);

        // Wire-level: resultType is stamped and the cache fields carry the
        // configured hints. tools/list has only the per-operation author (its
        // hint wins over the defaults); resources/read shows the per-resource
        // hint winning over the per-operation hint; resources/list has no
        // configured author at all and is filled with the documented defaults.
        const listResult = wireResultWith(responseBodies, 'tools');
        expect(listResult).toBeDefined();
        expect(listResult).toMatchObject({ resultType: 'complete', ttlMs: 60_000, cacheScope: 'public' });

        const readResult = wireResultWith(responseBodies, 'contents');
        expect(readResult).toBeDefined();
        expect(readResult).toMatchObject({ resultType: 'complete', ttlMs: 12_000, cacheScope: 'private' });

        const resourceListResult = wireResultWith(responseBodies, 'resources');
        expect(resourceListResult).toBeDefined();
        expect(resourceListResult).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    } finally {
        await client.close();
    }
});

verifies('typescript:hosting:entry:legacy-cacheable-suppression', async (_args: TestArgs) => {
    await using endpoint = await startEndpoint();

    const responseBodies: string[] = [];
    const client = new Client({ name: 'plain-2025-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(endpoint.baseUrl, { fetch: recordingFetch(responseBodies) }));

    try {
        expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY);

        // The same calls, typed, on the 2025 leg (served through the legacy stateless slot).
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toEqual(['greet']);
        const read = await client.readResource({ uri: 'memo://note' });
        const firstContent = read.contents[0];
        expect(firstContent && 'text' in firstContent ? firstContent.text : undefined).toBe('cached note');

        // None of the 2026 cache vocabulary appears anywhere in the bytes of
        // any response of this conversation, even though every cache-hint
        // author is configured on the factory.
        const conversation = responseBodies.join('\n');
        expect(conversation).toContain('"tools"');
        expect(conversation).toContain('"contents"');
        for (const term of CACHE_VOCABULARY) {
            expect(conversation).not.toContain(term);
        }
    } finally {
        await client.close();
    }
});
