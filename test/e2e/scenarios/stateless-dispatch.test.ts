/**
 * Self-contained test bodies for the stateless dispatch path (per-request
 * protocol revisions, SEP-2575 + SEP-2567): envelope acceptance, version
 * negotiation errors, the removed-RPC gate, end-to-end service without an
 * initialize handshake, the `_meta`-sourced handler context, per-request
 * logging (the `logLevel` `_meta` claim), and the HTTP response shaping
 * (JSON vs SSE, 202 for notifications, header/`_meta` version mismatch).
 *
 * The streamableHttp cells drive raw Request/Response against WebStandard
 * transports connected directly (matching how the conformance harness drives
 * a server); the stdio cells drive hand-built newline-framed messages against
 * an in-process {@link StdioServerTransport} wired to a real server — except
 * protocol:stateless:request-served, whose stdio half spawns the fixture
 * server as a real child process.
 */

import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CallToolResultSchema, JSONRPCResultResponseSchema } from '@modelcontextprotocol/core';
import type { JSONRPCMessage, JSONRPCRequest, LoggingLevel } from '@modelcontextprotocol/server';
import {
    DRAFT_PROTOCOL_VERSION,
    LATEST_PROTOCOL_VERSION,
    McpServer,
    ReadBuffer,
    serializeMessage,
    SUPPORTED_PROTOCOL_VERSIONS,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/** Absolute path to the runnable stdio fixture server (executed with tsx). */
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/stdio-server.ts', import.meta.url));

/** E2E package root — spawn cwd so the workspace-local `tsx` resolves and tsconfig paths map workspace packages to source. */
const E2E_ROOT = fileURLToPath(new URL('../', import.meta.url));

const DRAFT_LISTED = [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION];

const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
};

const draftHeaders = { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION };

/** The complete per-request `_meta` envelope this protocol revision requires. */
const envelope = (overrides?: Record<string, unknown>) => ({
    'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'stateless-client', version: '9.9.9' },
    'io.modelcontextprotocol/clientCapabilities': {},
    ...overrides
});

/** Every RFC 5424 severity, lowest to highest. */
const ALL_LEVELS: LoggingLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

/** A server that has opted in to the draft revision, with an echo tool, a ctx-reporting tool, and a log-emitting tool. */
function statelessServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} }, supportedProtocolVersions: DRAFT_LISTED });
    s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    s.registerTool('whoami', { inputSchema: z.object({}) }, (_args, ctx) => ({
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    protocolVersion: ctx.mcpReq.protocolVersion,
                    clientInfo: ctx.client.info ?? null,
                    clientCapabilities: ctx.client.capabilities,
                    sessionId: ctx.sessionId ?? null
                })
            }
        ]
    }));
    s.registerTool('log-sweep', { inputSchema: z.object({}) }, async (_args, ctx) => {
        for (const level of ALL_LEVELS) {
            await ctx.mcpReq.log(level, `level-${level}`, 'sweep');
        }
        return { content: [{ type: 'text', text: 'swept' }] };
    });
    return s;
}

/** Connects a fresh stateless server to a session-less WebStandard transport. */
async function connectHttp(): Promise<WebStandardStreamableHTTPServerTransport> {
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await statelessServer().connect(tx);
    return tx;
}

const post = (tx: WebStandardStreamableHTTPServerTransport, body: unknown, headers: Record<string, string> = draftHeaders) =>
    tx.handleRequest(new Request('http://in-process/mcp', { method: 'POST', headers, body: JSON.stringify(body) }));

/** Parses the data lines of a complete SSE body into JSON-RPC messages. */
const parseSseEvents = (sseBody: string): JSONRPCMessage[] =>
    sseBody
        .split('\n\n')
        .filter(Boolean)
        .map(
            event =>
                JSON.parse(
                    event
                        .split('\n')
                        .find(line => line.startsWith('data: '))!
                        .slice('data: '.length)
                ) as JSONRPCMessage
        );

