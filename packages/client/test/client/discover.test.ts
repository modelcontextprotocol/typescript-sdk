/**
 * Typed `Client.discover()`: issues `server/discover` through the typed
 * request funnel on a 2026-era connection; on a 2025-era connection the
 * method does not exist (it is absent from the legacy registry), so the
 * outbound era gate rejects it locally with a typed error before anything
 * reaches the transport.
 */
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import { isJSONRPCRequest, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { Client } from '../../src/client/client';

const MODERN = '2026-07-28';

class ScriptedTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    sessionId?: string;
    sent: JSONRPCMessage[] = [];

    constructor(private readonly script: (message: JSONRPCMessage, transport: ScriptedTransport) => void) {}

    async start(): Promise<void> {}
    async close(): Promise<void> {
        this.onclose?.();
    }
    async send(message: JSONRPCMessage): Promise<void> {
        this.sent.push(message);
        queueMicrotask(() => this.script(message, this));
    }
    setProtocolVersion(_version: string): void {}
    reply(message: JSONRPCMessage): void {
        this.onmessage?.(message);
    }
}

const discoverBody = {
    // A real 2026-era server stamps the resultType discriminator on the wire,
    // and the 2026 wire shape carries the cacheable-result fields.
    resultType: 'complete',
    ttlMs: 0,
    cacheScope: 'public',
    supportedVersions: [MODERN],
    capabilities: { tools: {} },
    serverInfo: { name: 'modern-server', version: '1.0.0' },
    instructions: 'modern instructions'
};

/** Answers server/discover (probe and typed request alike) like a modern server. */
const modernScript = (message: JSONRPCMessage, t: ScriptedTransport) => {
    if (!isJSONRPCRequest(message)) return;
    if (message.method === 'server/discover') {
        t.reply({ jsonrpc: '2.0', id: message.id, result: discoverBody });
    }
};

/** A plain 2025 server: answers initialize, -32601 for everything else. */
const legacyScript = (message: JSONRPCMessage, t: ScriptedTransport) => {
    if (!isJSONRPCRequest(message)) return;
    if (message.method === 'initialize') {
        t.reply({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'legacy-server', version: '1.0.0' } }
        });
    } else {
        t.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32_601, message: 'Method not found' } });
    }
};

describe('Client.discover()', () => {
    test('issues a typed server/discover request on a 2026-era connection', async () => {
        const transport = new ScriptedTransport(modernScript);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(transport);

        const advertisement = await client.discover();
        expect(advertisement.supportedVersions).toEqual([MODERN]);
        expect(advertisement.serverInfo).toEqual({ name: 'modern-server', version: '1.0.0' });
        expect(advertisement.instructions).toBe('modern instructions');

        await client.close();
    });

    test('absent ttlMs/cacheScope default to 0/private (spec receiver-side SHOULD — caching §TTL); not the resultType posture', async () => {
        // The 2026-07-28 spec marks ttlMs/cacheScope REQUIRED on the SENDER side
        // ("Servers MUST provide a ttlMs value that is >= 0") but tells receivers:
        // "If ttlMs is absent, clients SHOULD assume a default of 0". The SDK
        // applies the receiver-side SHOULD: a non-conformant server's discover
        // result is accepted with safe defaults, unlike a missing resultType
        // (ResultProtocolMismatch). The sender obligation is enforced by
        // the SDK server's encode step, not by parse here.
        const lenientScript = (message: JSONRPCMessage, t: ScriptedTransport) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.reply({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        // ttlMs, cacheScope and resultType deliberately omitted.
                        supportedVersions: [MODERN],
                        capabilities: { tools: {} },
                        serverInfo: { name: 'nonconformant-server', version: '1.0.0' }
                    }
                });
            }
        };
        const transport = new ScriptedTransport(lenientScript);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(transport);

        // The connect-time probe classifier parses with the wire schema, which
        // applies the spec receiver-side SHOULD defaults — so connect succeeds
        // and getDiscoverResult() reports the defaulted values.
        const advertisement = client.getDiscoverResult();
        expect(advertisement?.ttlMs).toBe(0);
        expect(advertisement?.cacheScope).toBe('private');

        await client.close();
    });

    test('is rejected locally with a typed error on a 2025-era connection (the method does not exist on that era)', async () => {
        const transport = new ScriptedTransport(legacyScript);
        const client = new Client({ name: 'c', version: '0' });
        await client.connect(transport);

        const sentBefore = transport.sent.length;
        await expect(client.discover()).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion
        );
        // Rejected locally: nothing new reached the transport.
        expect(transport.sent.length).toBe(sentBefore);

        await client.close();
    });
});
