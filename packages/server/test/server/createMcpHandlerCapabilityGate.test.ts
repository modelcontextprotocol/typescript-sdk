/**
 * The pre-dispatch client-capability gate at the HTTP entry: a request to a
 * method that requires a client capability the request's envelope did not
 * declare is refused with the typed `-32003` error and HTTP 400, before any
 * server instance is constructed or dispatched.
 *
 * No request method served on the 2026-07-28 registry has a static
 * requirement today, so these tests drive the gate by adding (and removing) a
 * temporary entry to the requirement table; the production behavior with the
 * empty table — every modern request passes the gate — is pinned too.
 */
import type { ClientCapabilities } from '@modelcontextprotocol/core';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    REQUIRED_CLIENT_CAPABILITIES_BY_METHOD
} from '@modelcontextprotocol/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { createMcpHandler } from '../../src/server/createMcpHandler.js';
import { McpServer } from '../../src/server/mcp.js';

const MODERN_REVISION = '2026-07-28';

const envelope = (clientCapabilities: ClientCapabilities) => ({
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'gate-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities
});

function postEcho(clientCapabilities: ClientCapabilities): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'hi' }, _meta: envelope(clientCapabilities) }
        })
    });
}

function factory(): McpServer {
    const mcpServer = new McpServer({ name: 'gate-test-server', version: '1.0.0' });
    mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return mcpServer;
}

const requirementTable = REQUIRED_CLIENT_CAPABILITIES_BY_METHOD as Record<string, ClientCapabilities>;

afterEach(() => {
    delete requirementTable['tools/call'];
});

describe('the pre-dispatch client-capability gate', () => {
    it('serves modern requests normally while no requirement applies (the table is empty in production)', async () => {
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(postEcho({}));
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('hi');
    });

    it('refuses a request missing a required capability with -32003 and HTTP 400, echoing the request id', async () => {
        requirementTable['tools/call'] = { sampling: {} };
        let factoryRan = false;
        const handler = createMcpHandler(() => {
            factoryRan = true;
            return factory();
        });

        const response = await handler.fetch(postEcho({ elicitation: {} }));
        expect(response.status).toBe(400);
        const body = (await response.json()) as {
            id: unknown;
            error: { code: number; data?: { requiredCapabilities?: ClientCapabilities } };
        };
        expect(body.error.code).toBe(-32_003);
        expect(body.error.data?.requiredCapabilities).toEqual({ sampling: {} });
        expect(body.id).toBe(7);
        // Pre-dispatch: the refusal happens before any per-request instance exists.
        expect(factoryRan).toBe(false);
    });

    it('serves the request once the required capability is declared in the envelope', async () => {
        requirementTable['tools/call'] = { sampling: {} };
        const handler = createMcpHandler(factory);
        const response = await handler.fetch(postEcho({ sampling: {} }));
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('hi');
    });
});
