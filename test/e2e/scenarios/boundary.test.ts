/**
 * Strict/loose validation-boundary tests plus the client-side result-parse layer.
 *
 * The SDK's Zod schemas draw a deliberate accept/strip/reject line at each wire
 * boundary: JSON-RPC envelopes are strict, empty-result acks are strict, typed
 * request params strip unknown siblings, and typed results pass unknown siblings
 * through to the consumer. These tests pin that line per boundary so an additive
 * protocol revision cannot silently move it, and pin that a result failing the
 * consumer-supplied schema rejects with the raw validator error (never a wrapped
 * protocol error).
 */

import { PassThrough } from 'node:stream';

import { expect, vi } from 'vitest';
import { z } from 'zod/v4';
import { $ZodError } from 'zod/v4/core';

import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { StdioServerTransport } from '../../../src/server/stdio.js';
import { ReadBuffer, serializeMessage } from '../../../src/shared/stdio.js';
import type { Transport as SdkTransport } from '../../../src/shared/transport.js';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    CompleteRequestSchema,
    type JSONRPCMessage,
    ListToolsRequestSchema,
    McpError,
    PingRequestSchema
} from '../../../src/types.js';

import { hostStateless, wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const newClient = () => new Client({ name: 'c', version: '0' });

/** Issue codes off a raw validator error, typed loosely so the assertion does not depend on zod's generics. */
const issueCodes = (err: unknown): string[] => ((err as { issues?: Array<{ code: string }> }).issues ?? []).map(i => i.code);

verifies('typescript:types:empty-result-strict', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
        // Deliberately violate the empty-result contract: an extra non-_meta key on the ping ack.
        s.setRequestHandler(PingRequestSchema, () => ({ ok: true }));
        return s;
    };
    const client = newClient();
    // The server intentionally puts a non-conforming MCP result on the wire.
    await using _ = await wire({ transport, protocolVersion }, makeServer, client, { strictValidation: false });

    const err: unknown = await client.ping().then(
        () => undefined,
        (e: unknown) => e
    );

    // EmptyResultSchema is strict: the extra key rejects client-side with the raw validator error.
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(McpError);
    expect(err).toBeInstanceOf($ZodError);
    expect(issueCodes(err)).toContain('unrecognized_keys');
});

verifies('typescript:types:envelope-strict', async ({ transport, protocolVersion }: TestArgs) => {
    if (transport === 'streamableHttp') {
        // HTTP arm: an otherwise-valid request envelope with an unknown top-level sibling is
        // rejected at the body parser — never dispatched — with a -32700 error response.
        const { handleRequest, close } = hostStateless(() => new Server({ name: 's', version: '0' }, { capabilities: {} }));
        try {
            const res = await handleRequest(
                new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: {
                        'mcp-protocol-version': protocolVersion,
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {}, extraTop: true })
                })
            );
            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
        } finally {
            await close();
        }
        return;
    }

    // stdio arm: the same envelope on the wire surfaces via onerror, the message is dropped
    // (no response is ever produced for its id), and the connection keeps serving requests.
    const errors: Error[] = [];
    const server = new Server({ name: 's', version: '0' }, { capabilities: {} });
    server.onerror = e => errors.push(e);
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    await server.connect(new StdioServerTransport(clientToServer, serverToClient));

    const received: JSONRPCMessage[] = [];
    const readBuffer = new ReadBuffer();
    serverToClient.on('data', chunk => {
        readBuffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = readBuffer.readMessage())) received.push(message);
    });
    const responsesFor = (id: number) => received.filter(m => 'id' in m && m.id === id);

    try {
        clientToServer.write(
            serializeMessage({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-boundary-client', version: '0' } }
            })
        );
        await vi.waitFor(() => expect(responsesFor(1)).toHaveLength(1));

        clientToServer.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {}, extraTop: true }) + '\n');
        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));

        clientToServer.write(serializeMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }));
        await vi.waitFor(() => expect(responsesFor(3)).toHaveLength(1));

        // The malformed envelope was dropped, not answered or dispatched.
        expect(responsesFor(2)).toEqual([]);
    } finally {
        await server.close();
    }
});

verifies('typescript:types:request-params-strip', async ({ transport, protocolVersion }: TestArgs) => {
    const seenParams: unknown[] = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(CallToolRequestSchema, req => {
            seenParams.push(req.params);
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.request(
        { method: 'tools/call', params: { name: 'echo', arguments: {}, future2026: 1 } },
        CallToolResultSchema
    );

    // The unknown sibling param is accepted (not rejected) and stripped before the handler sees it.
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(seenParams).toHaveLength(1);
    expect(seenParams[0]).toEqual({ name: 'echo', arguments: {} });
});

verifies('typescript:types:result-passthrough', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(CallToolRequestSchema, () => ({
            content: [{ type: 'text', text: 'metered' }],
            resultType: 'complete',
            ttlMs: 5
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.callTool({ name: 'cached_call', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'metered' }]);
    // Unknown top-level result siblings survive the typed result parse and reach the consumer.
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(5);
});

verifies('typescript:types:completion-result-loose', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { completions: {} } });
        s.setRequestHandler(CompleteRequestSchema, () => ({ completion: { values: ['alpha'], extraField: 'kept' } }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'greeting' },
        argument: { name: 'style', value: 'a' }
    });

    expect(result.completion.values).toEqual(['alpha']);
    // The completion object is loose: unknown sibling fields are preserved for the consumer.
    expect(result.completion.extraField).toBe('kept');
});

verifies('typescript:consumer:result-validation-error', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    // Sanity: the same request resolves when the consumer-supplied schema matches the result.
    const ok = await client.request({ method: 'tools/list' }, z.object({ tools: z.array(z.unknown()) }));
    expect(ok.tools).toEqual([]);

    const err: unknown = await client.request({ method: 'tools/list' }, z.object({ impossible: z.literal('x') })).then(
        () => undefined,
        (e: unknown) => e
    );

    // The raw validator error crosses the boundary: issues-bearing, not wrapped into McpError,
    // and without a JSON-RPC error code — consumers tell local validation failures from remote errors by this split.
    expect(err).toBeDefined();
    expect(err).toBeInstanceOf($ZodError);
    expect(err).not.toBeInstanceOf(McpError);
    expect(issueCodes(err).length).toBeGreaterThan(0);
    expect((err as { code?: unknown }).code).toBeUndefined();
});

/** Consumer-implemented Transport that answers initialize with a schema-invalid result body. */
class MalformedInitializeTransport implements SdkTransport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    async start(): Promise<void> {}

    async send(message: JSONRPCMessage): Promise<void> {
        if (!('method' in message) || !('id' in message) || message.method !== 'initialize') return;
        queueMicrotask(() =>
            this.onmessage?.({
                jsonrpc: '2.0',
                id: message.id,
                result: { protocolVersion: 42, capabilities: 'invalid', serverInfo: null }
            })
        );
    }

    async close(): Promise<void> {
        this.onclose?.();
    }
}

verifies('typescript:consumer:connect-validation-error', async (_: TestArgs) => {
    const client = newClient();

    const err: unknown = await client.connect(new MalformedInitializeTransport()).then(
        () => undefined,
        (e: unknown) => e
    );

    // The raw validator error from the malformed initialize result crosses connect() unwrapped.
    expect(err).toBeDefined();
    expect(err).toBeInstanceOf($ZodError);
    expect(err).not.toBeInstanceOf(McpError);
    expect(issueCodes(err).length).toBeGreaterThan(0);
    // connect() failed cleanly: the transport was closed and detached.
    expect(client.transport).toBeUndefined();
});
