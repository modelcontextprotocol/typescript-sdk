import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client.js';
import type { McpEra } from '../../src/client/clientVersionRouter.js';
import { ClientVersionRouter } from '../../src/client/clientVersionRouter.js';

/**
 * Sets up the server side of an InMemoryTransport to respond to the
 * `initialize` request and accept `notifications/initialized`.
 */
function setupMockServer(
    serverTransport: InMemoryTransport,
    serverCapabilities: Record<string, unknown> = {},
    serverInfo: { name: string; version: string } = { name: 'test-server', version: '1.0' }
): void {
    serverTransport.onmessage = async (message: JSONRPCMessage) => {
        const msg = message as { method?: string; id?: number };
        if (msg.method === 'initialize' && msg.id !== undefined) {
            await serverTransport.send({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: serverCapabilities,
                    serverInfo
                }
            } as JSONRPCMessage);
        }
        // notifications/initialized — no response needed
    };
}

class TestClientRouter extends ClientVersionRouter {
    public probeResult: McpEra = 'modern';
    public probeCalled = false;

    protected async probe(): Promise<McpEra> {
        this.probeCalled = true;
        return this.probeResult;
    }
}

describe('ClientVersionRouter', () => {
    describe('forceLegacy', () => {
        it('skips probe and does initialize when forceLegacy is true', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new TestClientRouter(client, { forceLegacy: true });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupMockServer(serverTransport, { tools: {} });

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
            expect(router.probeCalled).toBe(false);
            // Client should have server capabilities from initialize
            expect(client.getServerCapabilities()?.tools).toBeDefined();
        });
    });

    describe('probe determines era', () => {
        it('enters legacy mode when probe returns legacy', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new TestClientRouter(client);
            router.probeResult = 'legacy';

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupMockServer(serverTransport, { tools: {} });

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
            expect(router.probeCalled).toBe(true);
            // Legacy: initialize was called, so capabilities are set
            expect(client.getServerCapabilities()?.tools).toBeDefined();
        });

        it('enters modern mode when probe returns modern', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new TestClientRouter(client);
            router.probeResult = 'modern';

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupMockServer(serverTransport, { tools: {} });

            await router.connect(clientTransport);

            expect(router.era).toBe('modern');
            expect(router.probeCalled).toBe(true);
            // Modern: no initialize, so no server capabilities from handshake
        });

        it('falls back to legacy when probe throws', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new TestClientRouter(client);
            // Override probe to throw
            (router as unknown as { probe: () => Promise<McpEra> }).probe = async () => {
                throw new Error('probe failed');
            };

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupMockServer(serverTransport, { tools: {} });

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
            expect(client.getServerCapabilities()?.tools).toBeDefined();
        });
    });

    describe('close', () => {
        it('closes the underlying client', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new TestClientRouter(client, { forceLegacy: true });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupMockServer(serverTransport);
            await router.connect(clientTransport);

            await router.close();
            // No error means success
        });
    });
});
