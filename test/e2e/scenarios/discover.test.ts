/**
 * Self-contained test bodies for the server side of `server/discover`
 * (draft-spec discovery): the built-in handler's response contents, its
 * availability before any initialize handshake, and the withholding of
 * subscription-delivery capability flags while `subscriptions/listen` is
 * unimplemented.
 *
 * The streamableHttp cells drive raw Request/Response against WebStandard
 * transports connected directly on the stateless dispatch path; the stdio
 * cells drive hand-built newline-framed messages against an in-process
 * {@link StdioServerTransport}; the inMemory cells drive the raw linked
 * transport pair on the stateful-era path (no envelope), where discovery
 * must be answered before the handshake.
 */

import { PassThrough } from 'node:stream';

import type { JSONRPCMessage, JSONRPCRequest, Transport } from '@modelcontextprotocol/server';
import {
    DRAFT_PROTOCOL_VERSION,
    InMemoryTransport,
    LATEST_PROTOCOL_VERSION,
    McpServer,
    ReadBuffer,
    serializeMessage,
    Server,
    SUPPORTED_PROTOCOL_VERSIONS,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { expect, vi } from 'vitest';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/** The slice of Server/McpServer the raw wires need. */
interface ConnectableServer {
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
}

const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
};

const draftHeaders = { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION };

/** The complete per-request `_meta` envelope the draft protocol revision requires. */
const envelope = (overrides?: Record<string, unknown>) => ({
    'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'discover-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
    ...overrides
});

/**
 * Connects the given server to a session-less WebStandard transport.
 * JSON responses are enabled so the stateful-era contrast probes (which would
 * default to SSE shaping) parse as plain bodies; the stateless dispatch path
 * shapes by behavior, not by this option.
 */
async function connectHttp(server: ConnectableServer): Promise<WebStandardStreamableHTTPServerTransport> {
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(tx);
    return tx;
}

const post = (tx: WebStandardStreamableHTTPServerTransport, body: unknown, headers: Record<string, string> = draftHeaders) =>
    tx.handleRequest(new Request('http://in-process/mcp', { method: 'POST', headers, body: JSON.stringify(body) }));

interface RawWire {
    send: (message: JSONRPCMessage) => void;
    next: () => Promise<JSONRPCMessage>;
    close: () => Promise<void>;
}

/**
 * In-process stdio wiring: the given server connected to a StdioServerTransport
 * over PassThrough pipes; messages are hand-built and framed exactly as on the
 * real wire (the SDK's serializeMessage/ReadBuffer framing).
 */
async function connectStdio(server: ConnectableServer): Promise<RawWire> {
    const input = new PassThrough();
    const output = new PassThrough();
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

/** Raw driving of the client half of a linked in-memory transport pair. */
async function connectInMemory(server: ConnectableServer): Promise<RawWire> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTx);

    const received: JSONRPCMessage[] = [];
    clientTx.onmessage = message => void received.push(message);
    await clientTx.start();

    let read = 0;
    return {
        send: message => void clientTx.send(message),
        next: async () =>
            await vi.waitFor(() => {
                if (received.length <= read) throw new Error('no message yet');
                return received[read++]!;
            }),
        close: () => server.close()
    };
}

/** Asserts the message is a result response echoing the request id and returns its result. */
function expectResult(message: unknown, id: number): Record<string, unknown> {
    expect(message).toMatchObject({ jsonrpc: '2.0', id });
    const result = (message as { result?: unknown }).result;
    if (result === undefined) {
        throw new Error(`Expected a result response, got: ${JSON.stringify(message)}`);
    }
    return result as Record<string, unknown>;
}