/**
 * In-process stdio wiring: a real server connected to a StdioServerTransport
 * over PassThrough pipes; messages are hand-built and framed exactly as on the
 * real wire (the SDK's serializeMessage/ReadBuffer framing).
 */
async function connectStdio(): Promise<{
    send: (message: JSONRPCMessage) => void;
    next: () => Promise<JSONRPCMessage>;
    close: () => Promise<void>;
}> {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = statelessServer();
    await server.connect(new StdioServerTransport(input, output));

    const buf = new ReadBuffer();
    const received: JSONRPCMessage[] = [];
    output.on('data', chunk => {
        buf.append(chunk as Buffer);
        let message: JSONRPCMessage | null;
        while ((message = buf.readMessage())) received.push(message);
    });

    let read = 0;
    return {
        send: message => void input.push(serializeMessage(message)),
        next: async () =>
            await vi.waitFor(() => {
                if (received.length <= read) throw new Error('no message yet');
                return received[read++]!;
            }),
        close: () => server.close()
    };
}

verifies('protocol:stateless:envelope-required', async ({ transport }: TestArgs) => {
    const cases: Array<{ id: number; meta?: Record<string, unknown> }> = [
        { id: 101 }, // _meta missing entirely
        { id: 102, meta: envelope({ 'io.modelcontextprotocol/protocolVersion': undefined }) },
        { id: 103, meta: envelope({ 'io.modelcontextprotocol/clientInfo': undefined }) },
        { id: 104, meta: envelope({ 'io.modelcontextprotocol/clientCapabilities': undefined }) }
    ];
    const request = ({ id, meta }: { id: number; meta?: Record<string, unknown> }): JSONRPCRequest => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
        params: meta ? { _meta: meta } : {}
    });

    if (transport === 'stdio') {
        // On stdio the _meta protocolVersion claim IS the routing signal, so only
        // requests that carry it can reach the stateless path at all: a request
        // with no _meta (or no version) is indistinguishable from stateful-era
        // traffic and is served on the existing path. The missing-meta and
        // missing-version rejections are HTTP-only (the header claims the era).
        const routableCases = cases.filter(testCase => typeof testCase.meta?.['io.modelcontextprotocol/protocolVersion'] === 'string');
        expect(routableCases.map(c => c.id)).toEqual([103, 104]);
        const stdio = await connectStdio();
        try {
            for (const testCase of routableCases) {
                stdio.send(request(testCase));
                expect(await stdio.next()).toMatchObject({ jsonrpc: '2.0', id: testCase.id, error: { code: -32_602 } });
            }
        } finally {
            await stdio.close();
        }
        return;
    }

    const tx = await connectHttp();
    try {
        for (const testCase of cases) {
            const res = await post(tx, request(testCase));
            expect(res.status).toBe(400);
            expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: testCase.id, error: { code: -32_602 } });
        }
    } finally {
        await tx.close();
    }
});

verifies('protocol:stateless:version-unsupported', async ({ transport }: TestArgs) => {
    const request: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: 301,
        method: 'tools/list',
        params: { _meta: envelope({ 'io.modelcontextprotocol/protocolVersion': 'v999.0.0' }) }
    };
    const expected = {
        jsonrpc: '2.0',
        id: 301,
        error: { code: -32_004, data: { supported: DRAFT_LISTED, requested: 'v999.0.0' } }
    };

    if (transport === 'stdio') {
        const stdio = await connectStdio();
        try {
            stdio.send(request);
            expect(await stdio.next()).toMatchObject(expected);
        } finally {
            await stdio.close();
        }
        return;
    }

    const tx = await connectHttp();
    try {
        // Header and _meta agree on the unsupported version (a disagreement would be -32001).
        const res = await post(tx, request, { ...baseHeaders, 'mcp-protocol-version': 'v999.0.0' });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject(expected);
    } finally {
        await tx.close();
    }
});

