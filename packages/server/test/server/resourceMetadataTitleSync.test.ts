import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import { McpServer, ResourceTemplate } from '../../src/index';

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
            clientInfo: { name: 'client', version: '1.0.0' }
        }
    } as JSONRPCMessage);
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
    await client.send({ jsonrpc: '2.0', id: 2, ...request } as JSONRPCMessage);

    await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));
    const response = responses.find(r => 'id' in r && r.id === 2) as { result?: Record<string, unknown> };
    return response.result ?? {};
}

describe('resource and template metadata title synchronization (#3103)', () => {
    it('syncs title and metadata.title on registered resource metadata updates', async () => {
        const server = new McpServer({ name: 'test-server', version: '1.0.0' });
        const resource = server.registerResource(
            'docs',
            'file:///docs',
            { title: 'Original Title', mimeType: 'text/markdown' },
            async () => ({ contents: [{ uri: 'file:///docs', text: 'docs' }] })
        );

        // 1. Initial list advertises title
        const listResult = (await initializeAndRequest(server, { method: 'resources/list' })) as {
            resources: Array<{ uri: string; title?: string; mimeType?: string }>;
        };
        expect(listResult.resources[0]?.title).toBe('Original Title');
        expect(resource.title).toBe('Original Title');

        // 2. Metadata update without title preserves existing title
        resource.update({ metadata: { mimeType: 'text/plain' } });
        expect(resource.title).toBe('Original Title');
        expect(resource.metadata?.title).toBe('Original Title');
        expect(resource.metadata?.mimeType).toBe('text/plain');

        // 3. Metadata update with a new title syncs to resource.title
        resource.update({ metadata: { title: 'Updated via Metadata', mimeType: 'application/json' } });
        expect(resource.title).toBe('Updated via Metadata');
        expect(resource.metadata?.title).toBe('Updated via Metadata');

        // 4. Explicit title update updates both
        resource.update({ title: 'Direct Title' });
        expect(resource.title).toBe('Direct Title');
        expect(resource.metadata?.title).toBe('Direct Title');
    });

    it('syncs title and metadata.title on registered resource template metadata updates', async () => {
        const server = new McpServer({ name: 'test-server', version: '1.0.0' });
        const template = server.registerResource(
            'items',
            new ResourceTemplate('items://{id}', { list: undefined }),
            { title: 'Template Original', mimeType: 'text/plain' },
            async () => ({ contents: [] })
        );

        // 1. Initial templates list advertises title
        const listResult = (await initializeAndRequest(server, { method: 'resources/templates/list' })) as {
            resourceTemplates: Array<{ name: string; title?: string }>;
        };
        expect(listResult.resourceTemplates[0]?.title).toBe('Template Original');
        expect(template.title).toBe('Template Original');

        // 2. Metadata update without title preserves existing title
        template.update({ metadata: { mimeType: 'application/octet-stream' } });
        expect(template.title).toBe('Template Original');
        expect(template.metadata?.title).toBe('Template Original');

        // 3. Metadata update with a new title syncs to template.title
        template.update({ metadata: { title: 'Template via Metadata' } });
        expect(template.title).toBe('Template via Metadata');
        expect(template.metadata?.title).toBe('Template via Metadata');

        // 4. Explicit title update updates both
        template.update({ title: 'Template Direct' });
        expect(template.title).toBe('Template Direct');
        expect(template.metadata?.title).toBe('Template Direct');
    });
});
