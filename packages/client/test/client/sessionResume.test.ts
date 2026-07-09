/**
 * Session resumption across a client close(): reconnecting with a transport
 * that carries a sessionId (and the protocol version persisted alongside it)
 * must push that version onto the transport so HTTP requests carry the
 * required mcp-protocol-version header.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { isJSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { Client } from '../../src/client/client';

const LEGACY = '2025-11-25';

/**
 * A sessionful legacy server transport: answers initialize like a 2025
 * server and assigns a session id with the initialize response, mirroring
 * Streamable HTTP's mcp-session-id assignment.
 */
class SessionfulTransport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    sessionId?: string;
    protocolVersion?: string;

    sent: JSONRPCMessage[] = [];
    setProtocolVersionCalls: string[] = [];

    constructor(carried?: { sessionId: string; protocolVersion: string }) {
        this.sessionId = carried?.sessionId;
        this.protocolVersion = carried?.protocolVersion;
    }

    async start(): Promise<void> {}

    async send(message: JSONRPCMessage): Promise<void> {
        this.sent.push(message);
        if (isJSONRPCRequest(message) && message.method === 'initialize') {
            this.sessionId = 'session-123';
            const reply: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    protocolVersion: LEGACY,
                    capabilities: {},
                    serverInfo: { name: 'sessionful-legacy-server', version: '1.0.0' }
                }
            };
            queueMicrotask(() => this.onmessage?.(reply));
        }
    }

    async close(): Promise<void> {
        this.onclose?.();
    }

    setProtocolVersion(version: string): void {
        this.setProtocolVersionCalls.push(version);
        this.protocolVersion = version;
    }
}

describe('r4: session resume after close()', () => {
    // The resume branch seeds the new connection from the session-resumption
    // record or, after close() cleared it, from the version the resuming
    // transport itself carries — so setProtocolVersion is pushed either way.
    // (It used to read the negotiated version, which close() had reset, and
    // silently skip the push: the resumed session's HTTP requests went out
    // without the required mcp-protocol-version header.)
    test('reconnecting after close() with a carried sessionId + protocolVersion pushes the version onto the new transport', async () => {
        const client = new Client({ name: 'resume-client', version: '1.0.0' });
        const first = new SessionfulTransport();

        await client.connect(first);
        expect(first.setProtocolVersionCalls).toEqual([LEGACY]);
        expect(first.sessionId).toBe('session-123');

        await client.close();

        // The consumer persisted the session id and negotiated version (the
        // documented Streamable HTTP resumption flow) and reconnects with
        // both carried on the new transport.
        const resumed = new SessionfulTransport({ sessionId: 'session-123', protocolVersion: LEGACY });
        await client.connect(resumed);

        // No re-initialize on a resume...
        expect(resumed.sent.filter(m => isJSONRPCRequest(m) && m.method === 'initialize')).toHaveLength(0);
        // ...and the carried version is pushed to the transport.
        expect(resumed.setProtocolVersionCalls).toEqual([LEGACY]);

        await client.close();
    });

    test('resume on the same instance without close() re-pushes the negotiated version (pin)', async () => {
        const client = new Client({ name: 'resume-client', version: '1.0.0' });
        const first = new SessionfulTransport();

        await client.connect(first);
        // The transport drops (server side went away) — no client.close().
        await first.close();

        const resumed = new SessionfulTransport({ sessionId: 'session-123', protocolVersion: LEGACY });
        await client.connect(resumed);

        expect(resumed.sent.filter(m => isJSONRPCRequest(m) && m.method === 'initialize')).toHaveLength(0);
        expect(resumed.setProtocolVersionCalls).toEqual([LEGACY]);

        await client.close();
    });
});
