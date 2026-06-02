import type { JSONRPCRequest } from '@modelcontextprotocol/core';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    DRAFT_PROTOCOL_VERSION,
    InMemoryTransport,
    isJSONRPCRequest,
    LATEST_PROTOCOL_VERSION,
    LOG_LEVEL_META_KEY,
    PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/core';

import { Client } from '../../src/client/client.js';

/**
 * In-memory legacy-server stub: answers `server/discover` with -32601 (it predates discovery,
 * so a probing client falls back to initialize), records each initialize request's
 * protocolVersion, and replies with `respondWithVersion` (default: echo).
 */
function fakeInitializeServer(respondWithVersion?: string): {
    clientTransport: InMemoryTransport;
    requestedVersions: string[];
    requests: JSONRPCRequest[];
} {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const requestedVersions: string[] = [];
    const requests: JSONRPCRequest[] = [];
    serverTransport.onmessage = message => {
        if (!isJSONRPCRequest(message)) {
            return;
        }
        requests.push(message);
        if (message.method === 'server/discover') {
            void serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32_601, message: 'Method not found' }
            });
            return;
        }
        if (message.method === 'initialize') {
            const params = message.params as { protocolVersion: string };
            requestedVersions.push(params.protocolVersion);
            void serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    protocolVersion: respondWithVersion ?? params.protocolVersion,
                    capabilities: {},
                    serverInfo: { name: 'fake-server', version: '0.0.0' }
                }
            });
            return;
        }
        void serverTransport.send({ jsonrpc: '2.0', id: message.id, result: {} });
    };
    return { clientTransport, requestedVersions, requests };
}

/**
 * In-memory per-request-era server stub: answers `server/discover` with the given
 * `supportedVersions` — after first rejecting each version in `rejectClaims` with -32004 —
 * and answers `ping` with an empty result. Never speaks initialize.
 */
function fakeDiscoverServer(supportedVersions: string[], rejectClaims: string[] = []) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const requests: JSONRPCRequest[] = [];
    serverTransport.onmessage = message => {
        if (!isJSONRPCRequest(message)) {
            return;
        }
        requests.push(message);
        const claimed = message.params?._meta?.[PROTOCOL_VERSION_META_KEY];
        if (typeof claimed === 'string' && rejectClaims.includes(claimed)) {
            void serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                error: {
                    code: -32_004,
                    message: 'Unsupported protocol version',
                    data: { supported: supportedVersions, requested: claimed }
                }
            });
            return;
        }
        if (message.method === 'server/discover') {
            void serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                result: { supportedVersions, capabilities: {}, serverInfo: { name: 'fake-discover-server', version: '0.0.0' } }
            });
            return;
        }
        void serverTransport.send({ jsonrpc: '2.0', id: message.id, result: {} });
    };
    return { clientTransport, requests };
}

