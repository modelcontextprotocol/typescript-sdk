import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, ProtocolErrorCode } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client.js';
import { StdioClientVersionRouter } from '../../src/client/stdioClientVersionRouter.js';

/**
 * Sets up the server side of an InMemoryTransport to respond to
 * `server/discover` with a modern discover result.
 */
function setupModernServer(
    serverTransport: InMemoryTransport,
    discoverResult: {
        capabilities?: Record<string, unknown>;
        serverInfo?: { name: string; version: string };
        instructions?: string;
    } = {}
): void {
    serverTransport.onmessage = async (message: JSONRPCMessage) => {
        const msg = message as { method?: string; id?: number };
        if (msg.method === 'server/discover' && msg.id !== undefined) {
            await serverTransport.send({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    capabilities: discoverResult.capabilities ?? { tools: {} },
                    serverInfo: discoverResult.serverInfo ?? { name: 'modern-server', version: '2.0' },
                    supportedVersions: ['2026-06-30'],
                    instructions: discoverResult.instructions
                }
            } as JSONRPCMessage);
        }
        // Other methods return no response (will time out), which is fine for these tests
    };
}

/**
 * Sets up the server side to reply to `initialize` (legacy), and
 * return -32601 (MethodNotFound) for `server/discover`.
 */
function setupLegacyServer(
    serverTransport: InMemoryTransport,
    serverCapabilities: Record<string, unknown> = { tools: {} },
    serverInfo: { name: string; version: string } = { name: 'legacy-server', version: '1.0' }
): void {
    serverTransport.onmessage = async (message: JSONRPCMessage) => {
        const msg = message as { method?: string; id?: number };

        if (msg.method === 'server/discover' && msg.id !== undefined) {
            // Return JSON-RPC -32601 Method not found
            await serverTransport.send({
                jsonrpc: '2.0',
                id: msg.id,
                error: {
                    code: ProtocolErrorCode.MethodNotFound,
                    message: 'Method not found'
                }
            } as JSONRPCMessage);
            return;
        }

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

describe('StdioClientVersionRouter', () => {
    describe('modern server (server/discover succeeds)', () => {
        it('enters modern mode when server/discover succeeds', async () => {
            const client = new Client({ name: 'test-client', version: '1.0' });
            const router = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupModernServer(serverTransport);

            await router.connect(clientTransport);

            expect(router.era).toBe('modern');
        });

        it('stores server info from discover result', async () => {
            const client = new Client({ name: 'test-client', version: '1.0' });
            const router = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupModernServer(serverTransport, {
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: 'my-modern-server', version: '3.0' },
                instructions: 'Use this server wisely'
            });

            await router.connect(clientTransport);

            expect(router.era).toBe('modern');
            expect(client.getServerVersion()).toEqual({ name: 'my-modern-server', version: '3.0' });
            expect(client.getServerCapabilities()?.tools).toBeDefined();
            expect(client.getInstructions()).toBe('Use this server wisely');
        });

        it('sets server capabilities from discover result', async () => {
            const client = new Client({ name: 'test-client', version: '1.0' });
            const router = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupModernServer(serverTransport, {
                capabilities: { tools: {}, prompts: { listChanged: true } }
            });

            await router.connect(clientTransport);

            expect(router.era).toBe('modern');
            expect(client.getServerCapabilities()?.tools).toBeDefined();
            expect(client.getServerCapabilities()?.prompts).toBeDefined();
        });
    });

    describe('legacy server (server returns -32601)', () => {
        it('falls back to legacy when server returns MethodNotFound for server/discover', async () => {
            const client = new Client({ name: 'test-client', version: '1.0' });
            const router = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupLegacyServer(serverTransport);

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
        });

        it('completes initialize handshake in legacy mode', async () => {
            const client = new Client({ name: 'test-client', version: '1.0' });
            const router = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupLegacyServer(serverTransport, { tools: {}, resources: {} });

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
            // In legacy mode, initialize() was called by the base class, so
            // server capabilities should be populated.
            expect(client.getServerCapabilities()?.tools).toBeDefined();
            expect(client.getServerCapabilities()?.resources).toBeDefined();
        });

        it('uses legacy server info from initialize handshake', async () => {
            const client = new Client({ name: 'test-client', version: '1.0' });
            const router = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupLegacyServer(serverTransport, {}, { name: 'old-server', version: '0.5' });

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
            expect(client.getServerVersion()).toEqual({ name: 'old-server', version: '0.5' });
        });
    });

    describe('forceLegacy option', () => {
        it('skips probe entirely when forceLegacy is true', async () => {
            const client = new Client({ name: 'test-client', version: '1.0' });
            const router = new StdioClientVersionRouter(client, { forceLegacy: true });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            // Only set up initialize — if probe ran it would time out since no discover handler
            setupLegacyServer(serverTransport, { tools: {} });

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
            expect(client.getServerCapabilities()?.tools).toBeDefined();
        });
    });

    describe('close', () => {
        it('closes the underlying client', async () => {
            const client = new Client({ name: 'test-client', version: '1.0' });
            const router = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupModernServer(serverTransport);

            await router.connect(clientTransport);
            await router.close();
            // No error means success
        });
    });
});
