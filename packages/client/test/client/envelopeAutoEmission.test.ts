/**
 * Per-request `_meta` envelope auto-emission (protocol revision 2026-07-28):
 * on a connection that negotiated the modern era — auto-negotiated or pinned —
 * the client automatically attaches the reserved protocol-version /
 * client-info / client-capabilities `_meta` keys to every outgoing request and
 * notification. User-supplied `_meta` keys win over the auto-attached ones.
 * Legacy-era connections never gain these keys (D9b byte-identity holds).
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    LATEST_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';

const MODERN = '2026-07-28';

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

function metaOf(message: JSONRPCMessage): Record<string, unknown> | undefined {
    const params = (message as { params?: { _meta?: Record<string, unknown> } }).params;
    return params?._meta;
}

/**
 * A scripted server side of an in-memory pair: answers `server/discover` (so a
 * negotiating client lands on the modern era) or `initialize` (legacy era), and
 * records everything the client writes.
 */
async function scriptedServerSide(era: 'modern' | 'legacy', answerToolsList = true) {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const written: JSONRPCMessage[] = [];
    serverTx.onmessage = message => {
        written.push(message);
        const request = message as { id?: number | string; method?: string };
        if (request.method === 'server/discover' && request.id !== undefined) {
            if (era === 'modern') {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        resultType: 'complete',
                        supportedVersions: [MODERN],
                        capabilities: { tools: {} },
                        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'scripted-modern-server', version: '1.0.0' } }
                    }
                });
            } else {
                void serverTx.send({ jsonrpc: '2.0', id: request.id, error: { code: -32_601, message: 'Method not found' } });
            }
            return;
        }
        if (request.method === 'initialize' && request.id !== undefined) {
            void serverTx.send({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: 'scripted-legacy-server', version: '1.0.0' }
                }
            });
            return;
        }
        if (request.method === 'tools/list' && request.id !== undefined && answerToolsList) {
            const result: Record<string, unknown> =
                era === 'modern' ? { resultType: 'complete', tools: [], ttlMs: 0, cacheScope: 'public' } : { tools: [] };
            void serverTx.send({ jsonrpc: '2.0', id: request.id, result });
        }
    };
    await serverTx.start();
    return { clientTx, written };
}

