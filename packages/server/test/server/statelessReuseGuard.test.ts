/**
 * Stateless transport single-use invariant (restores v1 behavior, in effect
 * since sdk@1.26.0).
 *
 * A stateless `WebStandardStreamableHTTPServerTransport` (`sessionIdGenerator:
 * undefined`) serves exactly one HTTP request exchange; any further
 * `handleRequest()` call throws. Stateful transports (sessionIdGenerator set)
 * accept multiple requests on the same session.
 */
import { randomUUID } from 'node:crypto';

import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

const REUSE_ERROR = /Stateless transport cannot be reused across requests/;

function postRequest(body: JSONRPCMessage, extraHeaders: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            ...extraHeaders
        },
        body: JSON.stringify(body)
    });
}

function getRequest(): Request {
    return new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { accept: 'text/event-stream', 'mcp-protocol-version': '2025-11-25' }
    });
}

function deleteRequest(): Request {
    return new Request('http://localhost/mcp', {
        method: 'DELETE',
        headers: { 'mcp-protocol-version': '2025-11-25' }
    });
}

const initializeMessage: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'reuse-guard-test', version: '1.0.0' }
    }
};

const toolsListMessage: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe('stateless transport reuse guard', () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
        while (cleanups.length > 0) await cleanups.pop()!();
    });

    async function setupStateless(options: { enableJsonResponse?: boolean; configure?: (mcpServer: McpServer) => void } = {}): Promise<{
        transport: WebStandardStreamableHTTPServerTransport;
        mcpServer: McpServer;
    }> {
        const mcpServer = new McpServer({ name: 'reuse-guard-server', version: '1.0.0' }, { capabilities: { logging: {} } });
        options.configure?.(mcpServer);
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            ...(options.enableJsonResponse !== undefined && { enableJsonResponse: options.enableJsonResponse })
        });
        await mcpServer.connect(transport);
        cleanups.push(async () => {
            await mcpServer.close().catch(() => {});
            await transport.close().catch(() => {});
        });
        return { transport, mcpServer };
    }

    it('throws on a second POST', async () => {
        const { transport } = await setupStateless();

        const first = await transport.handleRequest(postRequest(initializeMessage));
        expect(first.status).toBe(200);

        await expect(transport.handleRequest(postRequest(toolsListMessage))).rejects.toThrow(REUSE_ERROR);
    });

    it('throws on a GET after a handled request', async () => {
        const { transport } = await setupStateless();

        const first = await transport.handleRequest(postRequest(initializeMessage));
        expect(first.status).toBe(200);

        await expect(transport.handleRequest(getRequest())).rejects.toThrow(REUSE_ERROR);
    });

    it('throws on a DELETE after a handled request', async () => {
        const { transport } = await setupStateless();

        const first = await transport.handleRequest(postRequest(initializeMessage));
        expect(first.status).toBe(200);

        await expect(transport.handleRequest(deleteRequest())).rejects.toThrow(REUSE_ERROR);
    });

    it('stateful transport (sessionIdGenerator set) still accepts multiple requests on the same session', async () => {
        const mcpServer = new McpServer({ name: 'stateful-server', version: '1.0.0' }, { capabilities: { logging: {} } });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        await mcpServer.connect(transport);
        cleanups.push(async () => {
            await mcpServer.close().catch(() => {});
            await transport.close().catch(() => {});
        });

        const initResponse = await transport.handleRequest(postRequest(initializeMessage));
        expect(initResponse.status).toBe(200);
        const sessionId = initResponse.headers.get('mcp-session-id');
        expect(sessionId).toBeTruthy();

        const second = await transport.handleRequest(postRequest(toolsListMessage, { 'mcp-session-id': sessionId! }));
        expect(second.status).toBe(200);

        const third = await transport.handleRequest(
            postRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': sessionId! })
        );
        expect(third.status).toBe(200);
    });

    /** Registers a gated `echo` tool so a request can be held in flight. */
    function registerGatedEchoTool(mcpServer: McpServer): { echoStarted: Promise<void>; releaseEcho: () => void } {
        let releaseEcho!: () => void;
        const echoGate = new Promise<void>(resolve => {
            releaseEcho = resolve;
        });
        let echoEntered!: () => void;
        const echoStarted = new Promise<void>(resolve => {
            echoEntered = resolve;
        });
        mcpServer.registerTool(
            'echo',
            { description: 'returns the caller-supplied marker once released', inputSchema: z.object({ marker: z.string() }) },
            async ({ marker }): Promise<CallToolResult> => {
                echoEntered();
                await echoGate;
                return { content: [{ type: 'text', text: `echo:${marker}` }] };
            }
        );
        return { echoStarted, releaseEcho };
    }

    const callBody = (marker: string): JSONRPCMessage => ({
        jsonrpc: '2.0',
        id: 7, // both exchanges use the same JSON-RPC id (client counters start identically)
        method: 'tools/call',
        params: { name: 'echo', arguments: { marker } }
    });

    it('a second POST during an in-flight stateless exchange throws; the first exchange completes with its own response (JSON shape)', async () => {
        // The second handleRequest() call (same JSON-RPC id - client counters
        // start identically) is rejected synchronously, before any of the
        // first exchange's routing state is touched; the first exchange then
        // completes normally.
        let gates!: { echoStarted: Promise<void>; releaseEcho: () => void };
        const { transport } = await setupStateless({
            enableJsonResponse: true,
            configure: mcpServer => {
                gates = registerGatedEchoTool(mcpServer);
            }
        });
        const { echoStarted, releaseEcho } = gates;

        // First exchange: in-flight request on the transport.
        const aPromise = transport.handleRequest(postRequest(callBody('marker-a')));
        await echoStarted;

        // Second exchange with the same request id while the first is in
        // flight - must throw.
        await expect(transport.handleRequest(postRequest(callBody('marker-b')))).rejects.toThrow(REUSE_ERROR);

        // The first exchange completes with its own response.
        releaseEcho();
        const aResponse = await aPromise;
        expect(aResponse.status).toBe(200);
        const aBody = await aResponse.text();
        expect(aBody).toContain('marker-a');
        expect(aBody).not.toContain('marker-b');
    });

    it('a second POST during an in-flight stateless SSE exchange throws; the first stream delivers its own response (SSE shape)', async () => {
        // Default SSE response mode: the second handleRequest() call is
        // rejected while the first exchange's stream is still open; the first
        // stream then delivers its own response.
        let gates!: { echoStarted: Promise<void>; releaseEcho: () => void };
        const { transport } = await setupStateless({
            configure: mcpServer => {
                gates = registerGatedEchoTool(mcpServer);
            }
        });
        const { echoStarted, releaseEcho } = gates;

        // First exchange: SSE response in flight (response headers arrive
        // before the tool resolves).
        const aResponse = await transport.handleRequest(postRequest(callBody('marker-a')));
        expect(aResponse.status).toBe(200);
        expect(aResponse.headers.get('content-type')).toContain('text/event-stream');
        await echoStarted;

        // Second exchange with the same request id while the first stream is
        // open - must throw.
        await expect(transport.handleRequest(postRequest(callBody('marker-b')))).rejects.toThrow(REUSE_ERROR);

        // The first stream delivers its own response (the stream closes after
        // the JSON-RPC response event, so text() terminates).
        releaseEcho();
        const aBody = await aResponse.text();
        expect(aBody).toContain('marker-a');
        expect(aBody).not.toContain('marker-b');
    });
});
