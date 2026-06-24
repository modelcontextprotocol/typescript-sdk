import type { Icon, JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';
import { McpServer, ResourceTemplate } from '../../src/index.js';

const ICONS: Icon[] = [
    { src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['48x48', '96x96'] },
    { src: 'https://example.com/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'], theme: 'dark' }
];

/**
 * Initializes a client<->server pair over in-memory transport, sends a single
 * request, and resolves with its `result` payload.
 */
async function initializeAndRequest(server: McpServer, request: { method: string; params?: unknown }): Promise<Record<string, unknown>> {
    const [client, srv] = InMemoryTransport.createLinkedPair();
    await server.connect(srv);
    await client.start();

    const responses: JSONRPCMessage[] = [];
    client.onmessage = m => responses.push(m);

    await client.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'c', version: '1.0.0' }
        }
    } as JSONRPCMessage);
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
    await client.send({ jsonrpc: '2.0', id: 2, ...request } as JSONRPCMessage);

    await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));
    const response = responses.find(r => 'id' in r && r.id === 2) as { result?: Record<string, unknown> };
    return response.result ?? {};
}

/** Returns the `result` of the `initialize` response (which carries `serverInfo`). */
async function getInitializeResult(server: McpServer): Promise<Record<string, unknown>> {
    const [client, srv] = InMemoryTransport.createLinkedPair();
    await server.connect(srv);
    await client.start();

    const responses: JSONRPCMessage[] = [];
    client.onmessage = m => responses.push(m);

    await client.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'c', version: '1.0.0' }
        }
    } as JSONRPCMessage);

    await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 1)).toBe(true));
    const response = responses.find(r => 'id' in r && r.id === 1) as { result?: Record<string, unknown> };
    return response.result ?? {};
}

describe('icons on high-level McpServer registration', () => {
    it('surfaces tool icons in tools/list', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        server.registerTool('iconic', { description: 'a tool with icons', icons: ICONS }, async () => ({
            content: [{ type: 'text' as const, text: 'ok' }]
        }));

        const result = await initializeAndRequest(server, { method: 'tools/list' });
        const tools = result.tools as Array<{ name: string; icons?: Icon[] }>;

        expect(tools[0]?.name).toBe('iconic');
        expect(tools[0]?.icons).toEqual(ICONS);

        await server.close();
    });

    it('surfaces prompt icons in prompts/list', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        server.registerPrompt('iconic', { description: 'a prompt with icons', icons: ICONS }, async () => ({
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }]
        }));

        const result = await initializeAndRequest(server, { method: 'prompts/list' });
        const prompts = result.prompts as Array<{ name: string; icons?: Icon[] }>;

        expect(prompts[0]?.name).toBe('iconic');
        expect(prompts[0]?.icons).toEqual(ICONS);

        await server.close();
    });

    it('reflects tool icons set via update() in tools/list', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        const tool = server.registerTool('iconic', { description: 'd' }, async () => ({
            content: [{ type: 'text' as const, text: 'ok' }]
        }));
        tool.update({ icons: ICONS });

        const result = await initializeAndRequest(server, { method: 'tools/list' });
        const tools = result.tools as Array<{ icons?: Icon[] }>;

        expect(tools[0]?.icons).toEqual(ICONS);

        await server.close();
    });

    it('reflects prompt icons set via update() in prompts/list', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        const prompt = server.registerPrompt('iconic', { description: 'd' }, async () => ({
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }]
        }));
        prompt.update({ icons: ICONS });

        const result = await initializeAndRequest(server, { method: 'prompts/list' });
        const prompts = result.prompts as Array<{ icons?: Icon[] }>;

        expect(prompts[0]?.icons).toEqual(ICONS);

        await server.close();
    });

    // Resources and resource templates already carry icons via their `metadata`
    // (ResourceMetadata = Omit<Resource, 'uri' | 'name'>, which includes `icons`).
    // These guard that pass-through against regressions.
    it('surfaces resource icons in resources/list', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        server.registerResource('res', 'file:///r', { description: 'a resource with icons', icons: ICONS }, async uri => ({
            contents: [{ uri: uri.href, text: 'x' }]
        }));

        const result = await initializeAndRequest(server, { method: 'resources/list' });
        const resources = result.resources as Array<{ uri: string; icons?: Icon[] }>;

        expect(resources[0]?.icons).toEqual(ICONS);

        await server.close();
    });

    it('surfaces resource template icons in resources/templates/list', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        server.registerResource(
            'tmpl',
            new ResourceTemplate('file:///{id}', { list: undefined }),
            { description: 'a template with icons', icons: ICONS },
            async uri => ({ contents: [{ uri: uri.href, text: 'x' }] })
        );

        const result = await initializeAndRequest(server, { method: 'resources/templates/list' });
        const templates = result.resourceTemplates as Array<{ name: string; icons?: Icon[] }>;

        expect(templates[0]?.icons).toEqual(ICONS);

        await server.close();
    });

    // Implementation (server info) already passes through verbatim into the
    // initialize result. Guard icons/websiteUrl/description against regressions.
    it('surfaces server icons, websiteUrl, and description in the initialize result', async () => {
        const server = new McpServer({
            name: 's',
            version: '1.0.0',
            title: 'Server',
            description: 'a server with metadata',
            websiteUrl: 'https://example.com',
            icons: ICONS
        });

        const result = await getInitializeResult(server);
        const serverInfo = result.serverInfo as {
            title?: string;
            description?: string;
            websiteUrl?: string;
            icons?: Icon[];
        };

        expect(serverInfo.title).toBe('Server');
        expect(serverInfo.description).toBe('a server with metadata');
        expect(serverInfo.websiteUrl).toBe('https://example.com');
        expect(serverInfo.icons).toEqual(ICONS);

        await server.close();
    });
});
