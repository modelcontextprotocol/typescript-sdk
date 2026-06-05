import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, ProtocolErrorCode } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client.js';
import { HttpClientVersionRouter } from '../../src/client/httpClientVersionRouter.js';

/**
 * Sets up the server side of an InMemoryTransport to respond to both
 * `server/discover` and `initialize` (legacy fallback path).
 *
 * @param serverTransport - The server-side transport half.
 * @param discoverResponse - If provided, respond to `server/discover` with this result.
 *   If `null`, respond with a JSON-RPC -32601 error (Method not found).
 * @param serverCapabilities - Capabilities to advertise in the `initialize` response.
 */
function setupMockServer(
    serverTransport: InMemoryTransport,
    discoverResponse: Record<string, unknown> | null,
    serverCapabilities: Record<string, unknown> = { tools: {} },
    serverInfo: { name: string; version: string } = { name: 'test-server', version: '1.0' }
): void {
    serverTransport.onmessage = async (message: JSONRPCMessage) => {
        const msg = message as { method?: string; id?: number | string };

        if (msg.method === 'server/discover' && msg.id !== undefined) {
            if (discoverResponse !== null) {
                await serverTransport.send({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: discoverResponse
                } as JSONRPCMessage);
            } else {
                // Simulate a legacy server that doesn't know server/discover (-32601)
                await serverTransport.send({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: {
                        code: ProtocolErrorCode.MethodNotFound,
                        message: 'Method not found'
                    }
                } as JSONRPCMessage);
            }
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
            return;
        }
        // notifications/initialized and others — no response needed
    };
}

describe('HttpClientVersionRouter', () => {
    describe('modern mode', () => {
        it('enters modern mode when server/discover succeeds', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new HttpClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupMockServer(serverTransport, {
                capabilities: { tools: {} },
                serverInfo: { name: 'modern-server', version: '2.0' }
            });

            await router.connect(clientTransport);

            expect(router.era).toBe('modern');
        });

        it('populates server info from discover response in modern mode', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new HttpClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupMockServer(serverTransport, {
                capabilities: { tools: {}, prompts: {} },
                serverInfo: { name: 'discover-server', version: '3.0' },
                instructions: 'Use me wisely'
            });

            await router.connect(clientTransport);

            expect(router.era).toBe('modern');
            expect(client.getServerCapabilities()?.tools).toBeDefined();
            expect(client.getServerCapabilities()?.prompts).toBeDefined();
            expect(client.getServerVersion()).toEqual({ name: 'discover-server', version: '3.0' });
            expect(client.getInstructions()).toBe('Use me wisely');
        });
    });

    describe('legacy fallback', () => {
        it('falls back to legacy when server returns -32601 (Method not found)', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new HttpClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            // null → server returns -32601 for server/discover
            setupMockServer(serverTransport, null, { tools: {} });

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
            // Legacy: initialize was called, so server capabilities are set via handshake
            expect(client.getServerCapabilities()?.tools).toBeDefined();
        });

        it('falls back to legacy on any generic probe error (broader than stdio)', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new HttpClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            setupMockServer(serverTransport, null, { tools: {} });

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
        });

        it('performs legacy initialize handshake after probe fallback', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new HttpClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const caps = { tools: {}, resources: {} };
            setupMockServer(serverTransport, null, caps);

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
            expect(client.getServerCapabilities()?.tools).toBeDefined();
            expect(client.getServerCapabilities()?.resources).toBeDefined();
        });
    });

    describe('forceLegacy option', () => {
        it('skips probe entirely when forceLegacy is true', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new HttpClientVersionRouter(client, { forceLegacy: true });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            // Set up only initialize — if probe is called it would fail (no discover handler)
            serverTransport.onmessage = async (message: JSONRPCMessage) => {
                const msg = message as { method?: string; id?: number };
                if (msg.method === 'initialize' && msg.id !== undefined) {
                    await serverTransport.send({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            protocolVersion: LATEST_PROTOCOL_VERSION,
                            capabilities: { tools: {} },
                            serverInfo: { name: 'legacy-only', version: '1.0' }
                        }
                    } as JSONRPCMessage);
                }
            };

            await router.connect(clientTransport);

            expect(router.era).toBe('legacy');
            expect(client.getServerCapabilities()?.tools).toBeDefined();
        });
    });

    describe('close', () => {
        it('closes the underlying client', async () => {
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const router = new HttpClientVersionRouter(client, { forceLegacy: true });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            serverTransport.onmessage = async (message: JSONRPCMessage) => {
                const msg = message as { method?: string; id?: number };
                if (msg.method === 'initialize' && msg.id !== undefined) {
                    await serverTransport.send({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            protocolVersion: LATEST_PROTOCOL_VERSION,
                            capabilities: {},
                            serverInfo: { name: 'srv', version: '1.0' }
                        }
                    } as JSONRPCMessage);
                }
            };

            await router.connect(clientTransport);
            await router.close();
            // No error means success
        });
    });
});
