/**
 * TS-01 directionality, client side: the 2026-07-28 era has no server→client
 * JSON-RPC request channel, and on stdio the client must never write JSON-RPC
 * responses — so an inbound request arriving on a connection that negotiated
 * a modern era is dropped (surfaced via `onerror`), never answered. Legacy-era
 * connections keep today's behavior (the client answers, e.g. with −32601 for
 * methods it has no handler for).
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_LEGACY_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';

const MODERN = '2026-07-28';

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

/**
 * A scripted server side of an in-memory pair: answers `server/discover` (so a
 * negotiating client lands on the modern era) or `initialize` (legacy era), and
 * records everything the client writes.
 */
async function scriptedServerSide(eras: 'modern' | 'legacy') {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const written: JSONRPCMessage[] = [];
    serverTx.onmessage = message => {
        written.push(message);
        const request = message as { id?: number | string; method?: string };
        if (request.method === 'server/discover' && request.id !== undefined) {
            if (eras === 'modern') {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        resultType: 'complete',
                        supportedVersions: [MODERN],
                        capabilities: { tools: {} },
                        serverInfo: { name: 'scripted-modern-server', version: '1.0.0' }
                    }
                });
            } else {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: { code: -32_601, message: 'Method not found' }
                });
            }
            return;
        }
        if (request.method === 'initialize' && request.id !== undefined) {
            void serverTx.send({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
                    capabilities: {},
                    serverInfo: { name: 'scripted-legacy-server', version: '1.0.0' }
                }
            });
        }
    };
    await serverTx.start();
    return { clientTx, serverTx, written };
}

describe('client inbound-drop on modern-era connections (TS-01)', () => {
    it('drops an inbound server→client request without writing any response, surfacing it via onerror', async () => {
        const { clientTx, serverTx, written } = await scriptedServerSide('modern');
        const client = new Client({ name: 'drop-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        await client.connect(clientTx);
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);

        const before = written.length;
        // A misbehaving "modern" server sends a server→client request (the
        // channel is deleted in the 2026 era). The client must not answer.
        await serverTx.send({
            jsonrpc: '2.0',
            id: 'rogue-1',
            method: 'roots/list',
            params: {}
        });
        await flush();

        expect(written).toHaveLength(before);
        expect(errors.some(error => error.message.includes('Dropped inbound request'))).toBe(true);

        await client.close();
    });

    it('refuses a wire elicitation/create request on a modern connection even when an elicitation handler is registered (the in-band vocabulary grants no wire dispatch)', async () => {
        const { clientTx, serverTx, written } = await scriptedServerSide('modern');
        const client = new Client(
            { name: 'drop-client', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} } } }
        );
        const handled: unknown[] = [];
        client.setRequestHandler('elicitation/create', async request => {
            handled.push(request.params);
            return { action: 'accept', content: {} };
        });
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        await client.connect(clientTx);
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);

        const before = written.length;
        // elicitation/create exists on the 2026-07-28 era only as in-band
        // (embedded) vocabulary inside input_required results. A wire request
        // for it must never reach the registered handler or be answered with a
        // result — the era gate is not bypassed by the in-band schema fallback.
        await serverTx.send({
            jsonrpc: '2.0',
            id: 'rogue-elicit-1',
            method: 'elicitation/create',
            params: { mode: 'form', message: 'Name?', requestedSchema: { type: 'object', properties: {} } }
        });
        await flush();

        expect(handled).toHaveLength(0);
        expect(written).toHaveLength(before);
        expect(errors.some(error => error.message.includes('Dropped inbound request'))).toBe(true);

        await client.close();
    });

    it('keeps answering inbound requests on legacy-era connections (control arm)', async () => {
        const { clientTx, serverTx, written } = await scriptedServerSide('legacy');
        const client = new Client({ name: 'legacy-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_LEGACY_PROTOCOL_VERSION);

        await serverTx.send({ jsonrpc: '2.0', id: 'legacy-1', method: 'roots/list', params: {} });
        await flush();

        // Today's behavior: the client answers (here −32601, no roots handler installed).
        const answer = written.find(message => (message as { id?: string }).id === 'legacy-1');
        expect(answer).toBeDefined();
        expect((answer as { error?: { code: number } }).error?.code).toBe(-32_601);

        await client.close();
    });
});
