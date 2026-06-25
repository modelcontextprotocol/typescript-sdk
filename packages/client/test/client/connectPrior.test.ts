/**
 * `connect({ prior: DiscoverResult })` — zero-round-trip reconnect for the
 * gateway / distributed-client pattern (issue #79). A previously-obtained
 * `DiscoverResult` adopted directly: on a modern overlap nothing reaches the
 * wire during connect; no modern overlap throws `EraNegotiationFailed` (no
 * legacy fallback). Populates `getDiscoverResult()` (alongside the
 * `'auto'`-mode probe path) and round-trips through JSON.
 */
import type { DiscoverResult, JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
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
    setProtocolVersionCalls: string[] = [];

    constructor(private readonly script: (message: JSONRPCMessage, transport: ScriptedTransport) => void = () => {}) {}

    async start(): Promise<void> {}
    async close(): Promise<void> {
        this.onclose?.();
    }
    async send(message: JSONRPCMessage): Promise<void> {
        this.sent.push(message);
        queueMicrotask(() => this.script(message, this));
    }
    setProtocolVersion(version: string): void {
        this.setProtocolVersionCalls.push(version);
    }
    reply(message: JSONRPCMessage): void {
        this.onmessage?.(message);
    }
}

const prior = (supportedVersions: string[]): DiscoverResult => ({
    supportedVersions,
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'persisted-server', version: '1.0.0' },
    instructions: 'persisted instructions'
});

describe('connect({ prior }) — modern overlap: zero round trips', () => {
    test('nothing reaches the wire during connect; era state is the post-probe state', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });

        await client.connect(transport, { prior: prior([MODERN]) });

        // ZERO requests sent during connect.
        expect(transport.sent).toHaveLength(0);
        // The transport's protocol-version slot is stamped exactly once.
        expect(transport.setProtocolVersionCalls).toEqual([MODERN]);
        // Adopted directly from prior.
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect(client.getProtocolEra()).toBe('modern');
        expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
        expect(client.getServerVersion()).toEqual({ name: 'persisted-server', version: '1.0.0' });
        expect(client.getInstructions()).toBe('persisted instructions');
        expect(client.getDiscoverResult()).toEqual(prior([MODERN]));

        await client.close();
    });

    test('callTool works immediately after a zero-round-trip connect', async () => {
        const transport = new ScriptedTransport((message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'tools/call') {
                t.reply({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] }
                });
            }
        });
        const client = new Client({ name: 'worker', version: '0' });
        await client.connect(transport, { prior: prior([MODERN]) });

        // First wire traffic is the tools/call itself.
        expect(transport.sent).toHaveLength(0);
        const result = await client.callTool({ name: 'echo' });
        expect(result.content?.[0]).toEqual({ type: 'text', text: 'ok' });
        const reqs = transport.sent.filter(isJSONRPCRequest);
        expect(reqs).toHaveLength(1);
        expect(reqs[0]!.method).toBe('tools/call');

        await client.close();
    });

    test('prior bypasses versionNegotiation resolution (no probe even with mode: auto)', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport, { prior: prior([MODERN]) });
        expect(transport.sent).toHaveLength(0);
        await client.close();
    });
});

describe('connect({ prior }) — no modern overlap: throws (no legacy fallback)', () => {
    test('legacy-only prior → SdkError(EraNegotiationFailed) steering to mode: auto', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });
        await expect(client.connect(transport, { prior: prior(['2025-06-18']) })).rejects.toSatisfy(
            error =>
                error instanceof SdkError &&
                error.code === SdkErrorCode.EraNegotiationFailed &&
                /2026-07-28\+ mutual/.test(error.message) &&
                /mode: 'auto'/.test(error.message)
        );
        // Nothing reached the transport (the throw is before super.connect()).
        expect(transport.sent).toHaveLength(0);
        expect(client.getDiscoverResult()).toBeUndefined();
    });

    test('disjoint modern lists → SdkError(EraNegotiationFailed)', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });
        await expect(client.connect(transport, { prior: prior(['2099-01-01']) })).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
        );
        expect(transport.sent).toHaveLength(0);
    });
});

describe('getDiscoverResult() round-trip', () => {
    test("'auto'-mode probe populates it; JSON.stringify/parse round-trips into connect({ prior })", async () => {
        // Bootstrap: a real probe against a scripted modern server.
        const bootstrapTransport = new ScriptedTransport((message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.reply({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        supportedVersions: [MODERN],
                        capabilities: { tools: {} },
                        serverInfo: { name: 'probed-server', version: '2.0.0' }
                    }
                });
            }
        });
        const bootstrap = new Client({ name: 'bootstrap', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await bootstrap.connect(bootstrapTransport);
        const probed = bootstrap.getDiscoverResult();
        expect(probed?.serverInfo).toEqual({ name: 'probed-server', version: '2.0.0' });
        expect(probed?.supportedVersions).toEqual([MODERN]);
        await bootstrap.close();
        // close() clears per-connection state.
        expect(bootstrap.getDiscoverResult()).toBeUndefined();

        // Persist + revive (the gateway pattern's "write to Redis/config" step).
        const persisted = JSON.stringify(probed);
        const revived = JSON.parse(persisted) as DiscoverResult;

        // Worker: zero-round-trip connect from the revived blob.
        const workerTransport = new ScriptedTransport();
        const worker = new Client({ name: 'worker', version: '0' });
        await worker.connect(workerTransport, { prior: revived });
        expect(workerTransport.sent).toHaveLength(0);
        expect(worker.getServerVersion()).toEqual({ name: 'probed-server', version: '2.0.0' });
        expect(worker.getDiscoverResult()).toEqual(revived);
        await worker.close();
    });

    test('discover() populates it on an already-connected modern client', async () => {
        const transport = new ScriptedTransport((message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.reply({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        resultType: 'complete',
                        ttlMs: 0,
                        cacheScope: 'public',
                        supportedVersions: [MODERN],
                        capabilities: { tools: {} },
                        serverInfo: { name: 'rediscovered', version: '3.0.0' }
                    }
                });
            }
        });
        const client = new Client({ name: 'c', version: '0' });
        await client.connect(transport, { prior: prior([MODERN]) });
        expect(client.getDiscoverResult()?.serverInfo.name).toBe('persisted-server');
        const fresh = await client.discover();
        expect(fresh.serverInfo.name).toBe('rediscovered');
        expect(client.getDiscoverResult()?.serverInfo.name).toBe('rediscovered');
        await client.close();
    });
});
