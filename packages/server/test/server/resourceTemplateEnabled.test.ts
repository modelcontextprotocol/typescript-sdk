/**
 * Resource templates must honour `enabled` like every other primitive.
 *
 * The `mcpserver:handle:enable-disable` requirement says `disable()` removes the
 * item from list results and calling/reading it errors. Tools, prompts and static
 * resources implement that; resource templates registered `enabled` but never read
 * it, so a disabled template stayed listed, readable and completable.
 */
import { describe, expect, it } from 'vitest';

import { invoke } from '../../src/server/invoke';
import { McpServer, ResourceTemplate } from '../../src/server/mcp';

const LEGACY = { classification: { era: 'legacy' as const } };

const call = async (server: McpServer, method: string, params: Record<string, unknown> = {}) => {
    const response = await invoke(server, { jsonrpc: '2.0', id: 1, method, params }, LEGACY);
    return (await response.json()) as { result?: any; error?: { message: string } };
};

const makeServer = () => {
    const server = new McpServer({ name: 'test', version: '0' });
    const template = server.registerResource(
        'secret',
        new ResourceTemplate('secret://{id}', {
            list: async () => ({ resources: [{ name: 'alpha', uri: 'secret://alpha' }] }),
            complete: { id: async () => ['alpha', 'beta'] }
        }),
        {},
        async (uri, variables) => ({ contents: [{ uri: uri.toString(), text: `SECRET ${variables.id}` }] })
    );
    return { server, template };
};

const completeId = (server: McpServer) =>
    call(server, 'completion/complete', {
        ref: { type: 'ref/resource', uri: 'secret://{id}' },
        argument: { name: 'id', value: '' }
    });

describe('resource template enabled', () => {
    it('drops a disabled template from resources/list', async () => {
        const { server, template } = makeServer();
        template.disable();

        const listed = await call(server, 'resources/list');

        expect(listed.result.resources).toEqual([]);
    });

    it('drops a disabled template from resources/templates/list', async () => {
        const { server, template } = makeServer();
        template.disable();

        const templates = await call(server, 'resources/templates/list');

        expect(templates.result.resourceTemplates).toEqual([]);
    });

    it('rejects a read that matches a disabled template', async () => {
        const { server, template } = makeServer();
        template.disable();

        const read = await call(server, 'resources/read', { uri: 'secret://alpha' });

        expect(read.result).toBeUndefined();
        expect(read.error?.message).toContain('disabled');
    });

    it('rejects completion for a disabled template', async () => {
        const { server, template } = makeServer();
        template.disable();

        const completion = await completeId(server);

        expect(completion.result).toBeUndefined();
        expect(completion.error?.message).toContain('disabled');
    });

    it('does not fall through to a later template that matches the same uri', async () => {
        const { server, template } = makeServer();
        server.registerResource('fallback', new ResourceTemplate('secret://{name}', { list: undefined }), {}, async uri => ({
            contents: [{ uri: uri.toString(), text: 'FALLBACK' }]
        }));
        template.disable();

        const read = await call(server, 'resources/read', { uri: 'secret://alpha' });

        expect(read.result).toBeUndefined();
        expect(read.error?.message).toContain('disabled');
    });

    it('restores the template on enable()', async () => {
        const { server, template } = makeServer();
        template.disable();
        template.enable();

        const listed = await call(server, 'resources/list');
        const templates = await call(server, 'resources/templates/list');
        const read = await call(server, 'resources/read', { uri: 'secret://alpha' });
        const completion = await completeId(server);

        expect(listed.result.resources.map((resource: { uri: string }) => resource.uri)).toEqual(['secret://alpha']);
        expect(templates.result.resourceTemplates).toHaveLength(1);
        expect(read.result.contents[0].text).toBe('SECRET alpha');
        expect(completion.result.completion.values).toEqual(['alpha', 'beta']);
    });
});
