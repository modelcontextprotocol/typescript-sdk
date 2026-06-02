/**
 * Self-contained test bodies for the client side of the per-request protocol
 * era (SEP-2575 + SEP-2567): the discovery-based connect flow (no initialize
 * handshake), the `_meta` envelope + version header stamped on every request,
 * the -32004 version retry, the back-compat fallback to initialize against
 * servers that do not speak a per-request version, and the opt-in boundary.
 *
 * Connect-time traffic is observed with {@link tapConnect} (attached before
 * `wire()`); the HTTP stamping cells hand-wire a header-recording fetch around
 * the hosting helpers so the `MCP-Protocol-Version` header obligation is
 * asserted alongside the body envelope.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
    DRAFT_PROTOCOL_VERSION,
    isJSONRPCNotification,
    isJSONRPCRequest,
    LATEST_PROTOCOL_VERSION,
    McpServer,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import type { ConnectTapEntry } from '../helpers/index.js';
import { hostPerSession, hostStateless, protocolVersionsFor, tapConnect, wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

/** The client→server requests recorded by {@link tapConnect}, in wire order. */
function sentRequests(log: ConnectTapEntry[]) {
    return log
        .filter(entry => entry.direction === 'client-to-server')
        .map(entry => entry.message)
        .filter(message => isJSONRPCRequest(message));
}

/** A server opted in to the given versions, with a tool reporting the ctx protocol version. */
function makeVersionReportingServer(supportedProtocolVersions: string[], instructions?: string): McpServer {
    const s = new McpServer({ name: 'dual-era-server', version: '3.1.4' }, { supportedProtocolVersions, instructions });
    s.registerTool('report-version', { inputSchema: z.object({}) }, (_args, ctx) => ({
        content: [{ type: 'text', text: ctx.mcpReq.protocolVersion }]
    }));
    return s;
}

verifies('lifecycle:connect:per-request-era', async ({ transport }: TestArgs) => {
    const versions = protocolVersionsFor('2026-07-28');
    const INSTRUCTIONS = 'Per-request era server instructions.';
    const client = new Client({ name: 'dual-era-client', version: '0.0.1' }, { supportedProtocolVersions: versions });
    const log = tapConnect(client);

    await using _ = await wire(transport, () => makeVersionReportingServer(versions, INSTRUCTIONS), client);

    // Discovery negotiated the connection: no initialize handshake anywhere on the wire.
    const methods = sentRequests(log).map(request => request.method);
    expect(methods).toContain('server/discover');
    expect(methods).not.toContain('initialize');
    expect(
        log.some(
            entry =>
                isJSONRPCNotification(entry.message) &&
                (entry.message as JSONRPCMessage & { method: string }).method === 'notifications/initialized'
        )
    ).toBe(false);

    // The server facts come from the discover result.
    expect(client.getNegotiatedProtocolVersion()).toBe(DRAFT_PROTOCOL_VERSION);
    expect(client.getServerVersion()).toEqual({ name: 'dual-era-server', version: '3.1.4' });
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    // registerTool declares tools.listChanged, but discover withholds the subscription-delivery flags.
    expect(client.getServerCapabilities()).toEqual({ tools: {} });

    // Requests are served end-to-end, and the server reads the selected version from the request itself.
    const result = await client.callTool({ name: 'report-version', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: DRAFT_PROTOCOL_VERSION }]);
});

verifies('protocol:envelope:client-stamps-requests', async ({ transport }: TestArgs) => {
    const versions = protocolVersionsFor('2026-07-28');
    const client = new Client({ name: 'stamping-client', version: '2.7.1' }, { supportedProtocolVersions: versions });
    const expectEnvelope = (request: { method: string; params?: { _meta?: Record<string, unknown> } }) => {
        const meta = request.params?._meta;
        expect(meta?.[META_VERSION], request.method).toBe(DRAFT_PROTOCOL_VERSION);
        expect(meta?.[META_CLIENT_INFO], request.method).toEqual({ name: 'stamping-client', version: '2.7.1' });
        expect(meta?.[META_CAPABILITIES], request.method).toEqual({});
    };

    if (transport === 'stdio') {
        const log = tapConnect(client);
        await using _ = await wire(transport, () => makeVersionReportingServer(versions), client);

        // Caller-supplied _meta keys survive alongside the envelope.
        await client.callTool({ name: 'report-version', arguments: {}, _meta: { 'com.example/custom': 'kept' } });

        const requests = sentRequests(log);
        expect(requests.length).toBeGreaterThanOrEqual(2); // the probe + the tool call
        for (const request of requests) expectEnvelope(request as Parameters<typeof expectEnvelope>[0]);
        const toolCall = requests.find(request => request.method === 'tools/call');
        expect(toolCall?.params?._meta?.['com.example/custom']).toBe('kept');
        return;
    }

    // HTTP cells: hand-wired hosting with a recording fetch, so the MCP-Protocol-Version
    // header on every POST is observable next to the body it accompanies.
    const handle =
        transport === 'streamableHttpStateless'
            ? hostStateless(() => makeVersionReportingServer(versions))
            : hostPerSession(() => makeVersionReportingServer(versions));
    const recorded: Array<{ headerVersion: string | null; body: JSONRPCMessage }> = [];
    const fetchFn = async (url: URL | string, init?: RequestInit) => {
        const request = new Request(url, init);
        recorded.push({
            headerVersion: request.headers.get('mcp-protocol-version'),
            body: JSON.parse(await request.clone().text()) as JSONRPCMessage
        });
        return handle.handleRequest(request);
    };

    const tx = new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch: fetchFn });
    try {
        await client.connect(tx);
        await client.callTool({ name: 'report-version', arguments: {}, _meta: { 'com.example/custom': 'kept' } });

        const requests = recorded.filter(({ body }) => isJSONRPCRequest(body));
        expect(requests.length).toBeGreaterThanOrEqual(2); // the probe + the tool call
        for (const { headerVersion, body } of requests) {
            const request = body as { method: string; params?: { _meta?: Record<string, unknown> } };
            expectEnvelope(request);
            // Every POST carries the header, and it matches the _meta claim.
            expect(headerVersion, request.method).toBe(DRAFT_PROTOCOL_VERSION);
        }
        const toolCall = requests.find(({ body }) => (body as { method?: string }).method === 'tools/call');
        expect((toolCall?.body as { params?: { _meta?: Record<string, unknown> } }).params?._meta?.['com.example/custom']).toBe('kept');
    } finally {
        await client.close();
        await handle.close();
    }
});

