import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, ProtocolErrorCode } from '@modelcontextprotocol/core-internal';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('resources/read by the listed URI', () => {
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

    // Each URI is one that `new URL()` serializes differently.
    for (const registered of [
        'https://example.com',
        'https://Example.com/docs',
        'https://example.com:443/docs',
        'file:///docs/a/../b.md'
    ]) {
        test(`reads ${registered} as listed`, async () => {
            const read = vi.fn(async (uri: URL) => ({ contents: [{ uri: uri.href, text: 'document' }] }));
            server.registerResource('docs', registered, {}, read);
            await connect();

            const { resources } = await client.listResources();
            expect(resources.map(resource => resource.uri)).toEqual([registered]);

            const result = await client.readResource({ uri: resources[0]!.uri });
            expect(result.contents).toEqual([expect.objectContaining({ text: 'document' })]);
            expect(read).toHaveBeenCalledOnce();
        });
    }

    test('still reads a resource by an equivalent URI that parses to its registered form', async () => {
        server.registerResource('docs', 'https://example.com/', {}, async uri => ({ contents: [{ uri: uri.href, text: 'document' }] }));
        await connect();

        const result = await client.readResource({ uri: 'https://example.com' });
        expect(result.contents).toEqual([expect.objectContaining({ text: 'document' })]);
    });

    test('prefers the resource registered under the exact requested URI', async () => {
        server.registerResource('bare', 'https://example.com', {}, async uri => ({ contents: [{ uri: uri.href, text: 'bare' }] }));
        server.registerResource('slash', 'https://example.com/', {}, async uri => ({ contents: [{ uri: uri.href, text: 'slash' }] }));
        await connect();

        const bare = await client.readResource({ uri: 'https://example.com' });
        const slash = await client.readResource({ uri: 'https://example.com/' });
        expect(bare.contents).toEqual([expect.objectContaining({ text: 'bare' })]);
        expect(slash.contents).toEqual([expect.objectContaining({ text: 'slash' })]);
    });

    test('rejects a disabled resource registered under the exact requested URI instead of reading its parsed-form twin', async () => {
        const bareRead = vi.fn(async (uri: URL) => ({ contents: [{ uri: uri.href, text: 'bare' }] }));
        const slashRead = vi.fn(async (uri: URL) => ({ contents: [{ uri: uri.href, text: 'slash' }] }));
        server.registerResource('bare', 'https://example.com', {}, bareRead).disable();
        server.registerResource('slash', 'https://example.com/', {}, slashRead);
        await connect();

        await expect(client.readResource({ uri: 'https://example.com' })).rejects.toMatchObject({
            code: ProtocolErrorCode.InvalidParams,
            message: expect.stringContaining('disabled')
        });
        expect(bareRead).not.toHaveBeenCalled();
        expect(slashRead).not.toHaveBeenCalled();
    });
});