verifies('discover:result', async ({ transport }: TestArgs) => {
    // A strict subset of the SDK default plus the draft opt-in, so the response
    // provably reflects the configuration rather than the built-in default.
    const CONFIGURED_VERSIONS = [LATEST_PROTOCOL_VERSION, DRAFT_PROTOCOL_VERSION];
    const SERVER_INFO = { name: 'discover-result-server', version: '3.2.1' };
    const CAPABILITIES = { logging: {}, completions: {} };
    const INSTRUCTIONS = 'Discovery scenario server instructions.';
    const makeServer = () =>
        new Server(SERVER_INFO, {
            capabilities: CAPABILITIES,
            instructions: INSTRUCTIONS,
            supportedProtocolVersions: CONFIGURED_VERSIONS
        });

    const discoverRequest: JSONRPCRequest = { jsonrpc: '2.0', id: 201, method: 'server/discover', params: { _meta: envelope() } };
    // The same probe claiming an unknown version: the -32004 error's
    // data.supported must be the very list discover advertises.
    const unsupportedRequest: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: 301,
        method: 'server/discover',
        params: { _meta: envelope({ 'io.modelcontextprotocol/protocolVersion': 'v999.0.0' }) }
    };

    const assertDiscoverResult = (result: Record<string, unknown>) => {
        expect(result['supportedVersions']).toEqual(CONFIGURED_VERSIONS);
        expect(result['capabilities']).toEqual(CAPABILITIES);
        expect(result['serverInfo']).toEqual(SERVER_INFO);
        expect(result['instructions']).toBe(INSTRUCTIONS);
    };
    const expectedVersionError = {
        jsonrpc: '2.0',
        id: 301,
        error: { code: -32_004, data: { supported: CONFIGURED_VERSIONS, requested: 'v999.0.0' } }
    };

    if (transport === 'stdio') {
        const stdio = await connectStdio(makeServer());
        try {
            stdio.send(discoverRequest);
            assertDiscoverResult(expectResult(await stdio.next(), 201));
            stdio.send(unsupportedRequest);
            expect(await stdio.next()).toMatchObject(expectedVersionError);
        } finally {
            await stdio.close();
        }
        return;
    }

    const tx = await connectHttp(makeServer());
    try {
        const res = await post(tx, discoverRequest);
        expect(res.status).toBe(200);
        assertDiscoverResult(expectResult(await res.json(), 201));

        // Header and _meta agree on the unknown version (a disagreement would be -32001).
        const errorRes = await post(tx, unsupportedRequest, { ...baseHeaders, 'mcp-protocol-version': 'v999.0.0' });
        expect(errorRes.status).toBe(400);
        expect(await errorRes.json()).toMatchObject(expectedVersionError);
    } finally {
        await tx.close();
    }
});

verifies('discover:pre-initialize', async ({ transport }: TestArgs) => {
    // Default configuration: no draft opt-in, so the probe is served on the
    // stateful-era path — before any initialize handshake, like ping.
    const makeServer = () => new McpServer({ name: 'discover-preinit-server', version: '0.0.1' });
    // The pre-envelope probe form: no params at all.
    const probe: JSONRPCRequest = { jsonrpc: '2.0', id: 1, method: 'server/discover' };

    const wire = transport === 'stdio' ? await connectStdio(makeServer()) : await connectInMemory(makeServer());
    try {
        wire.send(probe);
        const result = expectResult(await wire.next(), 1);
        expect(result['supportedVersions']).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
        expect(result['capabilities']).toEqual({});
        expect(result['serverInfo']).toEqual({ name: 'discover-preinit-server', version: '0.0.1' });
        expect('instructions' in result).toBe(false);
    } finally {
        await wire.close();
    }
});

verifies('discover:subscription-capabilities-withheld', async ({ transport }: TestArgs) => {
    const DECLARED = {
        logging: {},
        prompts: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: true }
    };
    const makeServer = () =>
        new Server(
            { name: 'discover-flags-server', version: '1.0.0' },
            { capabilities: DECLARED, supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION] }
        );

    const discoverRequest: JSONRPCRequest = { jsonrpc: '2.0', id: 7, method: 'server/discover', params: { _meta: envelope() } };
    // The subscription-delivery flags are withheld; the capabilities themselves stay advertised.
    const expectedDiscoverCapabilities = { logging: {}, prompts: {}, resources: {}, tools: {} };
    // Contrast on the same server: the initialize result still carries the
    // declared flags — the stateful-era notification flow delivers them.
    const initializeRequest: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: 8,
        method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
    };

    if (transport === 'stdio') {
        const stdio = await connectStdio(makeServer());
        try {
            stdio.send(discoverRequest);
            expect(expectResult(await stdio.next(), 7)['capabilities']).toEqual(expectedDiscoverCapabilities);
            stdio.send(initializeRequest);
            expect(expectResult(await stdio.next(), 8)['capabilities']).toEqual(DECLARED);
        } finally {
            await stdio.close();
        }
        return;
    }

    const tx = await connectHttp(makeServer());
    try {
        const res = await post(tx, discoverRequest);
        expect(res.status).toBe(200);
        expect(expectResult(await res.json(), 7)['capabilities']).toEqual(expectedDiscoverCapabilities);

        const initializeRes = await post(tx, initializeRequest, baseHeaders);
        expect(initializeRes.status).toBe(200);
        expect(expectResult(await initializeRes.json(), 8)['capabilities']).toEqual(DECLARED);
    } finally {
        await tx.close();
    }
});
