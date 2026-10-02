import type { StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import {
    CallToolResultSchema,
    GetPromptResultSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListToolsResultSchema,
    ReadResourceResultSchema
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { invoke } from '../../src/server/invoke';
import { McpServer, ResourceTemplate } from '../../src/server/mcp';

const LEGACY = { classification: { era: 'legacy' as const } };
const prototypeNames = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];

async function request(server: McpServer, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const response = await invoke(server, { jsonrpc: '2.0', id: 1, method, params }, LEGACY);
    return z.object({ result: z.unknown() }).parse(await response.json()).result;
}

describe('McpServer registry names', () => {
    it.each(prototypeNames)('registers, calls and removes a tool named %s', async name => {
        const server = new McpServer({ name: 'registry-names', version: '0' });
        const tool = server.registerTool(name, { inputSchema: z.object({ value: z.string() }) }, async ({ value }) => ({
            content: [{ type: 'text', text: value }]
        }));

        expect(() => server.registerTool(name, {}, async () => ({ content: [] }))).toThrow(`Tool ${name} is already registered`);
        const listed = ListToolsResultSchema.parse(await request(server, 'tools/list'));
        expect(listed.tools.map(tool => tool.name)).toEqual([name]);
        const called = CallToolResultSchema.parse(await request(server, 'tools/call', { name, arguments: { value: 'ok' } }));
        expect(called.content).toEqual([{ type: 'text', text: 'ok' }]);

        tool.remove();
        expect(ListToolsResultSchema.parse(await request(server, 'tools/list')).tools).toEqual([]);
    });

    it.each(prototypeNames)('registers and gets a prompt named %s', async name => {
        const server = new McpServer({ name: 'registry-names', version: '0' });
        server.registerPrompt(name, {}, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'ok' } }] }));

        expect(() => server.registerPrompt(name, {}, async () => ({ messages: [] }))).toThrow(`Prompt ${name} is already registered`);
        expect(ListPromptsResultSchema.parse(await request(server, 'prompts/list')).prompts.map(prompt => prompt.name)).toEqual([name]);
        expect(GetPromptResultSchema.parse(await request(server, 'prompts/get', { name })).messages).toEqual([
            { role: 'user', content: { type: 'text', text: 'ok' } }
        ]);
    });

    it.each(prototypeNames)('registers and reads a resource template named %s', async name => {
        const server = new McpServer({ name: 'registry-names', version: '0' });
        const template = new ResourceTemplate(`mem://resource/${name}/{id}`, { list: undefined });
        server.registerResource(name, template, {}, async uri => ({ contents: [{ uri: uri.href, text: 'ok' }] }));

        expect(
            ListResourceTemplatesResultSchema.parse(await request(server, 'resources/templates/list')).resourceTemplates.map(
                template => template.name
            )
        ).toEqual([name]);
        const uri = `mem://resource/${name}/value`;
        expect(ReadResourceResultSchema.parse(await request(server, 'resources/read', { uri })).contents).toEqual([{ uri, text: 'ok' }]);
        expect(ListResourcesResultSchema.parse(await request(server, 'resources/list')).resources).toEqual([]);
    });

    it('keeps a tool renamed to __proto__ in the list and removes it', async () => {
        const server = new McpServer({ name: 'registry-names', version: '0' });
        const tool = server.registerTool('original', {}, async () => ({ content: [{ type: 'text', text: 'renamed' }] }));

        tool.update({ name: '__proto__' });
        expect(ListToolsResultSchema.parse(await request(server, 'tools/list')).tools.map(tool => tool.name)).toEqual(['__proto__']);
        expect(CallToolResultSchema.parse(await request(server, 'tools/call', { name: '__proto__' })).content).toEqual([
            { type: 'text', text: 'renamed' }
        ]);
        tool.remove();
        expect(ListToolsResultSchema.parse(await request(server, 'tools/list')).tools).toEqual([]);
    });

    it('reuses and invalidates the input schema cache for a tool named __proto__', () => {
        const server = new McpServer({ name: 'registry-names', version: '0' });
        let conversions = 0;
        const schema: StandardSchemaWithJSON = {
            '~standard': {
                version: 1,
                vendor: 'counting',
                validate: value => ({ value }),
                jsonSchema: {
                    input: () => {
                        conversions++;
                        return { type: 'object', properties: { value: { type: 'string' } } };
                    },
                    output: () => ({ type: 'object' })
                }
            }
        };
        const tool = server.registerTool('__proto__', { inputSchema: schema }, async () => ({ content: [] }));

        const first = server.toolInputSchemaJson('__proto__');
        expect(first).toEqual({ type: 'object', properties: { value: { type: 'string' } } });
        expect(server.toolInputSchemaJson('__proto__')).toEqual(first);
        expect(conversions).toBe(1);

        tool.update({ paramsSchema: schema });
        expect(server.toolInputSchemaJson('__proto__')).toEqual(first);
        expect(conversions).toBe(2);

        tool.remove();
        expect(server.toolInputSchemaJson('__proto__')).toBeUndefined();
    });
});
