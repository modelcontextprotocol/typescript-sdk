/**
 * Self-contained test bodies for hosting:routing requirements.
 *
 * These pin the WebStandard server transport's routing between the session
 * (stateful) path and the stateless dispatch path for draft protocol
 * revisions, so they drive raw Request/Response against transports connected
 * directly (the routing decision is the transport's, not a hosting helper's).
 *
 * Routing rules under test: a session-bearing request always goes through
 * session validation regardless of version headers; the stateless path is
 * reachable only for draft versions the server is configured to support (and
 * only once a server is connected); the routed gap answers with a
 * self-describing error until stateless dispatch is implemented.
 */

import { randomUUID } from 'node:crypto';

import {
    DRAFT_PROTOCOL_VERSION_2026,
    LATEST_PROTOCOL_VERSION,
    McpServer,
    SUPPORTED_PROTOCOL_VERSIONS,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

function echoServer(options?: { listDraftVersion?: boolean }): McpServer {
    const s = new McpServer(
        { name: 's', version: '0' },
        options?.listDraftVersion ? { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION_2026] } : {}
    );
    s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return s;
}

const initializeBody = () =>
    JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'probe', version: '0' } }
    });

const toolsListBody = (id: number | string) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
};

verifies('hosting:routing:session-id-never-stateless', async (_args: TestArgs) => {
    // Direct transport so the routing decision under test is the SDK's, not a hosting helper's.
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await echoServer({ listDraftVersion: true }).connect(tx);

    try {
        const initRes = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...baseHeaders, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
                body: initializeBody()
            })
        );
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id')!;

        // Valid session + draft version header: served on the session path as today (SSE result),
        // even though the draft version alone would route stateless on this transport.
        const valid = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION_2026, 'mcp-session-id': sessionId },
                body: toolsListBody(2)
            })
        );
        expect(valid.status).toBe(200);
        expect(valid.headers.get('content-type')).toMatch(/text\/event-stream/);

        // Actually served on the session path, not merely accepted: the SSE stream carries
        // the tools/list result for request id 2 — a real response, never the stateless 501.
        const reader = valid.body!.getReader();
        const { value: firstEvent } = await reader.read();
        const dataLine = new TextDecoder()
            .decode(firstEvent)
            .split('\n')
            .find(line => line.startsWith('data: '));
        expect(dataLine).toBeDefined();
        expect(JSON.parse(dataLine!.slice('data: '.length))).toMatchObject({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [{ name: 'echo' }] }
        });

        // Unknown session + draft version header: session validation answers (404), never the 501.
        const unknown = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION_2026, 'mcp-session-id': 'no-such-session' },
                body: toolsListBody(3)
            })
        );
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' } });
    } finally {
        await tx.close();
    }
});

verifies('hosting:routing:stateless-only-configured', async (_args: TestArgs) => {
    const draftRequest = () =>
        new Request('http://in-process/mcp', {
            method: 'POST',
            headers: { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION_2026 },
            body: toolsListBody(1)
        });

    // Draft version claim on a server NOT listing the draft: today's unsupported-version 400, byte-identical.
    const txDefault = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await echoServer().connect(txDefault);
    try {
        const res = await txDefault.handleRequest(draftRequest());
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            jsonrpc: '2.0',
            id: null,
            error: {
                code: -32_000,
                message: `Bad Request: Unsupported protocol version: ${DRAFT_PROTOCOL_VERSION_2026} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`
            }
        });
    } finally {
        await txDefault.close();
    }

    // Draft version claim with the draft listed and a server connected: routed to the stateless path.
    const txDraft = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await echoServer({ listDraftVersion: true }).connect(txDraft);
    try {
        const res = await txDraft.handleRequest(draftRequest());
        expect(res.status).toBe(501);
        expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32_603 } });
    } finally {
        await txDraft.close();
    }
});

verifies('hosting:routing:gap-is-self-describing', async (_args: TestArgs) => {
    // One session-mode transport, draft listed: the same sessionless POST flips between the
    // session-required 400 and the stateless 501 purely on the claimed version.
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await echoServer({ listDraftVersion: true }).connect(tx);

    try {
        const initRes = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...baseHeaders, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
                body: initializeBody()
            })
        );
        expect(initRes.status).toBe(200);

        // Sessionless request at a released version: today's session-required 400.
        const sessionRequired = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...baseHeaders, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
                body: toolsListBody(2)
            })
        );
        expect(sessionRequired.status).toBe(400);
        const sessionRequiredBody = (await sessionRequired.json()) as { error: { code: number } };
        expect(sessionRequiredBody).toMatchObject({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Bad Request: Mcp-Session-Id header is required' }
        });

        // Sessionless request at the draft version: routed, and the gap is self-describing —
        // 501 with -32603 and the request id echoed, provably distinct from the 400 above.
        const routed = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION_2026 },
                body: toolsListBody(7)
            })
        );
        expect(routed.status).toBe(501);
        const routedBody = (await routed.json()) as { error: { code: number } };
        expect(routedBody).toEqual({
            jsonrpc: '2.0',
            id: 7,
            error: { code: -32_603, message: 'stateless request dispatch is not implemented yet' }
        });

        expect(routed.status).not.toBe(sessionRequired.status);
        expect(routedBody.error.code).not.toBe(sessionRequiredBody.error.code);
    } finally {
        await tx.close();
    }
});
