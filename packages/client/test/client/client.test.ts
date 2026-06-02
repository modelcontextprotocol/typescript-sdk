import { DRAFT_PROTOCOL_VERSION, InMemoryTransport, isJSONRPCRequest, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';

import { Client } from '../../src/client/client.js';

/** In-memory server stub: records each initialize request's protocolVersion, replies with `respondWithVersion` (default: echo). */
function fakeInitializeServer(respondWithVersion?: string): { clientTransport: InMemoryTransport; requestedVersions: string[] } {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const requestedVersions: string[] = [];
    serverTransport.onmessage = message => {
        if (isJSONRPCRequest(message) && message.method === 'initialize') {
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
        }
    };
    return { clientTransport, requestedVersions };
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

        it('connect() rejects without touching the wire when no supported version is stateful', async () => {
            const client = new Client({ name: 'test-client', version: '1.0.0' }, { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION] });
            const { clientTransport, requestedVersions } = fakeInitializeServer();

            await expect(client.connect(clientTransport)).rejects.toThrow(
                'initialize cannot negotiate protocol versions newer than 2025-11-25'
            );
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
});
