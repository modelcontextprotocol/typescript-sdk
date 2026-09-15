/**
 * Content-Type validation at the HTTP entries — the parsed media type decides,
 * never a substring search of the raw header.
 *
 * The shape pinned here: `Content-Type: text/plain; a=application/json`
 * contains the substring `application/json`, but its media type is
 * `text/plain` — every entry must answer it (and any other non-JSON media
 * type) with 415 before the body is dispatched, while values whose media type
 * is `application/json` keep working regardless of parameters or case.
 */
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core-internal';
import { beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { createMcpHandler } from '../../src/server/createMcpHandler';
import { McpServer } from '../../src/server/mcp';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

const MODERN_REVISION = '2026-07-28';

const executed: string[] = [];

function factory(): McpServer {
    const mcpServer = new McpServer({ name: 'ct-fixture', version: '1.0.0' });
    mcpServer.registerTool('run', { description: 'records each dispatch', inputSchema: { cmd: z.string() } }, async ({ cmd }) => {
        executed.push(cmd);
        return { content: [{ type: 'text', text: `ran: ${cmd}` }] };
    });
    return mcpServer;
}

const LEGACY_CALL = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'run', arguments: { cmd: 'hello' } }
};

const MODERN_CALL = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
        name: 'run',
        arguments: { cmd: 'hello' },
        _meta: {
            [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
            [CLIENT_INFO_META_KEY]: { name: 'ct-client', version: '1.0.0' },
            [CLIENT_CAPABILITIES_META_KEY]: {}
        }
    }
};

function postRequest(body: unknown, headers: Record<string, string>): Request {
    return new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
            Accept: 'application/json, text/event-stream',
            ...headers
        },
        body: JSON.stringify(body)
    });
}

beforeEach(() => {
    executed.length = 0;
});

describe('createMcpHandler Content-Type validation (default options, legacy stateless fallback active)', () => {
    it('serves an application/json POST (control)', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(postRequest(LEGACY_CALL, { 'Content-Type': 'application/json' }));
        expect(response.status).toBe(200);
        expect(executed).toEqual(['hello']);
    });

    it('accepts application/json with parameters', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(postRequest(LEGACY_CALL, { 'Content-Type': 'application/json; charset=utf-8' }));
        expect(response.status).toBe(200);
        expect(executed).toEqual(['hello']);
    });

    it('rejects text/plain with 415', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(postRequest(LEGACY_CALL, { 'Content-Type': 'text/plain' }));
        expect(response.status).toBe(415);
        expect(executed).toEqual([]);
    });

    it('rejects a non-JSON media type whose parameters contain `application/json` and does not dispatch', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(postRequest(LEGACY_CALL, { 'Content-Type': 'text/plain; a=application/json' }));
        expect(response.status).toBe(415);
        const body = (await response.json()) as { error: { code: number; message: string } };
        expect(body.error.code).toBe(-32_000);
        expect(body.error.message).toContain('Content-Type must be application/json');
        expect(executed).toEqual([]);
    });

    it('rejects a POST with no Content-Type header with 415', async () => {
        const handler = createMcpHandler(factory);
        // A string body makes Request auto-attach `text/plain;charset=UTF-8`;
        // delete it so this actually exercises the absent-header branch.
        const request = postRequest(LEGACY_CALL, {});
        request.headers.delete('content-type');
        expect(request.headers.get('content-type')).toBeNull();
        const response = await handler.fetch(request);
        expect(response.status).toBe(415);
        expect(executed).toEqual([]);
    });

    it('accepts an unambiguous media type with a malformed parameter section (trailing semicolon)', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(postRequest(LEGACY_CALL, { 'Content-Type': 'application/json;' }));
        expect(response.status).toBe(200);
        expect(executed).toEqual(['hello']);
    });

    it('rejects joined duplicate Content-Type headers', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(postRequest(LEGACY_CALL, { 'Content-Type': 'application/json, application/json' }));
        expect(response.status).toBe(415);
        expect(executed).toEqual([]);
    });

    it('validates the modern leg too: enveloped request with a non-JSON media type is answered 415 before dispatch', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(
            postRequest(MODERN_CALL, {
                'Content-Type': 'text/plain; a=application/json',
                'mcp-protocol-version': MODERN_REVISION,
                'Mcp-Method': 'tools/call',
                'Mcp-Name': 'run'
            })
        );
        expect(response.status).toBe(415);
        expect(executed).toEqual([]);
    });

    it('still serves the modern leg for application/json (control)', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(
            postRequest(MODERN_CALL, {
                'Content-Type': 'application/json',
                'mcp-protocol-version': MODERN_REVISION,
                'Mcp-Method': 'tools/call',
                'Mcp-Name': 'run'
            })
        );
        expect(response.status).toBe(200);
        expect(executed).toEqual(['hello']);
    });

    it('does not apply the POST check to bodyless methods', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(new Request('http://127.0.0.1/mcp', { method: 'DELETE' }));
        expect(response.status).not.toBe(415);
    });
});

describe('WebStandardStreamableHTTPServerTransport Content-Type validation (direct wiring)', () => {
    async function postToTransport(headers: Record<string, string>): Promise<Response> {
        const server = factory();
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });
        await server.connect(transport);
        const response = await transport.handleRequest(postRequest(LEGACY_CALL, headers));
        await server.close();
        return response;
    }

    it('rejects a non-JSON media type whose parameters contain `application/json` and does not dispatch', async () => {
        const response = await postToTransport({ 'Content-Type': 'text/plain; a=application/json' });
        expect(response.status).toBe(415);
        expect(executed).toEqual([]);
    });

    it('serves application/json (control)', async () => {
        const response = await postToTransport({ 'Content-Type': 'application/json' });
        expect(response.status).toBe(200);
        expect(executed).toEqual(['hello']);
    });
});
