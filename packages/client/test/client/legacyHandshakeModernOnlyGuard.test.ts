/**
 * Plain-path guard for modern-only supported-versions lists: a Client
 * constructed WITHOUT versionNegotiation must never offer a 2026-era revision
 * through the legacy `initialize` handshake. With no 2025-era entry to offer,
 * connect() rejects with the typed negotiation error before anything reaches
 * the wire — independently of the same guard on the auto-negotiation path.
 */
import type { JSONRPCMessage, MessageExtraInfo, Transport } from '@modelcontextprotocol/core-internal';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { Client } from '../../src/client/client.js';

function recordingTransport(): Transport & { sent: JSONRPCMessage[] } {
    const sent: JSONRPCMessage[] = [];
    return {
        sent,
        async start() {
            // nothing to start
        },
        async send(message: JSONRPCMessage) {
            sent.push(message);
        },
        async close() {
            // nothing to close
        },
        onclose: undefined,
        onerror: undefined,
        onmessage: undefined as ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined
    };
}

describe('plain client with a modern-only supported-versions list', () => {
    test.each([
        { label: "['2026-07-28']", supportedProtocolVersions: ['2026-07-28'] },
        { label: '[] (empty list)', supportedProtocolVersions: [] as string[] }
    ])('connect() rejects with the typed negotiation error and never sends initialize — $label', async ({ supportedProtocolVersions }) => {
        const transport = recordingTransport();
        const client = new Client({ name: 'modern-only-client', version: '1.0.0' }, { supportedProtocolVersions });

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
        );

        expect(transport.sent.filter(message => 'method' in message && message.method === 'initialize')).toHaveLength(0);
    });
});
