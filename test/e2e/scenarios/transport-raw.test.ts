/**
 * Raw transport relay tests: drive client and server transports directly via the
 * Transport interface (start/send/onmessage/onerror/onclose) without wrapping them
 * in a Client or Server — the pattern message-relay proxies depend on.
 *
 * One verifies() body dispatches on the matrix transport arg:
 *   - inMemory: both ends of InMemoryTransport.createLinkedPair driven by hand
 *   - stdio: StdioClientTransport spawning the stdio fixture server as a child process
 *   - streamableHttp / streamableHttpStateless: StreamableHTTPClientTransport against
 *     the in-process hostPerSession()/hostStateless() hosts
 *
 * Every JSON-RPC message is hand-built and every response is observed through the
 * transport's own onmessage callback, exactly as a relay would forward traffic.
 */

import { fileURLToPath } from 'node:url';

import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { StdioClientTransport } from '../../../src/client/stdio.js';
import { StreamableHTTPClientTransport } from '../../../src/client/streamableHttp.js';
import { InMemoryTransport } from '../../../src/inMemory.js';
import { McpServer } from '../../../src/server/mcp.js';
import {
    CallToolResultSchema,
    InitializeResultSchema,
    type JSONRPCMessage,
    type JSONRPCNotification,
    type JSONRPCRequest,
    JSONRPCResultResponseSchema
} from '../../../src/types.js';

import { hostPerSession, hostStateless } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

/** Absolute path to the runnable stdio fixture server (executed with tsx). */
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/stdio-server.ts', import.meta.url));

/** Repo root — spawn cwd so the workspace-local `tsx` resolves. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Hand-built initialize request a relay would forward verbatim (no Client involved). */
function initializeRequest(id: number, protocolVersion: string): JSONRPCRequest {
    return {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-relay-client', version: '0' } }
    };
}

const INITIALIZED_NOTIFICATION: JSONRPCNotification = { jsonrpc: '2.0', method: 'notifications/initialized' };

/** Hand-built tools/call request for the echo tool exposed by both real servers used below. */
function echoCallRequest(id: number): JSONRPCRequest {
    return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo', arguments: { text: 'relayed raw' } } };
}

function echoServer(): McpServer {
    const s = new McpServer({ name: 'raw-relay-http-server', version: '0' });
    s.registerTool('echo', { description: 'Echo tool', inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return s;
}

/** Asserts the message observed via onmessage is the initialize response for `id` with the negotiated version. */
function expectInitializeResponse(message: JSONRPCMessage, id: number, protocolVersion: string, serverName: string): void {
    const response = JSONRPCResultResponseSchema.parse(message);
    expect(response.id).toBe(id);
    const result = InitializeResultSchema.parse(response.result);
    expect(result.protocolVersion).toBe(protocolVersion);
    expect(result.serverInfo.name).toBe(serverName);
}

/** Asserts the message observed via onmessage is the tools/call response for `id` carrying the echoed text. */
function expectEchoResponse(message: JSONRPCMessage, id: number): void {
    const response = JSONRPCResultResponseSchema.parse(message);
    expect(response.id).toBe(id);
    const result = CallToolResultSchema.parse(response.result);
    expect(result.content).toEqual([{ type: 'text', text: 'relayed raw' }]);
}

async function rawRelayInMemory(protocolVersion: string): Promise<void> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const clientReceived: JSONRPCMessage[] = [];
    const serverReceived: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    let clientClosed = false;
    let serverClosed = false;

    const initializeResult = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: { protocolVersion, capabilities: {}, serverInfo: { name: 'raw-relay-inmemory-server', version: '0' } }
    };

    try {
        // The server-side transport is driven directly too: relay the hand-built result back without a Server.
        await serverTx.start();
        serverTx.onmessage = message => {
            serverReceived.push(message);
            void serverTx.send(initializeResult);
        };
        serverTx.onerror = error => void errors.push(error);
        serverTx.onclose = () => {
            serverClosed = true;
        };

        await clientTx.start();
        clientTx.onmessage = message => void clientReceived.push(message);
        clientTx.onerror = error => void errors.push(error);
        clientTx.onclose = () => {
            clientClosed = true;
        };

        const request = initializeRequest(1, protocolVersion);
        await clientTx.send(request);

        // The raw request and hand-built response crossed the pair verbatim — nothing rewrote them.
        expect(serverReceived).toEqual([request]);
        await vi.waitFor(() => expect(clientReceived).toHaveLength(1));
        expect(clientReceived).toEqual([initializeResult]);
        expectInitializeResponse(clientReceived[0], 1, protocolVersion, 'raw-relay-inmemory-server');

        expect(errors).toEqual([]);
        expect(clientClosed).toBe(false);
        expect(serverClosed).toBe(false);

        await clientTx.close();
        expect(clientClosed).toBe(true);
        expect(serverClosed).toBe(true);
    } finally {
        await clientTx.close();
        await serverTx.close();
    }
}

