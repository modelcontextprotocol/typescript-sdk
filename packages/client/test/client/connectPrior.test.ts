/**
 * `connect({ prior })` — connect from a cached era verdict (`PriorDiscovery`),
 * for the gateway / distributed-client pattern (issue #79). A
 * `{ kind: 'modern', discover }` verdict is adopted directly: on a modern
 * overlap nothing reaches the wire during connect; no modern overlap throws
 * `EraNegotiationFailed`. A `{ kind: 'legacy' }` verdict skips the probe and
 * runs the plain `initialize` handshake. Freshness is the supplying host's
 * responsibility — the SDK adopts whatever verdict it is handed. Populates
 * `getDiscoverResult()` (modern arm only) and round-trips through JSON.
 * Malformed persisted blobs — wrong shape, corrupt `discover` payload —
 * reject with a typed `SdkError` before anything reaches the wire.
 */
import type { DiscoverResult, JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import { isJSONRPCRequest, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { Client } from '../../src/client/client';
import type { PriorDiscovery } from '../../src/client/probeClassifier';

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

const discoverResult = (supportedVersions: string[]): DiscoverResult => ({
    supportedVersions,
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'persisted-server', version: '1.0.0' },
    instructions: 'persisted instructions'
});

const modernPrior = (supportedVersions: string[]): PriorDiscovery => ({ kind: 'modern', discover: discoverResult(supportedVersions) });

describe('connect({ prior }) — modern verdict with overlap: zero round trips', () => {
    test('nothing reaches the wire during connect; era state is the post-probe state', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });

        await client.connect(transport, { prior: modernPrior([MODERN]) });

        // ZERO requests sent during connect.
        expect(transport.sent).toHaveLength(0);
        // The transport's protocol-version slot is stamped exactly once.
        expect(transport.setProtocolVersionCalls).toEqual([MODERN]);
        // Adopted directly from the verdict's discover payload.
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect(client.getProtocolEra()).toBe('modern');
        expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
        expect(client.getServerVersion()).toEqual({ name: 'persisted-server', version: '1.0.0' });
        expect(client.getInstructions()).toBe('persisted instructions');
        expect(client.getDiscoverResult()).toEqual(discoverResult([MODERN]));

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
        await client.connect(transport, { prior: modernPrior([MODERN]) });

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
        await client.connect(transport, { prior: modernPrior([MODERN]) });
        expect(transport.sent).toHaveLength(0);
        await client.close();
    });
});

describe('connect({ prior }) — no modern overlap: throws (no legacy fallback)', () => {
    test('legacy-only discover payload → SdkError(EraNegotiationFailed) steering to the legacy verdict and mode: auto', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });
        await expect(client.connect(transport, { prior: modernPrior(['2025-06-18']) })).rejects.toSatisfy(
            error =>
                error instanceof SdkError &&
                error.code === SdkErrorCode.EraNegotiationFailed &&
                /2026-07-28\+ mutual/.test(error.message) &&
                /kind: 'legacy'/.test(error.message) &&
                /mode: 'auto'/.test(error.message)
        );
        // Nothing reached the transport (the throw is before super.connect()).
        expect(transport.sent).toHaveLength(0);
        expect(client.getDiscoverResult()).toBeUndefined();
    });

    test('disjoint modern lists → SdkError(EraNegotiationFailed)', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });
        await expect(client.connect(transport, { prior: modernPrior(['2099-01-01']) })).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
        );
        expect(transport.sent).toHaveLength(0);
    });
});

describe('getDiscoverResult() round-trip', () => {
    test("'auto'-mode probe populates it; JSON round-trips into connect({ prior: { kind: 'modern', discover } })", async () => {
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

        // Worker: zero-round-trip connect from the revived blob, wrapped as a verdict.
        const workerTransport = new ScriptedTransport();
        const worker = new Client({ name: 'worker', version: '0' });
        await worker.connect(workerTransport, { prior: { kind: 'modern', discover: revived } });
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
        await client.connect(transport, { prior: modernPrior([MODERN]) });
        expect(client.getDiscoverResult()?.serverInfo.name).toBe('persisted-server');
        const fresh = await client.discover();
        expect(fresh.serverInfo.name).toBe('rediscovered');
        expect(client.getDiscoverResult()?.serverInfo.name).toBe('rediscovered');
        await client.close();
    });
});

/** Scripted legacy server: answers `initialize` (echoing the offered version), nothing else. */
const legacyServerScript = (message: JSONRPCMessage, t: ScriptedTransport): void => {
    if (!isJSONRPCRequest(message)) return;
    if (message.method === 'initialize') {
        t.reply({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: (message.params as { protocolVersion: string }).protocolVersion,
                capabilities: { prompts: {} },
                serverInfo: { name: 'legacy-server', version: '1.0.0' }
            }
        });
    }
};

const requestMethods = (t: ScriptedTransport): string[] => t.sent.filter(isJSONRPCRequest).map(m => m.method);

