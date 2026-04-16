/* eslint-disable @typescript-eslint/no-deprecated */
import * as z from 'zod/v4';
import { McpServer, ResourceTemplate } from '../../src/server/mcp.js';

describe('McpServer v1-compat variadic shims', () => {
    describe('.tool()', () => {
        it('registers with raw-shape schema', () => {
            const server = new McpServer({ name: 't', version: '1' });

            server.tool('x', { a: z.string() }, ({ a }) => ({ content: [{ type: 'text', text: a }] }));
            server.tool('y', { b: z.number() }, ({ b }) => ({ content: [{ type: 'text', text: String(b) }] }));

            // @ts-expect-error private access for test
            expect(server._registeredTools['x']).toBeDefined();
            // @ts-expect-error private access for test
            expect(server._registeredTools['y']).toBeDefined();
        });

        it('supports (name, description, paramsSchema, annotations, cb) overload', () => {
            const server = new McpServer({ name: 't', version: '1' });

            const reg = server.tool('x', 'desc', { a: z.string() }, { readOnlyHint: true }, ({ a }) => ({
                content: [{ type: 'text', text: a }]
            }));

            expect(reg.description).toBe('desc');
            expect(reg.annotations).toEqual({ readOnlyHint: true });
            expect(reg.inputSchema).toBeDefined();
        });

        it('supports (name, cb) zero-arg overload', () => {
            const server = new McpServer({ name: 't', version: '1' });
            const reg = server.tool('x', () => ({ content: [{ type: 'text', text: 'ok' }] }));
            expect(reg.inputSchema).toBeUndefined();
        });

        it('treats empty object as raw shape, not annotations (matches v1)', () => {
            const server = new McpServer({ name: 't', version: '1' });
            const reg = server.tool('x', {}, () => ({ content: [{ type: 'text', text: 'ok' }] }));
            expect(reg.inputSchema).toBeDefined();
            expect(reg.annotations).toBeUndefined();
        });
    });

    describe('.prompt()', () => {
        it('registers with raw-shape argsSchema', () => {
            const server = new McpServer({ name: 't', version: '1' });

            server.prompt('p1', { topic: z.string() }, ({ topic }) => ({
                messages: [{ role: 'user', content: { type: 'text', text: topic } }]
            }));
            server.prompt('p2', () => ({ messages: [] }));

            // @ts-expect-error private access for test
            expect(server._registeredPrompts['p1']).toBeDefined();
            // @ts-expect-error private access for test
            expect(server._registeredPrompts['p2']).toBeDefined();
        });
    });

    describe('.resource()', () => {
        it('forwards to registerResource for both string URIs and ResourceTemplates', () => {
            const server = new McpServer({ name: 't', version: '1' });

            server.resource('r1', 'file:///a', () => ({ contents: [] }));
            server.resource('r2', new ResourceTemplate('file:///{id}', { list: undefined }), () => ({ contents: [] }));

            // @ts-expect-error private access for test
            expect(server._registeredResources['file:///a']).toBeDefined();
            // @ts-expect-error private access for test
            expect(server._registeredResourceTemplates['r2']).toBeDefined();
        });
    });
});
