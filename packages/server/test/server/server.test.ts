import type { ClientCapabilities, Implementation, JSONRPCMessage } from '@modelcontextprotocol/core';
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

    describe('connect — oninitializationreplay hook', () => {
        const testCapabilities: ClientCapabilities = { sampling: {} };
        const testVersion: Implementation = { name: 'test-client', version: '2.0.0' };

        it('should seed getClientCapabilities() when transport.oninitializationreplay is called', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const [, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport);

            // Simulate transport calling oninitializationreplay (as _tryReplayInitialization would)
            serverTransport.oninitializationreplay?.({
                clientCapabilities: testCapabilities,
                clientVersion: testVersion
            });

            expect(server.getClientCapabilities()).toEqual(testCapabilities);
            expect(server.getClientVersion()).toEqual(testVersion);

            await server.close();
        });

        it('should return undefined for getClientCapabilities() when oninitializationreplay is not called', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const [, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport);

            expect(server.getClientCapabilities()).toBeUndefined();
            expect(server.getClientVersion()).toBeUndefined();

            await server.close();
        });

        it('should be overwritten by a real initialize handshake', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport);

            // First: seed via oninitializationreplay
            serverTransport.oninitializationreplay?.({
                clientCapabilities: testCapabilities,
                clientVersion: testVersion
            });

            expect(server.getClientCapabilities()).toEqual(testCapabilities);

            // Then: real initialize overwrites
            const responsePromise = new Promise<JSONRPCMessage>(resolve => {
                clientTransport.onmessage = msg => resolve(msg);
            });
            await clientTransport.start();

            const realCapabilities: ClientCapabilities = { elicitation: { form: {} } };
            const realVersion: Implementation = { name: 'real-client', version: '3.0.0' };

            await clientTransport.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: realCapabilities,
                    clientInfo: realVersion
                }
            } as JSONRPCMessage);

            await responsePromise;

            expect(server.getClientCapabilities()).toEqual(realCapabilities);
            expect(server.getClientVersion()).toEqual(realVersion);

            await server.close();
        });

        it('should chain with an existing transport.oninitializationreplay callback', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const [, serverTransport] = InMemoryTransport.createLinkedPair();

            const existingCallback = vi.fn();
            serverTransport.oninitializationreplay = existingCallback;

            await server.connect(serverTransport);

            const data = { clientCapabilities: testCapabilities, clientVersion: testVersion };
            serverTransport.oninitializationreplay?.(data);

            // Both the existing callback and the server's hook should have fired
            expect(existingCallback).toHaveBeenCalledWith(data);
            expect(server.getClientCapabilities()).toEqual(testCapabilities);

            await server.close();
        });
    });
});