async function rawRelayStdio(protocolVersion: string): Promise<void> {
    // Direct spawn (node --import tsx) so the spawned process IS the fixture server, as in the other stdio scenarios.
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', FIXTURE_PATH], cwd: REPO_ROOT });
    const received: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    let closed = false;

    try {
        await transport.start();
        transport.onmessage = message => void received.push(message);
        transport.onerror = error => void errors.push(error);
        transport.onclose = () => {
            closed = true;
        };

        await transport.send(initializeRequest(1, protocolVersion));
        // Generous first wait: tsx compiles the fixture inside the freshly spawned child before it can answer.
        await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000, interval: 25 });
        expectInitializeResponse(received[0], 1, protocolVersion, 'stdio-echo-server');

        // Forward the rest of a relay's traffic by hand: initialized notification, then a tools/call.
        await transport.send(INITIALIZED_NOTIFICATION);
        await transport.send(echoCallRequest(2));
        await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000, interval: 25 });
        expectEchoResponse(received[1], 2);

        expect(errors).toEqual([]);
        expect(closed).toBe(false);
        await transport.close();
        // close() ends the child's stdin; the resulting process exit must surface via onclose.
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000, interval: 25 });
    } finally {
        await transport.close();
    }
}

async function rawRelayStreamableHttp(protocolVersion: string, stateless: boolean): Promise<void> {
    const handle = stateless ? hostStateless(echoServer) : hostPerSession(echoServer);
    const records: Array<{ method: string }> = [];
    const received: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    let closed = false;

    const transport = new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), {
        fetch: (url, init) => {
            const request = new Request(url, init);
            records.push({ method: request.method });
            return handle.handleRequest(request);
        }
    });

    try {
        await transport.start();
        // start() must not touch the network — the first HTTP request may only happen on send().
        expect(records).toEqual([]);

        transport.onmessage = message => void received.push(message);
        transport.onerror = error => void errors.push(error);
        transport.onclose = () => {
            closed = true;
        };

        await transport.send(initializeRequest(1, protocolVersion));
        expect(records).toHaveLength(1);
        expect(records[0].method).toBe('POST');

        await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000, interval: 10 });
        expectInitializeResponse(received[0], 1, protocolVersion, 'raw-relay-http-server');

        // Forward the rest of a relay's traffic by hand: initialized notification, then a tools/call.
        await transport.send(INITIALIZED_NOTIFICATION);
        await transport.send(echoCallRequest(2));
        await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000, interval: 10 });
        expectEchoResponse(received[1], 2);

        // Every POST on the wire came from an explicit send(); the only other traffic is the optional standalone GET.
        expect(records.filter(r => r.method === 'POST')).toHaveLength(3);
        expect(records.filter(r => r.method !== 'POST' && r.method !== 'GET')).toEqual([]);

        expect(errors).toEqual([]);
        expect(closed).toBe(false);
        await transport.close();
        expect(closed).toBe(true);
    } finally {
        await transport.close();
        await handle.close();
    }
}

verifies('transport:standalone:raw-relay', async ({ transport, protocolVersion }: TestArgs) => {
    if (transport === 'inMemory') {
        await rawRelayInMemory(protocolVersion);
    } else if (transport === 'stdio') {
        await rawRelayStdio(protocolVersion);
    } else {
        await rawRelayStreamableHttp(protocolVersion, transport === 'streamableHttpStateless');
    }
});