verifies('protocol:stateless:removed-methods', async ({ transport }: TestArgs) => {
    // initialize and ping have live handlers on every server (the stateful path
    // serves them), logging/setLevel has one because the fixture declares the
    // logging capability — so the -32601 here proves the gate, not a gap.
    const methods = ['initialize', 'ping', 'logging/setLevel', 'resources/subscribe', 'resources/unsubscribe', 'unknown/method'];
    const request = (id: number, method: string): JSONRPCRequest => ({
        jsonrpc: '2.0',
        id,
        method,
        params: { _meta: envelope() }
    });

    if (transport === 'stdio') {
        const stdio = await connectStdio();
        try {
            for (const [index, method] of methods.entries()) {
                stdio.send(request(500 + index, method));
                expect(await stdio.next()).toMatchObject({
                    jsonrpc: '2.0',
                    id: 500 + index,
                    error: { code: -32_601, message: 'Method not found' }
                });
            }
        } finally {
            await stdio.close();
        }
        return;
    }

    const tx = await connectHttp();
    try {
        for (const [index, method] of methods.entries()) {
            const res = await post(tx, request(500 + index, method));
            expect(res.status, method).toBe(404);
            expect(await res.json()).toMatchObject({
                jsonrpc: '2.0',
                id: 500 + index,
                error: { code: -32_601, message: 'Method not found' }
            });
        }
    } finally {
        await tx.close();
    }
});

verifies('protocol:stateless:request-served', async ({ transport }: TestArgs) => {
    const echoCall = (id: number): JSONRPCRequest => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'self-contained' }, _meta: envelope() }
    });

    if (transport === 'stdio') {
        // Real child process, no initialize handshake — the first message the
        // server ever sees is the enveloped request, and it is served.
        const tx = new StdioClientTransport({
            command: process.execPath,
            args: ['--import', 'tsx', FIXTURE_PATH],
            cwd: E2E_ROOT,
            env: { E2E_LIST_DRAFT_VERSION: '1' }
        });
        const received: JSONRPCMessage[] = [];
        tx.onmessage = message => void received.push(message);
        try {
            await tx.start();
            await tx.send(echoCall(7));
            // Generous wait: tsx compiles the fixture inside the freshly spawned child before it can answer.
            await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000, interval: 25 });
            const response = JSONRPCResultResponseSchema.parse(received[0]);
            expect(response.id).toBe(7);
            expect(CallToolResultSchema.parse(response.result).content).toEqual([{ type: 'text', text: 'self-contained' }]);
        } finally {
            await tx.close();
        }
        return;
    }

    const tx = await connectHttp();
    try {
        const res = await post(tx, echoCall(7));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = JSONRPCResultResponseSchema.parse(await res.json());
        expect(body.id).toBe(7);
        expect(CallToolResultSchema.parse(body.result).content).toEqual([{ type: 'text', text: 'self-contained' }]);
    } finally {
        await tx.close();
    }
});

verifies('protocol:stateless:ctx-meta-sourced', async ({ transport }: TestArgs) => {
    const whoamiCall = (id: number): JSONRPCRequest => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
            name: 'whoami',
            arguments: {},
            _meta: envelope({ 'io.modelcontextprotocol/clientCapabilities': { sampling: {} } })
        }
    });
    const expectMetaSourced = (result: unknown) => {
        const content = CallToolResultSchema.parse(result).content;
        expect(content[0]?.type).toBe('text');
        expect(JSON.parse((content[0] as { text: string }).text)).toEqual({
            protocolVersion: DRAFT_PROTOCOL_VERSION,
            clientInfo: { name: 'stateless-client', version: '9.9.9' },
            clientCapabilities: { sampling: {} },
            sessionId: null
        });
    };
    const initializeRequest: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { roots: {} },
            clientInfo: { name: 'handshake-client', version: '0' }
        }
    };

    if (transport === 'stdio') {
        const stdio = await connectStdio();
        try {
            // Populate the handshake state first, so non-inheritance is observable.
            stdio.send(initializeRequest);
            expect(await stdio.next()).toMatchObject({ jsonrpc: '2.0', id: 1 });
            stdio.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

            stdio.send(whoamiCall(2));
            const response = JSONRPCResultResponseSchema.parse(await stdio.next());
            expectMetaSourced(response.result);
        } finally {
            await stdio.close();
        }
        return;
    }

    // Session-mode transport: a real initialize populates the handshake state
    // (handshake-client, roots capability) before the stateless request arrives —
    // the handler must see the envelope facts, not the handshake's.
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await statelessServer().connect(tx);
    try {
        const initRes = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...baseHeaders, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
                body: JSON.stringify(initializeRequest)
            })
        );
        expect(initRes.status).toBe(200);

        const res = await post(tx, whoamiCall(2));
        expect(res.status).toBe(200);
        const body = JSONRPCResultResponseSchema.parse(await res.json());
        expectMetaSourced(body.result);
    } finally {
        await tx.close();
    }
});

