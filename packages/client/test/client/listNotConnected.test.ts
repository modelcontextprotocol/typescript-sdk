import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client.js';
import { InMemoryResponseCacheStore } from '../../src/client/responseCache.js';

function createConnectedPair(capabilities?: {
    tools?: Record<string, never>;
    prompts?: Record<string, never>;
    resources?: Record<string, never>;
}) {
    const server = new McpServer({ name: 'test-server', version: '1.0.0' }, capabilities ? { capabilities } : undefined);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    return { server, client };
}

describe('Client list methods when disconnected (#3195)', () => {
    it('rejects all four capability-lenient list methods before connect', async () => {
        const client = new Client({ name: 'test-client', version: '1.0.0' });

        await expect(client.listTools()).rejects.toThrow('Not connected');
        await expect(client.listPrompts()).rejects.toThrow('Not connected');
        await expect(client.listResources()).rejects.toThrow('Not connected');
        await expect(client.listResourceTemplates()).rejects.toThrow('Not connected');
    });

    it('rejects all four list methods with Not connected after close()', async () => {
        const { server, client } = createConnectedPair({
            tools: {},
            prompts: {},
            resources: {}
        });
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTx), client.connect(clientTx)]);

        await expect(client.listTools()).resolves.toEqual({ tools: [] });
        await client.close();

        await expect(client.listTools()).rejects.toMatchObject({ message: 'Not connected' });
        await expect(client.listPrompts()).rejects.toMatchObject({ message: 'Not connected' });
        await expect(client.listResources()).rejects.toMatchObject({ message: 'Not connected' });
        await expect(client.listResourceTemplates()).rejects.toMatchObject({ message: 'Not connected' });
        await server.close();
    });

    it('still returns empty lists when connected to a server without the capability', async () => {
        const { server, client } = createConnectedPair();
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTx), client.connect(clientTx)]);

        await expect(client.listTools()).resolves.toEqual({ tools: [] });
        await expect(client.listPrompts()).resolves.toEqual({ prompts: [] });
        await expect(client.listResources()).resolves.toEqual({ resources: [] });
        await expect(client.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });

        await client.close();
        await server.close();
    });

    it('does not serve from a persistent cache store after close()', async () => {
        const store = new InMemoryResponseCacheStore();
        const server = new McpServer({ name: 'cached-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        const client = new Client({ name: 'cached-client', version: '1.0.0' }, { responseCacheStore: store });
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTx), client.connect(clientTx)]);

        await expect(client.listTools()).resolves.toEqual({ tools: [] });
        await client.close();

        await expect(client.listTools()).rejects.toMatchObject({ message: 'Not connected' });
        await server.close();
    });
});
