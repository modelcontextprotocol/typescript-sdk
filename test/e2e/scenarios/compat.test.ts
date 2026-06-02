/**
 * Cross-era compatibility bodies (2025 initialize era ↔ 2026 per-request era):
 * mixed-era traffic interleaved on a single stdio pipe, the modern-only-client
 * hard failure (connect() never invents an initialize attempt), and
 * feature-result parity across the eras of one dual-stack server
 * configuration.
 */

import { PassThrough } from 'node:stream';

import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/server';
import {
    DRAFT_PROTOCOL_VERSION,
    InMemoryTransport,
    isJSONRPCRequest,
    LATEST_PROTOCOL_VERSION,
    McpServer,
    ReadBuffer,
    serializeMessage,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { hostPerSession, hostStateless, stdioClientOverPipes, tapConnect, wire } from '../helpers/index.js';
import { startLegacySseHost } from '../helpers/sse-host.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const DUAL_STACK = [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

/** A dual-stack server with an era-reporting tool plus text and structured tools for parity probes. */
function makeDualStackServer(): McpServer {
    const s = new McpServer({ name: 'compat-server', version: '1.0.0' }, { supportedProtocolVersions: DUAL_STACK });
    s.registerTool('era', { inputSchema: z.object({}) }, (_args, ctx) => ({
        content: [{ type: 'text', text: ctx.mcpReq.protocolVersion }]
    }));
    s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    s.registerTool(
        'add',
        { inputSchema: z.object({ a: z.number(), b: z.number() }), outputSchema: z.object({ sum: z.number() }) },
        ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }], structuredContent: { sum: a + b } })
    );
    return s;
}

verifies('lifecycle:compat:mixed-era-one-pipe', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = makeDualStackServer();
    await server.connect(new StdioServerTransport(input, output));

    const buf = new ReadBuffer();
    const received: JSONRPCMessage[] = [];
    output.on('data', chunk => {
        buf.append(chunk as Buffer);
        let message: JSONRPCMessage | null;
        while ((message = buf.readMessage())) received.push(message);
    });
    let read = 0;
    const send = (message: JSONRPCMessage) => void input.push(serializeMessage(message));
    const next = async () =>
        await vi.waitFor(() => {
            if (received.length <= read) throw new Error('no message yet');
            return received[read++]!;
        });

    const envelope = {
        [META_VERSION]: DRAFT_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientInfo': { name: 'mixed-era-client', version: '0' },
        'io.modelcontextprotocol/clientCapabilities': {}
    };
    const eraCall = (id: number, meta?: Record<string, unknown>): JSONRPCRequest => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: meta ? { name: 'era', arguments: {}, _meta: meta } : { name: 'era', arguments: {} }
    });

    try {
        // 1. A per-request request is served before any handshake exists on the pipe.
        send(eraCall(1, envelope));
        expect(await next()).toMatchObject({ id: 1, result: { content: [{ type: 'text', text: DRAFT_PROTOCOL_VERSION }] } });

        // 2. A legacy initialize handshake on the SAME pipe establishes a 2025-era session.
        send({
            jsonrpc: '2.0',
            id: 2,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'mixed-era-legacy-client', version: '0' }
            }
        });
        expect(await next()).toMatchObject({ id: 2, result: { protocolVersion: LATEST_PROTOCOL_VERSION } });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        // 3. An un-enveloped request rides that session and observes the initialize-era version.
        send(eraCall(3));
        expect(await next()).toMatchObject({ id: 3, result: { content: [{ type: 'text', text: LATEST_PROTOCOL_VERSION }] } });

        // 4. A further enveloped request is served per-request again — the session never bleeds in.
        send(eraCall(4, envelope));
        expect(await next()).toMatchObject({ id: 4, result: { content: [{ type: 'text', text: DRAFT_PROTOCOL_VERSION }] } });
    } finally {
        await server.close();
    }
});