describe("connect({ prior: { kind: 'legacy' } }) — known-legacy verdict", () => {
    test('no server/discover reaches the wire, straight initialize (even under mode: auto)', async () => {
        const transport = new ScriptedTransport(legacyServerScript);
        const client = new Client({ name: 'worker', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await client.connect(transport, { prior: { kind: 'legacy' } });

        // Transport-level message capture: NO probe, the initialize handshake only.
        expect(requestMethods(transport)).toEqual(['initialize']);
        expect(transport.sent.map(m => ('method' in m ? m.method : ''))).not.toContain('server/discover');
        expect(client.getProtocolEra()).toBe('legacy');
        expect(client.getServerVersion()).toEqual({ name: 'legacy-server', version: '1.0.0' });
        expect(client.getServerCapabilities()).toEqual({ prompts: {} });
        // No DiscoverResult on this path.
        expect(client.getDiscoverResult()).toBeUndefined();
        // The handshake stamped the transport with the negotiated legacy version.
        expect(transport.setProtocolVersionCalls).toEqual([client.getNegotiatedProtocolVersion()]);

        await client.close();
    });
});

describe('connect({ prior }) — malformed persisted blobs (runtime hardening)', () => {
    test('prior: null (a persisted slot revived from JSON) is treated as absent', async () => {
        const transport = new ScriptedTransport(legacyServerScript);
        const client = new Client({ name: 'worker', version: '0' });

        await client.connect(transport, { prior: JSON.parse('null') as PriorDiscovery });

        expect(requestMethods(transport)).toEqual(['initialize']);
        expect(client.getProtocolEra()).toBe('legacy');

        await client.close();
    });

    test('object without a kind (e.g. a raw DiscoverResult) → typed SdkError, nothing sent', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });

        await expect(client.connect(transport, { prior: discoverResult([MODERN]) as unknown as PriorDiscovery })).rejects.toSatisfy(
            error =>
                error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && /unrecognized prior/.test(error.message)
        );
        expect(transport.sent).toHaveLength(0);
    });

    test("DiscoverResult-shaped blob with a stray kind: 'legacy' → typed SdkError, never era-chooses", async () => {
        const transport = new ScriptedTransport(legacyServerScript);
        const client = new Client({ name: 'worker', version: '0' });

        // Looks like a legacy verdict AND a DiscoverResult at once: corrupt.
        // Must fail typed — running initialize against this (modern) server's
        // advertisement would be a silent wrong-era outcome.
        const decoy = { ...discoverResult([MODERN]), kind: 'legacy' } as unknown as PriorDiscovery;
        await expect(client.connect(transport, { prior: decoy })).rejects.toSatisfy(
            error =>
                error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && /unrecognized prior/.test(error.message)
        );
        expect(transport.sent).toHaveLength(0);
        expect(client.getProtocolEra()).toBeUndefined();
    });

    test('modern verdict that lost its discover payload → typed SdkError, nothing sent', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });

        await expect(client.connect(transport, { prior: { kind: 'modern' } as PriorDiscovery })).rejects.toSatisfy(
            error =>
                error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && /unrecognized prior/.test(error.message)
        );
        expect(transport.sent).toHaveLength(0);
    });

    test('unrecognized kind (e.g. a case typo) → typed SdkError, not a TypeError', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });

        await expect(client.connect(transport, { prior: { kind: 'Legacy' } as unknown as PriorDiscovery })).rejects.toSatisfy(
            error =>
                error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && /unrecognized prior/.test(error.message)
        );
        expect(transport.sent).toHaveLength(0);
    });

    test('modern verdict whose discover.supportedVersions is not an array → typed SdkError, not a TypeError', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });

        await expect(
            client.connect(transport, { prior: JSON.parse('{"kind":"modern","discover":{"supportedVersions":null}}') as PriorDiscovery })
        ).rejects.toSatisfy(
            error =>
                error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && /unrecognized prior/.test(error.message)
        );
        expect(transport.sent).toHaveLength(0);
    });

    test('partially-corrupt modern verdict (valid kind, corrupt discover payload) → typed SdkError before any state change', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });

        // Valid outer discriminant, garbage inside: must fail the schema at
        // the seam, not deeper in the adopt path.
        const blob = '{"kind":"modern","discover":{"supportedVersions":["2026-07-28"],"capabilities":"garbage"}}';
        await expect(client.connect(transport, { prior: JSON.parse(blob) as PriorDiscovery })).rejects.toSatisfy(
            error =>
                error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && /unrecognized prior/.test(error.message)
        );
        expect(transport.sent).toHaveLength(0);
        // The throw happened before any connection state changed.
        expect(client.getProtocolEra()).toBeUndefined();
        expect(client.getDiscoverResult()).toBeUndefined();
        expect(client.getServerCapabilities()).toBeUndefined();
    });

    test('corrupt primitive blob → typed SdkError, not a TypeError', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'worker', version: '0' });

        await expect(client.connect(transport, { prior: JSON.parse('0') as PriorDiscovery })).rejects.toSatisfy(
            error =>
                error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && /unrecognized prior/.test(error.message)
        );
        expect(transport.sent).toHaveLength(0);
    });
});