/** A tools/call of the log-sweep tool, optionally claiming a per-request log level. */
const sweepCall = (id: number, logLevel?: string): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
        name: 'log-sweep',
        arguments: {},
        _meta: envelope(logLevel === undefined ? {} : { 'io.modelcontextprotocol/logLevel': logLevel })
    }
});

verifies('protocol:stateless:per-request-loglevel', async ({ transport }: TestArgs) => {
    // The handler emits all eight severities; a 'warning' claim must deliver
    // exactly the five at or above it, in order, before the final response.
    const atOrAboveWarning = ALL_LEVELS.slice(ALL_LEVELS.indexOf('warning'));

    if (transport === 'stdio') {
        const stdio = await connectStdio();
        try {
            stdio.send(sweepCall(801, 'warning'));
            for (const level of atOrAboveWarning) {
                expect(await stdio.next()).toMatchObject({
                    method: 'notifications/message',
                    params: { level, logger: 'sweep', data: `level-${level}` }
                });
            }
            expect(await stdio.next()).toMatchObject({ jsonrpc: '2.0', id: 801 });

            // An unrecognized level value is an envelope violation: -32602, id echoed.
            stdio.send(sweepCall(802, 'verbose'));
            expect(await stdio.next()).toMatchObject({ jsonrpc: '2.0', id: 802, error: { code: -32_602 } });
        } finally {
            await stdio.close();
        }
        return;
    }

    const tx = await connectHttp();
    try {
        const res = await post(tx, sweepCall(801, 'warning'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        const events = parseSseEvents(await res.text());
        expect(events).toHaveLength(atOrAboveWarning.length + 1);
        for (const [index, level] of atOrAboveWarning.entries()) {
            expect(events[index]).toMatchObject({
                method: 'notifications/message',
                params: { level, logger: 'sweep', data: `level-${level}` }
            });
        }
        expect(events.at(-1)).toMatchObject({ jsonrpc: '2.0', id: 801 });

        // An unrecognized level value is an envelope violation: -32602, id echoed.
        const invalid = await post(tx, sweepCall(802, 'verbose'));
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ jsonrpc: '2.0', id: 802, error: { code: -32_602 } });
    } finally {
        await tx.close();
    }
});

