/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/1468
 *
 * After MCP initialization completes over stdio, both the client transport and the server
 * transport should expose the negotiated protocol version via a `protocolVersion` getter.
 *
 * - `Client` already calls `transport.setProtocolVersion()` after the handshake, so
 *   `StdioClientTransport` merely needs to store and surface that value.
 * - `Server._oninitialize()` now calls `transport.setProtocolVersion?.()`, so
 *   `StdioServerTransport` is populated on the server side as well.
 */

import { Client } from '@modelcontextprotocol/client';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';

/** A thin wrapper around InMemoryTransport that records setProtocolVersion calls. */
function makeVersionRecordingTransport(inner: Transport): Transport & { recordedVersion: string | undefined } {
    let recordedVersion: string | undefined;
    return {
        get recordedVersion() {
            return recordedVersion;
        },
        get onclose() {
            return inner.onclose;
        },
        set onclose(v) {
            inner.onclose = v;
        },
        get onerror() {
            return inner.onerror;
        },
        set onerror(v) {
            inner.onerror = v;
        },
        get onmessage() {
            return inner.onmessage;
        },
        set onmessage(v) {
            inner.onmessage = v;
        },
        start: () => inner.start(),
        close: () => inner.close(),
        send: (msg: JSONRPCMessage) => inner.send(msg),
        setProtocolVersion(version: string) {
            recordedVersion = version;
        }
    };
}

describe('Issue #1468: stdio transports expose negotiated protocol version', () => {
    test('Server calls transport.setProtocolVersion() after initialization', async () => {
        const [rawClient, rawServer] = InMemoryTransport.createLinkedPair();

        const serverTransport = makeVersionRecordingTransport(rawServer);
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });
        const client = new Client({ name: 'test-client', version: '1.0.0' });

        expect(serverTransport.recordedVersion).toBeUndefined();

        await Promise.all([client.connect(rawClient), mcpServer.server.connect(serverTransport)]);

        expect(serverTransport.recordedVersion).toBe(LATEST_PROTOCOL_VERSION);
    });

    test('Client calls transport.setProtocolVersion() after initialization', async () => {
        const [rawClient, rawServer] = InMemoryTransport.createLinkedPair();

        const clientTransport = makeVersionRecordingTransport(rawClient);
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });
        const client = new Client({ name: 'test-client', version: '1.0.0' });

        expect(clientTransport.recordedVersion).toBeUndefined();

        await Promise.all([client.connect(clientTransport), mcpServer.server.connect(rawServer)]);

        expect(clientTransport.recordedVersion).toBe(LATEST_PROTOCOL_VERSION);
    });
});
