import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { Server } from '../../src/server/server.js';

describe('Server', () => {
    describe('_oninitialize', () => {
        it('should propagate negotiated protocol version to transport', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const setProtocolVersion = vi.fn();
            (serverTransport as { setProtocolVersion?: (version: string) => void }).setProtocolVersion = setProtocolVersion;

            await server.connect(serverTransport);

            // Collect response from the server
            const responsePromise = new Promise<JSONRPCMessage>(resolve => {
                clientTransport.onmessage = msg => resolve(msg);
            });
            await clientTransport.start();

            // Send initialize request directly
            await clientTransport.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            } as JSONRPCMessage);

            await responsePromise;

            expect(setProtocolVersion).toHaveBeenCalledWith(LATEST_PROTOCOL_VERSION);

            await server.close();
        });
    });

    describe('server/discover', () => {
        it('[R-2575-5] returns supportedVersions, capabilities, serverInfo', async () => {
            const server = new Server(
                { name: 'test', version: '1.0.0' },
                { capabilities: { tools: { listChanged: true } }, instructions: 'hello' }
            );
            const res = await server.handleStatelessRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: { _meta: { 'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION } }
            });
            expect(res).toMatchObject({
                result: {
                    supportedVersions: expect.arrayContaining([LATEST_PROTOCOL_VERSION, '2025-11-25']),
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: 'test', version: '1.0.0' },
                    instructions: 'hello'
                }
            });
        });

        it('[R-2575-5] is registered on every Server (no opt-in needed)', async () => {
            const server = new Server({ name: 'min', version: '0.0.0' });
            const res = await server.handleStatelessRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: { _meta: { 'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION } }
            });
            expect('result' in res ? res.result : undefined).toMatchObject({
                supportedVersions: expect.any(Array),
                serverInfo: { name: 'min', version: '0.0.0' }
            });
        });
    });
});