verifies('protocol:stateless:no-log-without-loglevel', async ({ transport }: TestArgs) => {
    if (transport === 'stdio') {
        const stdio = await connectStdio();
        try {
            // A preceding request claims debug — every severity is delivered for IT...
            stdio.send(sweepCall(901, 'debug'));
            for (const level of ALL_LEVELS) {
                expect(await stdio.next()).toMatchObject({ method: 'notifications/message', params: { level } });
            }
            expect(await stdio.next()).toMatchObject({ jsonrpc: '2.0', id: 901 });

            // ...and is never stored: the unclaimed request's next frame is its
            // result directly — no notifications/message leaked from the claim.
            stdio.send(sweepCall(902));
            const response = JSONRPCResultResponseSchema.parse(await stdio.next());
            expect(response.id).toBe(902);
        } finally {
            await stdio.close();
        }
        return;
    }

    const tx = await connectHttp();
    try {
        // A preceding request claims debug — every severity is delivered for IT...
        const claimed = await post(tx, sweepCall(901, 'debug'));
        expect(claimed.status).toBe(200);
        expect(claimed.headers.get('content-type')).toBe('text/event-stream');
        const claimedEvents = parseSseEvents(await claimed.text());
        expect(claimedEvents.filter(message => 'method' in message && message.method === 'notifications/message')).toHaveLength(
            ALL_LEVELS.length
        );

        // ...and is never stored: with no claim nothing is emitted, so the lazy
        // SSE stream never opens and the answer is a single application/json
        // object — no notifications/message anywhere.
        const bare = await post(tx, sweepCall(902));
        expect(bare.status).toBe(200);
        expect(bare.headers.get('content-type')).toContain('application/json');
        const body = JSONRPCResultResponseSchema.parse(await bare.json());
        expect(body.id).toBe(902);
    } finally {
        await tx.close();
    }
});

verifies('hosting:http:version-header-meta-mismatch', async (_args: TestArgs) => {
    const tx = await connectHttp();
    try {
        const res = await post(tx, {
            jsonrpc: '2.0',
            id: 'mismatch-1',
            method: 'tools/list',
            params: { _meta: envelope({ 'io.modelcontextprotocol/protocolVersion': 'v999.0.0' }) }
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
            jsonrpc: '2.0',
            id: 'mismatch-1',
            error: { code: -32_001, message: expect.stringContaining('Header mismatch') }
        });
    } finally {
        await tx.close();
    }
});

verifies('hosting:http:stateless-notification-202', async (_args: TestArgs) => {
    const tx = await connectHttp();
    try {
        const res = await post(tx, {
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 'x', _meta: envelope() }
        });
        expect(res.status).toBe(202);
        expect(await res.text()).toBe('');
    } finally {
        await tx.close();
    }
});

verifies('hosting:http:stateless-response-stream', async (_args: TestArgs) => {
    const makeServer = () => {
        const s = statelessServer();
        s.registerTool('progressing', { inputSchema: z.object({}) }, async (_args, ctx) => {
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'tok', progress: 1, total: 2 } });
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'tok', progress: 2, total: 2 } });
            return { content: [{ type: 'text', text: 'streamed' }] };
        });
        return s;
    };
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await makeServer().connect(tx);

    try {
        // A handler that emits request-scoped notifications: SSE, notifications in
        // order, terminated by the final response. Never a session header.
        const sse = await post(tx, {
            jsonrpc: '2.0',
            id: 'stream-1',
            method: 'tools/call',
            params: { name: 'progressing', arguments: {}, _meta: envelope() }
        });
        expect(sse.status).toBe(200);
        expect(sse.headers.get('content-type')).toBe('text/event-stream');
        expect(sse.headers.get('mcp-session-id')).toBeNull();

        const events = parseSseEvents(await sse.text());
        expect(events).toHaveLength(3);
        expect(events[0]).toMatchObject({ method: 'notifications/progress', params: { progress: 1 } });
        expect(events[1]).toMatchObject({ method: 'notifications/progress', params: { progress: 2 } });
        expect(events[2]).toMatchObject({ jsonrpc: '2.0', id: 'stream-1', result: {} });
        // The stream ended with the response: res.text() returning proves termination.

        // A handler that emits nothing: a single application/json object.
        const json = await post(tx, {
            jsonrpc: '2.0',
            id: 'stream-2',
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'plain' }, _meta: envelope() }
        });
        expect(json.status).toBe(200);
        expect(json.headers.get('content-type')).toContain('application/json');
        expect(json.headers.get('mcp-session-id')).toBeNull();
        expect(await json.json()).toMatchObject({ jsonrpc: '2.0', id: 'stream-2' });
    } finally {
        await tx.close();
    }
});
