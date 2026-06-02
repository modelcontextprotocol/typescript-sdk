/**
 * Self-contained test bodies for hosting:routing requirements.
 *
 * These pin the server transports' routing between the existing (stateful)
 * path and the stateless dispatch path for per-request protocol revisions.
 * The streamableHttp cells drive raw Request/Response against WebStandard
 * transports connected directly (the routing decision is the transport's, not
 * a hosting helper's); the stdio cell spawns the fixture server in
 * `fixtures/stdio-server.ts` as a real child process and injects hand-built
 * JSON-RPC messages via {@link StdioClientTransport} — on stdio there is no
 * session header, so routing keys on the request's `_meta` version claim,
 * dual-keyed with the server's opt-in.
 *
 * Routing rules under test: a session-bearing request always goes through
 * session validation regardless of version headers; the stateless path is
 * reachable only when the server has opted in by listing a non-stateful
 * version in its supported list.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CallToolResultSchema, JSONRPCResultResponseSchema, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/server';
import {
    DRAFT_PROTOCOL_VERSION,
    LATEST_PROTOCOL_VERSION,
    McpServer,
    SUPPORTED_PROTOCOL_VERSIONS,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/** Absolute path to the runnable stdio fixture server (executed with tsx). */
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/stdio-server.ts', import.meta.url));

/** E2E package root — spawn cwd so the workspace-local `tsx` resolves and tsconfig paths map workspace packages to source. */
const E2E_ROOT = fileURLToPath(new URL('../', import.meta.url));

function echoServer(options?: { listDraftVersion?: boolean }): McpServer {
    const s = new McpServer(
        { name: 's', version: '0' },
        options?.listDraftVersion ? { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION] } : {}
    );
    s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return s;
}

const initializeRequest = (id: number): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'probe', version: '0' } }
});

const initializeBody = () => JSON.stringify(initializeRequest(1));

const toolsListBody = (id: number | string) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
};

/** Hand-built echo tools/call whose `params._meta` claims the draft protocol version — the stdio routing signal. */
const draftClaimingEchoCall = (id: number): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'claimed' }, _meta: { [PROTOCOL_VERSION_META_KEY]: DRAFT_PROTOCOL_VERSION } }
});

/** Spawns the stdio fixture server (optionally listing the draft protocol version) and collects its messages. */
function spawnStdioFixture(options?: { listDraftVersion?: boolean }): { transport: StdioClientTransport; received: JSONRPCMessage[] } {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE_PATH],
        cwd: E2E_ROOT,
        ...(options?.listDraftVersion ? { env: { E2E_LIST_DRAFT_VERSION: '1' } } : {})
    });
    const received: JSONRPCMessage[] = [];
    transport.onmessage = message => void received.push(message);
    return { transport, received };
}

/**
 * stdio half of stateless-only-configured: on a fixture server that does NOT
 * list any non-stateful version, a request claiming one via `_meta` is NOT
 * routed — it is served on the existing path exactly as today (dual key: the
 * claim alone never routes). The routed half on stdio is pinned by the
 * protocol:stateless:request-served stdio body.
 */
async function statelessOnlyConfiguredStdio(): Promise<void> {
    const { transport, received } = spawnStdioFixture();
    try {
        await transport.start();

        await transport.send(initializeRequest(1));
        // Generous first wait: tsx compiles the fixture inside the freshly spawned child before it can answer.
        await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000, interval: 25 });
        await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        await transport.send(draftClaimingEchoCall(2));
        await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5000, interval: 25 });

        // Existing behavior, untouched: a tools/call result — never a stateless-path error.
        const response = JSONRPCResultResponseSchema.parse(received[1]);
        expect(response.id).toBe(2);
        expect(CallToolResultSchema.parse(response.result).content).toEqual([{ type: 'text', text: 'claimed' }]);
    } finally {
        await transport.close();
    }
}

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
                headers: { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION, 'mcp-session-id': sessionId },
                body: toolsListBody(2)
            })
        );
        expect(valid.status).toBe(200);
        expect(valid.headers.get('content-type')).toMatch(/text\/event-stream/);

        // Actually served on the session path, not merely accepted: the SSE stream carries
        // the tools/list result for request id 2 — a real response, never a stateless-path
        // rejection (the session-path request has no _meta envelope, which the stateless
        // path would refuse with -32602).
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

        // Unknown session + draft version header: session validation answers (404),
        // never the stateless path.
        const unknown = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION, 'mcp-session-id': 'no-such-session' },
                body: toolsListBody(3)
            })
        );
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' } });
    } finally {
        await tx.close();
    }
});

verifies('hosting:routing:stateless-only-configured', async ({ transport }: TestArgs) => {
    if (transport === 'stdio') {
        await statelessOnlyConfiguredStdio();
        return;
    }

    const draftRequest = () =>
        new Request('http://in-process/mcp', {
            method: 'POST',
            headers: { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION },
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
                message: `Bad Request: Unsupported protocol version: ${DRAFT_PROTOCOL_VERSION} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`
            }
        });
    } finally {
        await txDefault.close();
    }

    // Same claim with the draft listed and a server connected: handled on the stateless
    // path — proven by its distinctive envelope rejection (-32602 for the missing _meta
    // envelope; the stateful path would have served tools/list normally here).
    const txDraft = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await echoServer({ listDraftVersion: true }).connect(txDraft);
    try {
        const res = await txDraft.handleRequest(draftRequest());
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32_602 } });
    } finally {
        await txDraft.close();
    }
});
