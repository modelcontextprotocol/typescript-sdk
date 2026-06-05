import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';

import { Client } from '../../src/client/client.js';

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

describe('Client connect modes', () => {
    it('connect with skipInitialize attaches transport without sending initialize', async () => {
        const client = new Client({ name: 'test', version: '1.0' });
        const transport: Transport = {
            start: vi.fn().mockResolvedValue(undefined),
            send: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined)
        };

        await client.connect(transport, { skipInitialize: true });

        // Transport started but no initialize sent
        expect(transport.start).toHaveBeenCalled();
        expect(transport.send).not.toHaveBeenCalled();
    });

    it('initialize() sends the handshake after skipInitialize connect', async () => {
        const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        setupMockServer(serverTransport, { tools: {} });

        await client.connect(clientTransport, { skipInitialize: true });
        expect(client.getServerCapabilities()).toBeUndefined();

        await client.initialize();
        expect(client.getServerCapabilities()).toBeDefined();
        expect(client.getServerCapabilities()?.tools).toBeDefined();
    });

    it('connect without skipInitialize works as before', async () => {
        const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        setupMockServer(serverTransport, { tools: {} });

        await client.connect(clientTransport);
        expect(client.getServerCapabilities()?.tools).toBeDefined();
    });
});

describe('Client info accessors', () => {
    it('getClientInfo returns client info', () => {
        const client = new Client({ name: 'my-client', version: '2.0' });
        expect(client.getClientInfo()).toEqual({ name: 'my-client', version: '2.0' });
    });

    it('getClientCapabilities returns capabilities', () => {
        const client = new Client({ name: 'test', version: '1.0' }, { capabilities: { sampling: {} } });
        expect(client.getClientCapabilities().sampling).toBeDefined();
    });

    it('setServerInfo stores server info', () => {
        const client = new Client({ name: 'test', version: '1.0' });
        client.setServerInfo({
            capabilities: { tools: {} },
            serverInfo: { name: 'srv', version: '1.0' },
            instructions: 'hello'
        });
        expect(client.getServerCapabilities()?.tools).toBeDefined();
        expect(client.getServerVersion()?.name).toBe('srv');
        expect(client.getInstructions()).toBe('hello');
    });
});
