import type { BaseContext, JSONRPCMessage } from '@modelcontextprotocol/core';
import { HandlerRegistry, InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import type { ServerContext } from '@modelcontextprotocol/core';
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

    describe('shared HandlerRegistry', () => {
        it('uses an externally-provided registry', () => {
            const registry = new HandlerRegistry<ServerContext>();
            const server = new Server(
                { name: 'test', version: '1.0' },
                { capabilities: { tools: {} }, registry: registry as unknown as HandlerRegistry<BaseContext> }
            );

            // Server registers initialize handler in its constructor.
            // That handler should be in the shared registry.
            expect(registry.hasRequestHandler('initialize')).toBe(true);

            void server;
        });
    });
});