verifies('lifecycle:compat:modern-only-client-hard-fail', async ({ transport }: TestArgs) => {
    // Two server shapes that share no per-request version: an SDK server with the default
    // (initialize-era) versions, whose built-in discovery answers with stateful versions only,
    // and a true legacy shape with no discovery handler at all (-32601 / pre-dispatch HTTP 400).
    for (const removeDiscover of [false, true]) {
        const makeServer = () => {
            const s = new McpServer({ name: 'initialize-era-server', version: '0' });
            s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
                content: [{ type: 'text', text }]
            }));
            if (removeDiscover) {
                s.server.removeRequestHandler('server/discover');
            }
            return s;
        };
        const client = new Client({ name: 'modern-only-client', version: '0' }, { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION] });
        const log = tapConnect(client);
        const expectHardFail = async (connecting: Promise<unknown>) =>
            await expect(connecting).rejects.toThrow(/No mutually supported protocol version|initialize cannot negotiate/);

        // Wired by hand rather than through wire(): connect() is expected to throw, and
        // wire() would leak its half-built host on the way out.
        switch (transport) {
            case 'inMemory': {
                const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
                const server = makeServer();
                await server.connect(serverTx);
                try {
                    await expectHardFail(client.connect(clientTx));
                } finally {
                    await server.close();
                }
                break;
            }
            case 'stdio': {
                const c2s = new PassThrough();
                const s2c = new PassThrough();
                const server = makeServer();
                await server.connect(new StdioServerTransport(c2s, s2c));
                try {
                    await expectHardFail(client.connect(stdioClientOverPipes(s2c, c2s)));
                } finally {
                    await server.close();
                }
                break;
            }
            case 'streamableHttp':
            case 'streamableHttpStateless': {
                const handle = transport === 'streamableHttpStateless' ? hostStateless(makeServer) : hostPerSession(makeServer);
                const fetchFn = (url: URL | string, init?: RequestInit) => handle.handleRequest(new Request(url, init));
                try {
                    await expectHardFail(
                        client.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch: fetchFn }))
                    );
                } finally {
                    await handle.close();
                }
                break;
            }
            case 'sse': {
                const host = await startLegacySseHost(makeServer);
                try {
                    await expectHardFail(client.connect(new SSEClientTransport(host.url)));
                } finally {
                    await host.close();
                }
                break;
            }
        }

        // The hard-fail invariant: no initialize attempt was invented on the way down.
        const methods = log
            .filter(entry => entry.direction === 'client-to-server')
            .map(entry => entry.message)
            .filter(message => isJSONRPCRequest(message))
            .map(request => request.method);
        expect(methods).not.toContain('initialize');
    }
});

verifies('lifecycle:compat:era-parity', async ({ transport }: TestArgs) => {
    const legacy = new Client({ name: 'era-2025-client', version: '0' });
    const modern = new Client({ name: 'era-2026-client', version: '0' }, { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION] });

    if (transport === 'stdio') {
        // Each client gets its own pipe from the shared factory (the one-pipe interleaving
        // is lifecycle:compat:mixed-era-one-pipe).
        const legacyHost = await wire('stdio', makeDualStackServer, legacy);
        const modernHost = await wire('stdio', makeDualStackServer, modern);
        try {
            await assertEraParity(legacy, modern, transport);
        } finally {
            await modernHost[Symbol.asyncDispose]();
            await legacyHost[Symbol.asyncDispose]();
        }
        return;
    }

    // One hosting deployment serves both eras: the initialize-era session and the
    // sessionless per-request POSTs go through the same handle.
    const handle = transport === 'streamableHttpStateless' ? hostStateless(makeDualStackServer) : hostPerSession(makeDualStackServer);
    const fetchFn = (url: URL | string, init?: RequestInit) => handle.handleRequest(new Request(url, init));
    try {
        await legacy.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch: fetchFn }));
        await modern.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch: fetchFn }));
        await assertEraParity(legacy, modern, transport);
    } finally {
        await legacy.close();
        await modern.close();
        await handle.close();
    }
});

/** Each connection negotiated its own era, and the feature results are era-invariant. */
async function assertEraParity(legacy: Client, modern: Client, transport: TestArgs['transport']): Promise<void> {
    expect(legacy.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
    expect(modern.getNegotiatedProtocolVersion()).toBe(DRAFT_PROTOCOL_VERSION);

    // The era is request-observable on the server. On 2025 stateless hosting the fresh
    // per-request instance has no handshake, so the legacy connection's handlers see the
    // SDK's pre-initialize default version — handshake-sourced ctx observability on that
    // hosting pattern is out of scope here (see protocol:envelope:ctx-version-readable).
    if (transport !== 'streamableHttpStateless') {
        const legacyEra = await legacy.callTool({ name: 'era', arguments: {} });
        expect(legacyEra.content).toEqual([{ type: 'text', text: LATEST_PROTOCOL_VERSION }]);
    }
    const modernEra = await modern.callTool({ name: 'era', arguments: {} });
    expect(modernEra.content).toEqual([{ type: 'text', text: DRAFT_PROTOCOL_VERSION }]);

    // …while list and call results are identical across eras.
    const [legacyList, modernList] = [await legacy.listTools(), await modern.listTools()];
    expect(modernList.tools).toEqual(legacyList.tools);

    const addArgs = { name: 'add', arguments: { a: 19, b: 23 } };
    const [legacyAdd, modernAdd] = [await legacy.callTool(addArgs), await modern.callTool(addArgs)];
    expect(modernAdd).toEqual(legacyAdd);
    expect(modernAdd.structuredContent).toEqual({ sum: 42 });

    const echoArgs = { name: 'echo', arguments: { text: 'parity' } };
    expect(await modern.callTool(echoArgs)).toEqual(await legacy.callTool(echoArgs));
}
