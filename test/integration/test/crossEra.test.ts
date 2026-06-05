import { Client, StdioClientVersionRouter } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/core';
import { McpServer, StdioVersionRouter } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Creates a test McpServer with a single 'ping' tool that returns 'pong'.
 */
function createTestServer() {
    const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });
    mcpServer.registerTool('ping', { description: 'ping tool' }, async () => ({
        content: [{ type: 'text', text: 'pong' }]
    }));
    return mcpServer;
}

describe('Cross-era integration tests', () => {
    let clientRouter: StdioClientVersionRouter | undefined;
    let serverRouter: StdioVersionRouter | undefined;

    afterEach(async () => {
        await clientRouter?.close();
        await serverRouter?.close();
        clientRouter = undefined;
        serverRouter = undefined;
    });

    describe('1: Legacy client + Legacy server (forceLegacy on both)', () => {
        it('both use initialize handshake, tools work', async () => {
            const mcpServer = createTestServer();
            serverRouter = new StdioVersionRouter(mcpServer, { forceLegacy: true });

            const client = new Client({ name: 'test-client', version: '1.0.0' });
            clientRouter = new StdioClientVersionRouter(client, { forceLegacy: true });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            // Server starts serving on its transport
            await serverRouter.serve(serverTransport);

            // Client connects — forceLegacy skips probe, goes straight to initialize
            await clientRouter.connect(clientTransport);

            // Verify era
            expect(clientRouter.era).toBe('legacy');

            // Verify capabilities were received via initialize
            expect(client.getServerCapabilities()).toBeDefined();
            expect(client.getServerVersion()).toEqual({ name: 'test-server', version: '1.0.0' });

            // Verify tools work
            const listResult = await client.listTools();
            expect(listResult.tools).toHaveLength(1);
            expect(listResult.tools[0]!.name).toBe('ping');

            const callResult = await client.callTool({ name: 'ping' });
            expect(callResult.content).toEqual([{ type: 'text', text: 'pong' }]);
        });
    });

    describe('2: Modern client + Modern server (default on both)', () => {
        it('client probes discover, modern path, tools work', async () => {
            const mcpServer = createTestServer();
            serverRouter = new StdioVersionRouter(mcpServer);

            const client = new Client({ name: 'test-client', version: '1.0.0' });
            clientRouter = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            // Server starts serving on its transport
            await serverRouter.serve(serverTransport);

            // Client connects — probes server/discover, gets modern response
            await clientRouter.connect(clientTransport);

            // Verify era
            expect(clientRouter.era).toBe('modern');

            // Verify capabilities were received via discover (not initialize)
            expect(client.getServerCapabilities()).toBeDefined();
            expect(client.getServerCapabilities()!.tools).toBeDefined();
            expect(client.getServerVersion()).toEqual({ name: 'test-server', version: '1.0.0' });

            // Verify tools work via dispatch (modern path)
            const listResult = await client.listTools();
            expect(listResult.tools).toHaveLength(1);
            expect(listResult.tools[0]!.name).toBe('ping');

            const callResult = await client.callTool({ name: 'ping' });
            expect(callResult.content).toEqual([{ type: 'text', text: 'pong' }]);
        });
    });

    describe('3: Modern client + Legacy server (server forceLegacy)', () => {
        it('client probes, falls back to initialize, tools work', async () => {
            const mcpServer = createTestServer();
            // Server is forceLegacy — will route everything through legacy session,
            // including the probe (server/discover), which the legacy Server will
            // reject with MethodNotFound.
            serverRouter = new StdioVersionRouter(mcpServer, { forceLegacy: true });

            const client = new Client({ name: 'test-client', version: '1.0.0' });
            // Client is default (probes modern)
            clientRouter = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            // Server starts serving on its transport
            await serverRouter.serve(serverTransport);

            // Client connects — probes server/discover, gets -32601, falls back to initialize
            await clientRouter.connect(clientTransport);

            // Verify era — should have fallen back to legacy
            expect(clientRouter.era).toBe('legacy');

            // Verify capabilities were received via initialize
            expect(client.getServerCapabilities()).toBeDefined();
            expect(client.getServerVersion()).toEqual({ name: 'test-server', version: '1.0.0' });

            // Verify tools work
            const listResult = await client.listTools();
            expect(listResult.tools).toHaveLength(1);
            expect(listResult.tools[0]!.name).toBe('ping');

            const callResult = await client.callTool({ name: 'ping' });
            expect(callResult.content).toEqual([{ type: 'text', text: 'pong' }]);
        });
    });

    describe('4: Legacy client + Dual server (client forceLegacy)', () => {
        it('client sends initialize, server routes to legacy bridge', async () => {
            const mcpServer = createTestServer();
            // Server is default (dual — accepts both modern and legacy)
            serverRouter = new StdioVersionRouter(mcpServer);

            const client = new Client({ name: 'test-client', version: '1.0.0' });
            // Client is forceLegacy — skips probe, goes straight to initialize
            clientRouter = new StdioClientVersionRouter(client, { forceLegacy: true });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            // Server starts serving on its transport
            await serverRouter.serve(serverTransport);

            // Client connects — forceLegacy skips probe, sends initialize.
            // Server classifies 'initialize' as legacy and routes through bridge.
            await clientRouter.connect(clientTransport);

            // Verify era
            expect(clientRouter.era).toBe('legacy');

            // Verify capabilities were received via initialize
            expect(client.getServerCapabilities()).toBeDefined();
            expect(client.getServerVersion()).toEqual({ name: 'test-server', version: '1.0.0' });

            // Verify tools work through the legacy bridge
            const listResult = await client.listTools();
            expect(listResult.tools).toHaveLength(1);
            expect(listResult.tools[0]!.name).toBe('ping');

            const callResult = await client.callTool({ name: 'ping' });
            expect(callResult.content).toEqual([{ type: 'text', text: 'pong' }]);
        });
    });
});
