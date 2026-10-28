/**
 * A registered resource or template keeps advertising its title after a
 * metadata-only update.
 *
 * `title` reaches the wire through `resources/list` and `resources/templates/list`,
 * which spread the registered metadata. Registration stores the title in two places
 * (the handle and the metadata carrier), but `update({ metadata })` replaces the
 * carrier wholesale, so a metadata-only update used to drop the advertised title
 * even though the handle still held it. Both read paths now derive the field, with
 * metadata winning when it carries one and the handle value as the fallback.
 */
import { describe, expect, it } from 'vitest';

import { invoke } from '../../src/server/invoke';
import { McpServer, ResourceTemplate } from '../../src/server/mcp';

const LEGACY = { classification: { era: 'legacy' as const } };

const listOf = async (server: McpServer, method: string, key: string): Promise<Array<Record<string, unknown>>> => {
    const response = await invoke(server, { jsonrpc: '2.0', id: 1, method, params: {} }, LEGACY);
    const body = (await response.json()) as { result: Record<string, Array<Record<string, unknown>>> };
    return body.result[key]!;
};

describe('resource title survives a metadata-only update', () => {
    it('resources/list keeps the title after update({ metadata }) and honours a later update({ title })', async () => {
        const server = new McpServer({ name: 'titles', version: '0' });
        const handle = server.registerResource('docs', 'mem://docs', { title: 'Docs', mimeType: 'text/markdown' }, async () => ({
            contents: []
        }));

        const [registered] = await listOf(server, 'resources/list', 'resources');
        expect(registered).toMatchObject({ uri: 'mem://docs', name: 'docs', title: 'Docs' });

        handle.update({ metadata: { mimeType: 'text/markdown', description: 'docs' } });
        const [afterMetadataUpdate] = await listOf(server, 'resources/list', 'resources');
        expect(afterMetadataUpdate).toMatchObject({ uri: 'mem://docs', name: 'docs', title: 'Docs' });
        expect(afterMetadataUpdate).toMatchObject({ description: 'docs' });

        handle.update({ title: 'Renamed' });
        const [afterTitleUpdate] = await listOf(server, 'resources/list', 'resources');
        expect(afterTitleUpdate).toMatchObject({ title: 'Renamed' });
    });

    it('resources/templates/list keeps the title after update({ metadata }) and honours a later update({ title })', async () => {
        const server = new McpServer({ name: 'titles', version: '0' });
        const handle = server.registerResource(
            'thing',
            new ResourceTemplate('mem://things/{id}', { list: undefined }),
            { title: 'Thing', mimeType: 'text/plain' },
            async () => ({ contents: [] })
        );

        const [registered] = await listOf(server, 'resources/templates/list', 'resourceTemplates');
        expect(registered).toMatchObject({ name: 'thing', title: 'Thing' });

        handle.update({ metadata: { mimeType: 'text/plain', description: 'things' } });
        const [afterMetadataUpdate] = await listOf(server, 'resources/templates/list', 'resourceTemplates');
        expect(afterMetadataUpdate).toMatchObject({ name: 'thing', title: 'Thing' });

        handle.update({ title: 'Renamed thing' });
        const [afterTitleUpdate] = await listOf(server, 'resources/templates/list', 'resourceTemplates');
        expect(afterTitleUpdate).toMatchObject({ title: 'Renamed thing' });
    });

    it('a template registered with a title still titles its listed instances after a metadata-only update', async () => {
        const server = new McpServer({ name: 'titles', version: '0' });
        const template = new ResourceTemplate('mem://items/{id}', {
            list: async () => ({ resources: [{ uri: 'mem://items/1', name: 'one' }] })
        });
        const handle = server.registerResource('item', template, { title: 'Item' }, async () => ({ contents: [] }));

        const [listed] = await listOf(server, 'resources/list', 'resources');
        expect(listed).toMatchObject({ uri: 'mem://items/1', name: 'one', title: 'Item' });

        handle.update({ metadata: {} });
        const [afterMetadataUpdate] = await listOf(server, 'resources/list', 'resources');
        expect(afterMetadataUpdate).toMatchObject({ uri: 'mem://items/1', title: 'Item' });
    });

    it('metadata still wins when it carries its own title', async () => {
        const server = new McpServer({ name: 'titles', version: '0' });
        const handle = server.registerResource('docs', 'mem://docs', { title: 'Docs' }, async () => ({ contents: [] }));

        handle.update({ metadata: { title: 'From metadata' } });
        const [listed] = await listOf(server, 'resources/list', 'resources');
        expect(listed).toMatchObject({ title: 'From metadata' });
    });
});
