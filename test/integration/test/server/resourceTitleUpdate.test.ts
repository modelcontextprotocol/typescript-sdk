import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

describe('resource title updates', () => {
    let server: McpServer;
    let client: Client;

    beforeEach(() => {
        server = new McpServer({ name: 'test-server', version: '1' });
        client = new Client({ name: 'test-client', version: '1' });
    });

    afterEach(async () => {
        await client.close();
        await server.close();
    });

    async function connect() {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
    }

    async function list(kind: 'static' | 'template') {
        if (kind === 'static') {
            const result = await client.listResources(undefined, { cacheMode: 'bypass' });
            return result.resources;
        }
        const result = await client.listResourceTemplates(undefined, { cacheMode: 'bypass' });
        return result.resourceTemplates;
    }

    for (const kind of ['static', 'template'] as const) {
        for (const initialTitle of [undefined, 'Old title']) {
            test(`${kind}: advertises an updated title when the initial title is ${initialTitle}`, async () => {
                const target = kind === 'static' ? 'docs://one' : new ResourceTemplate('docs://{id}', { list: undefined });
                const metadata = { title: initialTitle, description: 'Keep this description', mimeType: 'text/plain' };
                const read = async (uri: URL) => ({ contents: [{ uri: uri.href, text: 'document' }] });
                const resource =
                    typeof target === 'string'
                        ? server.registerResource('docs', target, metadata, read)
                        : server.registerResource('docs', target, metadata, read);
                await connect();

                resource.update({ title: 'New title' });

                const entries = await list(kind);
                expect(entries).toEqual([expect.objectContaining({ ...metadata, title: 'New title' })]);
            });
        }

        test(`${kind}: keeps an explicit title update when replacing other metadata`, async () => {
            const read = async (uri: URL) => ({ contents: [{ uri: uri.href, text: 'document' }] });
            const resource =
                kind === 'static'
                    ? server.registerResource('docs', 'docs://one', { title: 'Old title' }, read)
                    : server.registerResource(
                          'docs',
                          new ResourceTemplate('docs://{id}', { list: undefined }),
                          { title: 'Old title' },
                          read
                      );
            await connect();

            resource.update({ title: 'New title', metadata: { description: 'New description' } });

            const entries = await list(kind);
            expect(entries).toEqual([expect.objectContaining({ title: 'New title', description: 'New description' })]);
        });
    }

    test('updates inherited template titles while preserving individual resource titles', async () => {
        const resource = server.registerResource(
            'docs',
            new ResourceTemplate('docs://{id}', {
                list: async () => ({
                    resources: [
                        { uri: 'docs://one', name: 'one' },
                        { uri: 'docs://two', name: 'two', title: 'Individual title' }
                    ]
                })
            }),
            { title: 'Old title', mimeType: 'text/plain' },
            async uri => ({ contents: [{ uri: uri.href, text: 'document' }] })
        );
        await connect();

        resource.update({ title: 'New title' });

        const { resources } = await client.listResources(undefined, { cacheMode: 'bypass' });
        expect(resources).toEqual([
            { uri: 'docs://one', name: 'one', title: 'New title', mimeType: 'text/plain' },
            { uri: 'docs://two', name: 'two', title: 'Individual title', mimeType: 'text/plain' }
        ]);
    });
});