verifies('lifecycle:connect:per-request-version-retry', async ({ transport }: TestArgs) => {
    // The server supports a different per-request revision than the client's first choice;
    // the client's second listed revision is the mutual one.
    const RETRY_VERSION = '2026-e2e-retry';
    const serverVersions = [...SUPPORTED_PROTOCOL_VERSIONS, RETRY_VERSION];
    const client = new Client(
        { name: 'retry-client', version: '0.0.1' },
        { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION, RETRY_VERSION] }
    );
    const log = tapConnect(client);

    await using _ = await wire(transport, () => makeVersionReportingServer(serverVersions), client);

    // Exactly one retry: two probes on the wire, first claiming the preferred version,
    // the second the mutually supported one from error.data.supported. Never initialize.
    const requests = sentRequests(log);
    const probes = requests.filter(request => request.method === 'server/discover');
    expect(probes).toHaveLength(2);
    expect(probes[0]!.params?._meta?.[META_VERSION]).toBe(DRAFT_PROTOCOL_VERSION);
    expect(probes[1]!.params?._meta?.[META_VERSION]).toBe(RETRY_VERSION);
    expect(requests.map(request => request.method)).not.toContain('initialize');

    expect(client.getNegotiatedProtocolVersion()).toBe(RETRY_VERSION);

    // Subsequent requests claim the retried version, end to end.
    const result = await client.callTool({ name: 'report-version', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: RETRY_VERSION }]);
    const toolCall = sentRequests(log).find(request => request.method === 'tools/call');
    expect(toolCall?.params?._meta?.[META_VERSION]).toBe(RETRY_VERSION);
});

verifies('lifecycle:connect:per-request-era-fallback', async ({ transport }: TestArgs) => {
    // A legacy-shaped server: stateful versions only, and no server/discover handler at all.
    // Depending on the transport the probe dies differently (-32601 from dispatch on
    // stdio/inMemory/sse; HTTP 400 from session or header validation on streamable HTTP),
    // and the client must fall back to initialize in every case.
    const makeServer = () => {
        const s = new McpServer({ name: 'legacy-server', version: '0.0.9' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        s.server.removeRequestHandler('server/discover');
        return s;
    };
    const client = new Client(
        { name: 'fallback-client', version: '0.0.1' },
        { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS] }
    );
    const log = tapConnect(client);

    await using _ = await wire(transport, makeServer, client);

    // The probe went out first; the handshake followed and completed on the newest stateful version.
    const methods = sentRequests(log).map(request => request.method);
    expect(methods.indexOf('server/discover')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('initialize')).toBeGreaterThan(methods.indexOf('server/discover'));
    expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
    expect(client.getServerVersion()).toEqual({ name: 'legacy-server', version: '0.0.9' });

    // The fallback connection is a plain 2025-era connection: no envelope on its requests.
    const result = await client.callTool({ name: 'echo', arguments: { text: 'after fallback' } });
    expect(result.content).toEqual([{ type: 'text', text: 'after fallback' }]);
    const toolCall = sentRequests(log).find(request => request.method === 'tools/call');
    expect(toolCall?.params?._meta?.[META_VERSION]).toBeUndefined();
    expect(toolCall?.params?._meta?.[META_CLIENT_INFO]).toBeUndefined();
    expect(toolCall?.params?._meta?.[META_CAPABILITIES]).toBeUndefined();
});

verifies('lifecycle:connect:discover-requires-opt-in', async ({ transport }: TestArgs) => {
    // The server lists the draft revision; the client does not. No probe may appear:
    // the opt-in is the client's own version list, not the server's capabilities.
    const makeServer = () =>
        new McpServer(
            { name: 'opted-in-server', version: '0.0.1' },
            { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION] }
        );
    const client = new Client({ name: 'default-client', version: '0.0.1' });
    const log = tapConnect(client);

    await using _ = await wire(transport, makeServer, client);

    const methods = sentRequests(log).map(request => request.method);
    expect(methods).not.toContain('server/discover');
    expect(methods[0]).toBe('initialize');
    expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
});