describe('per-request _meta envelope auto-emission on modern-era connections', () => {
    it('attaches the reserved envelope keys to every outgoing request and notification', async () => {
        const { clientTx, written } = await scriptedServerSide('modern');
        const clientInfo = { name: 'envelope-client', version: '1.2.3' };
        const client = new Client(clientInfo, {
            versionNegotiation: { mode: 'auto' },
            capabilities: { elicitation: { form: {} } }
        });
        await client.connect(clientTx);
        expect(client.getProtocolEra()).toBe('modern');

        await client.listTools();
        await client.notification({ method: 'notifications/progress', params: { progressToken: 't', progress: 1 } });
        await flush();

        const listToolsMessage = written.find(m => (m as { method?: string }).method === 'tools/list');
        expect(listToolsMessage).toBeDefined();
        expect(metaOf(listToolsMessage!)).toEqual({
            [PROTOCOL_VERSION_META_KEY]: MODERN,
            [CLIENT_INFO_META_KEY]: clientInfo,
            [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } }
        });

        const progressMessage = written.find(m => (m as { method?: string }).method === 'notifications/progress');
        expect(progressMessage).toBeDefined();
        expect(metaOf(progressMessage!)?.[PROTOCOL_VERSION_META_KEY]).toBe(MODERN);
        expect(metaOf(progressMessage!)?.[CLIENT_INFO_META_KEY]).toEqual(clientInfo);

        await client.close();
    });

    it('reflects registered client capabilities in the auto-attached client-capabilities key', async () => {
        const { clientTx, written } = await scriptedServerSide('modern');
        const client = new Client({ name: 'envelope-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        client.registerCapabilities({ sampling: {} });
        await client.connect(clientTx);

        await client.listTools();
        const listToolsMessage = written.find(m => (m as { method?: string }).method === 'tools/list');
        expect(metaOf(listToolsMessage!)?.[CLIENT_CAPABILITIES_META_KEY]).toEqual({ sampling: {} });

        await client.close();
    });

    it('user-supplied _meta keys win over the auto-attached envelope keys; non-envelope keys are preserved', async () => {
        const { clientTx, written } = await scriptedServerSide('modern');
        const client = new Client({ name: 'envelope-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(clientTx);

        await client.request({
            method: 'tools/list',
            params: { _meta: { [PROTOCOL_VERSION_META_KEY]: 'consumer-override', 'x-consumer': 'kept' } }
        });
        const listToolsMessage = written.find(m => (m as { method?: string }).method === 'tools/list');
        const meta = metaOf(listToolsMessage!);
        expect(meta?.[PROTOCOL_VERSION_META_KEY]).toBe('consumer-override');
        expect(meta?.['x-consumer']).toBe('kept');
        // The other envelope keys are still auto-attached.
        expect(meta?.[CLIENT_INFO_META_KEY]).toEqual({ name: 'envelope-client', version: '1.0.0' });

        await client.close();
    });

    it('attaches the envelope to the cancellation notification of a modern-era request', async () => {
        const { clientTx, written } = await scriptedServerSide('modern', /* answerToolsList */ false);
        const client = new Client({ name: 'envelope-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(clientTx);

        const controller = new AbortController();
        const pending = client.listTools(undefined, { signal: controller.signal }).catch(() => {});
        await flush();
        controller.abort('test cancel');
        await pending;
        await flush();

        const cancelMessage = written.find(m => (m as { method?: string }).method === 'notifications/cancelled');
        expect(cancelMessage).toBeDefined();
        expect(metaOf(cancelMessage!)?.[PROTOCOL_VERSION_META_KEY]).toBe(MODERN);

        await client.close();
    });

    it('legacy-era connections never gain the envelope keys (byte-identity with a 2025 client)', async () => {
        const { clientTx, written } = await scriptedServerSide('legacy');
        const client = new Client({ name: 'envelope-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        expect(client.getProtocolEra()).toBe('legacy');

        await client.listTools();
        await flush();

        // initialize, notifications/initialized, tools/list — none carry envelope keys.
        const postProbe = written.filter(m => (m as { method?: string }).method !== 'server/discover');
        expect(postProbe.length).toBeGreaterThanOrEqual(3);
        for (const message of postProbe) {
            const meta = metaOf(message);
            expect(meta?.[PROTOCOL_VERSION_META_KEY]).toBeUndefined();
            expect(meta?.[CLIENT_INFO_META_KEY]).toBeUndefined();
            expect(meta?.[CLIENT_CAPABILITIES_META_KEY]).toBeUndefined();
        }

        await client.close();
    });

    it('the plain legacy default (no versionNegotiation) emits no envelope keys at all', async () => {
        const { clientTx, written } = await scriptedServerSide('legacy');
        const client = new Client({ name: 'envelope-client', version: '1.0.0' });
        await client.connect(clientTx);
        expect(client.getProtocolEra()).toBe('legacy');

        await client.listTools();
        await flush();

        for (const message of written) {
            const meta = metaOf(message);
            expect(meta?.[PROTOCOL_VERSION_META_KEY]).toBeUndefined();
        }
        // initialize body matches today's plain client (no probe was ever sent).
        expect(written.some(m => (m as { method?: string }).method === 'server/discover')).toBe(false);

        await client.close();
    });
});

describe('setVersionNegotiation()', () => {
    it('configures negotiation pre-connect (equivalent to the constructor option)', async () => {
        const { clientTx } = await scriptedServerSide('modern');
        const client = new Client({ name: 'setter-client', version: '1.0.0' });
        client.setVersionNegotiation({ mode: { pin: MODERN } });
        await client.connect(clientTx);
        expect(client.getProtocolEra()).toBe('modern');
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        await client.close();
    });

    it('throws after connecting to a transport', async () => {
        const { clientTx } = await scriptedServerSide('legacy');
        const client = new Client({ name: 'setter-client', version: '1.0.0' });
        await client.connect(clientTx);
        expect(() => client.setVersionNegotiation({ mode: 'auto' })).toThrow(/after connecting/);
        await client.close();
    });

    it('passing undefined clears a previously configured negotiation (back to the legacy default)', async () => {
        const { clientTx } = await scriptedServerSide('legacy');
        const client = new Client({ name: 'setter-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        client.setVersionNegotiation(undefined);
        await client.connect(clientTx);
        expect(client.getProtocolEra()).toBe('legacy');
        await client.close();
    });
});

describe('getProtocolEra()', () => {
    it('is undefined before connect, "legacy" after a 2025 handshake, "modern" after a 2026-07-28 negotiation', async () => {
        const legacy = await scriptedServerSide('legacy');
        const legacyClient = new Client({ name: 'era-client', version: '1.0.0' });
        expect(legacyClient.getProtocolEra()).toBeUndefined();
        await legacyClient.connect(legacy.clientTx);
        expect(legacyClient.getProtocolEra()).toBe('legacy');
        await legacyClient.close();

        const modern = await scriptedServerSide('modern');
        const modernClient = new Client({ name: 'era-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await modernClient.connect(modern.clientTx);
        expect(modernClient.getProtocolEra()).toBe('modern');
        await modernClient.close();
    });
});
