/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/2723
 *
 * The `update` closure for prompts, resources and resource templates captured the
 * registration key and never reassigned it, so after a rename `remove()` deleted the
 * vacated key and left the live entry registered and callable. `RegisteredTool`
 * already reassigned its key; these three did not.
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';

describe('Issue #2723: remove() after rename is a no-op', () => {
    test('removes a prompt after it has been renamed', async () => {
        const server = new McpServer({ name: 'test', version: '1.0.0' });
        const prompt = server.registerPrompt('original', { description: 'x' }, async () => ({ messages: [] }));
        prompt.update({ name: 'renamed' });
        prompt.remove();

        const client = new Client({ name: 'client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.listPrompts();
        expect(result.prompts).toHaveLength(0);
    });

    test('removes a resource after it has been renamed', async () => {
        const server = new McpServer({ name: 'test', version: '1.0.0' });
        const resource = server.registerResource('test', 'test://original', {}, async () => ({ contents: [] }));
        resource.update({ uri: 'test://renamed' });
        resource.remove();

        const client = new Client({ name: 'client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.listResources();
        expect(result.resources).toHaveLength(0);
    });

    test('removes a resource template after it has been renamed', async () => {
        const server = new McpServer({ name: 'test', version: '1.0.0' });
        const template = server.registerResource('original', new ResourceTemplate('test://{id}', { list: undefined }), {}, async () => ({
            contents: []
        }));
        template.update({ name: 'renamed' });
        template.remove();

        const client = new Client({ name: 'client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.listResourceTemplates();
        expect(result.resourceTemplates).toHaveLength(0);
    });

    test('should remove a prompt that was renamed and renamed back', async () => {
        const server = new McpServer({ name: 'test', version: '1.0.0' });
        const prompt = server.registerPrompt('original', { description: 'x' }, async () => ({ messages: [] }));
        prompt.update({ name: 'renamed' });
        prompt.update({ name: 'original' });
        prompt.remove();

        const client = new Client({ name: 'client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.listPrompts();
        expect(result.prompts).toHaveLength(0);
    });
});