describe('Client', () => {
    describe('initialize negotiates stateful protocol versions only', () => {
        it('requests the first stateful supported version regardless of list order', async () => {
            const client = new Client(
                { name: 'test-client', version: '1.0.0' },
                { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION] }
            );
            const { clientTransport, requestedVersions } = fakeInitializeServer();

            await client.connect(clientTransport);

            expect(requestedVersions).toEqual([LATEST_PROTOCOL_VERSION]);
            expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
            await client.close();
        });

        it('connect() rejects after the declined discovery probe when no supported version is stateful', async () => {
            const client = new Client({ name: 'test-client', version: '1.0.0' }, { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION] });
            const { clientTransport, requestedVersions, requests } = fakeInitializeServer();

            await expect(client.connect(clientTransport)).rejects.toThrow(
                'initialize cannot negotiate protocol versions newer than 2025-11-25'
            );
            // The probe is the only thing that touched the wire: initialize was never sent.
            expect(requests.map(request => request.method)).toEqual(['server/discover']);
            expect(requestedVersions).toEqual([]);
            expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
        });

        it('rejects an initialize result carrying a stateless version, even one listed as supported', async () => {
            const client = new Client(
                { name: 'test-client', version: '1.0.0' },
                { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION] }
            );
            const { clientTransport } = fakeInitializeServer(DRAFT_PROTOCOL_VERSION);

            await expect(client.connect(clientTransport)).rejects.toThrow(
                `Server's protocol version is not supported: ${DRAFT_PROTOCOL_VERSION}`
            );
            expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
        });
    });

    describe('per-request era connect (discovery-based)', () => {
        it('falls back to initialize without leaking the envelope after the probe is declined', async () => {
            const client = new Client(
                { name: 'test-client', version: '1.0.0' },
                { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION] }
            );
            const { clientTransport, requests } = fakeInitializeServer();

            await client.connect(clientTransport);

            // The declined probe precedes the initialize handshake on the wire.
            expect(requests.map(request => request.method)).toEqual(['server/discover', 'initialize']);
            // The probe itself carried the full envelope claiming the preferred draft version...
            const probeMeta = requests[0]!.params?._meta as Record<string, unknown>;
            expect(probeMeta[PROTOCOL_VERSION_META_KEY]).toBe(DRAFT_PROTOCOL_VERSION);
            expect(probeMeta[CLIENT_INFO_META_KEY]).toEqual({ name: 'test-client', version: '1.0.0' });
            expect(probeMeta[CLIENT_CAPABILITIES_META_KEY]).toEqual({});

            // ...but after the fallback nothing is stamped: a post-connect request carries no envelope keys.
            await client.ping();
            const ping = requests.find(request => request.method === 'ping');
            expect(ping?.params?._meta?.[PROTOCOL_VERSION_META_KEY]).toBeUndefined();
            await client.close();
        });

        it('retries the probe at most once on -32004: a second rejection fails connect()', async () => {
            const client = new Client(
                { name: 'test-client', version: '1.0.0' },
                { supportedProtocolVersions: ['2026-DRAFT-A', '2026-DRAFT-B'] }
            );
            // The server lists DRAFT-B as supported but keeps rejecting it: a server that
            // contradicts its own -32004 data must not produce an infinite retry loop.
            const { clientTransport, requests } = fakeDiscoverServer(['2026-DRAFT-B'], ['2026-DRAFT-A', '2026-DRAFT-B']);

            await expect(client.connect(clientTransport)).rejects.toThrow('Unsupported protocol version');

            expect(requests.map(request => request.method)).toEqual(['server/discover', 'server/discover']);
            expect(requests[0]!.params?._meta?.[PROTOCOL_VERSION_META_KEY]).toBe('2026-DRAFT-A');
            expect(requests[1]!.params?._meta?.[PROTOCOL_VERSION_META_KEY]).toBe('2026-DRAFT-B');
            expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
        });

        it('rejects when discovery succeeds but no version is mutually supported and none is stateful', async () => {
            const client = new Client({ name: 'test-client', version: '1.0.0' }, { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION] });
            const { clientTransport } = fakeDiscoverServer(['2099-01-01']);

            await expect(client.connect(clientTransport)).rejects.toThrow(
                'No mutually supported protocol version (server supports: 2099-01-01)'
            );
            expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
        });

        it('hard-fails without attempting initialize when discovery offers neither a mutual nor a stateful version', async () => {
            // A dual-era client must not "helpfully" initialize with its own stateful versions
            // when the server's discovery answer listed none of them.
            const client = new Client(
                { name: 'test-client', version: '1.0.0' },
                { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION] }
            );
            const { clientTransport, requests } = fakeDiscoverServer(['2099-01-01']);

            await expect(client.connect(clientTransport)).rejects.toThrow(
                'No mutually supported protocol version (server supports: 2099-01-01)'
            );
            expect(requests.map(request => request.method)).toEqual(['server/discover']);
            expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
        });

        it('falls back to initialize when discovery reports only stateful versions', async () => {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const requests: JSONRPCRequest[] = [];
            serverTransport.onmessage = message => {
                if (!isJSONRPCRequest(message)) {
                    return;
                }
                requests.push(message);
                if (message.method === 'server/discover') {
                    void serverTransport.send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            supportedVersions: [LATEST_PROTOCOL_VERSION],
                            capabilities: {},
                            serverInfo: { name: 'stateful-discover-server', version: '0.0.0' }
                        }
                    });
                    return;
                }
                if (message.method === 'initialize') {
                    const params = message.params as { protocolVersion: string };
                    void serverTransport.send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: params.protocolVersion,
                            capabilities: {},
                            serverInfo: { name: 'stateful-discover-server', version: '0.0.0' }
                        }
                    });
                    return;
                }
                void serverTransport.send({ jsonrpc: '2.0', id: message.id, result: {} });
            };
            const client = new Client(
                { name: 'test-client', version: '1.0.0' },
                { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION] }
            );

            await client.connect(clientTransport);

            expect(requests.map(request => request.method)).toEqual(['server/discover', 'initialize']);
            expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
            await client.close();
        });
    });

    describe('per-request logging level', () => {
        it('setLoggingLevel stamps the envelope instead of sending logging/setLevel', async () => {
            const client = new Client({ name: 'test-client', version: '1.0.0' }, { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION] });
            const { clientTransport, requests } = fakeDiscoverServer([DRAFT_PROTOCOL_VERSION]);
            await client.connect(clientTransport);

            await client.setLoggingLevel('warning');
            await client.ping();

            // The removed RPC never touched the wire; the level rides the envelope instead.
            expect(requests.map(request => request.method)).toEqual(['server/discover', 'ping']);
            const ping = requests.find(request => request.method === 'ping');
            expect(ping?.params?._meta?.[LOG_LEVEL_META_KEY]).toBe('warning');
            expect(ping?.params?._meta?.[PROTOCOL_VERSION_META_KEY]).toBe(DRAFT_PROTOCOL_VERSION);
            await client.close();
        });

        it('setLoggingLevel still sends logging/setLevel on the initialize path', async () => {
            const client = new Client({ name: 'test-client', version: '1.0.0' });
            const { clientTransport, requests } = fakeInitializeServer();
            await client.connect(clientTransport);

            await client.setLoggingLevel('warning');

            const setLevel = requests.find(request => request.method === 'logging/setLevel');
            expect(setLevel?.params).toEqual({ level: 'warning' });
            await client.close();
        });
    });
});
