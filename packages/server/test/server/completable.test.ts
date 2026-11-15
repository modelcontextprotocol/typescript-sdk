import * as z from 'zod/v4';
import { describe, expect, it } from 'vitest';

import { completable, getCompleter } from '../../src/server/completable';
import { McpServer, ResourceTemplate } from '../../src/server/mcp';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

describe('completable with Zod v4', () => {
    it('preserves types and values of underlying schema', () => {
        const baseSchema = z.string();
        const schema = completable(baseSchema, () => []);

        expect(schema.parse('test')).toBe('test');
        expect(() => schema.parse(123)).toThrow();
    });

    it('provides access to completion function', async () => {
        const completions = ['foo', 'bar', 'baz'];
        const schema = completable(z.string(), () => completions);

        const completer = getCompleter(schema);
        expect(completer).toBeDefined();
        expect(await completer!('')).toEqual(completions);
    });

    it('allows async completion functions', async () => {
        const completions = ['foo', 'bar', 'baz'];
        const schema = completable(z.string(), async () => completions);

        const completer = getCompleter(schema);
        expect(completer).toBeDefined();
        expect(await completer!('')).toEqual(completions);
    });

    it('passes current value to completion function', async () => {
        const schema = completable(z.string(), value => [value + '!']);

        const completer = getCompleter(schema);
        expect(completer).toBeDefined();
        expect(await completer!('test')).toEqual(['test!']);
    });

    it('works with number schemas', async () => {
        const schema = completable(z.number(), () => [1, 2, 3]);

        expect(schema.parse(1)).toBe(1);
        const completer = getCompleter(schema);
        expect(completer).toBeDefined();
        expect(await completer!(0)).toEqual([1, 2, 3]);
    });

    it('preserves schema description', () => {
        const desc = 'test description';
        const schema = completable(z.string().describe(desc), () => []);

        expect(schema.description).toBe(desc);
    });
});

it.each(['prompt', 'resource'] as const)('serves completion added by a %s update before connecting', async kind => {
    const server = new McpServer({ name: 'completion-update', version: '1.0.0' });
    const complete = (value: string) => ['typescript', 'python'].filter(language => language.startsWith(value));
    const update = (() => {
        if (kind === 'prompt') {
            const prompt = server.registerPrompt('language', { argsSchema: z.object({ language: z.string() }) }, () => ({ messages: [] }));
            return () => prompt.update({ argsSchema: z.object({ language: completable(z.string(), complete) }) });
        }
        const resource = server.registerResource(
            'language',
            new ResourceTemplate('language:///{language}', { list: undefined }),
            {},
            () => ({ contents: [] })
        );
        return () =>
            resource.update({
                template: new ResourceTemplate('language:///{language}', { list: undefined, complete: { language: complete } })
            });
    })();
    update();
    const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: () => 'completion-session'
    });
    const headers = new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25'
    });
    const request = (id: number, method: string, params: Record<string, unknown>) =>
        transport.handleRequest(
            new Request('http://localhost/mcp', {
                method: 'POST',
                headers,
                body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
            })
        );
    await server.connect(transport);
    try {
        update();
        const initialization = await request(1, 'initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'client', version: '1.0.0' }
        });
        headers.set('mcp-session-id', initialization.headers.get('mcp-session-id')!);
        await transport.handleRequest(
            new Request('http://localhost/mcp', {
                method: 'POST',
                headers,
                body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
            })
        );
        const response = await request(2, 'completion/complete', {
            ref: kind === 'prompt' ? { type: 'ref/prompt', name: 'language' } : { type: 'ref/resource', uri: 'language:///{language}' },
            argument: { name: 'language', value: 'py' }
        });
        expect(await response.json()).toEqual({
            jsonrpc: '2.0',
            id: 2,
            result: { completion: { values: ['python'], total: 1, hasMore: false } }
        });
        expect(await initialization.json()).toMatchObject({ result: { capabilities: { completions: {} } } });
    } finally {
        await server.close();
    }
});

it.each(['prompt', 'resource'] as const)(
    'rejects the first %s completion update after connecting without changing its schema',
    async kind => {
        const server = new McpServer({ name: 'completion-update', version: '1.0.0' });
        const schema = z.object({ language: z.string() });
        const template = new ResourceTemplate('language:///{language}', { list: undefined });
        const prompt = server.registerPrompt('language', { argsSchema: schema }, () => ({ messages: [] }));
        const resource = server.registerResource('language', template, {}, () => ({ contents: [] }));
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        await server.connect(transport);
        try {
            const complete = () => ['python'];
            expect(() => {
                if (kind === 'prompt') {
                    prompt.update({ argsSchema: z.object({ language: completable(z.string(), complete) }) });
                } else {
                    resource.update({
                        template: new ResourceTemplate('language:///{language}', { list: undefined, complete: { language: complete } })
                    });
                }
            }).toThrow('Cannot register capabilities after connecting to transport');
            expect(prompt.argsSchema).toBe(schema);
            expect(resource.resourceTemplate).toBe(template);
            expect(server.server.getCapabilities().completions).toBeUndefined();
        } finally {
            await server.close();
        }
    }
);
