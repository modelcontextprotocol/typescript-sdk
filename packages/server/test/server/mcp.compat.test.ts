/* eslint-disable @typescript-eslint/no-deprecated */
import { isStandardSchema } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';
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

describe('registerTool/registerPrompt accept raw Zod shape (auto-wrapped)', () => {
    it('registerTool accepts a raw shape for inputSchema, auto-wraps, and does not warn', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('a', { inputSchema: { x: z.number() } }, async ({ x }) => ({
            content: [{ type: 'text' as const, text: String(x) }]
        }));
        server.registerTool('b', { inputSchema: { y: z.number() } }, async ({ y }) => ({
            content: [{ type: 'text' as const, text: String(y) }]
        }));

        const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
        expect(Object.keys(tools)).toEqual(['a', 'b']);
        // raw shape was wrapped into a Standard Schema (z.object)
        expect(isStandardSchema(tools['a']?.inputSchema)).toBe(true);

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('registerTool accepts a raw shape for outputSchema and auto-wraps it', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('out', { inputSchema: { n: z.number() }, outputSchema: { result: z.string() } }, async ({ n }) => ({
            content: [{ type: 'text' as const, text: String(n) }],
            structuredContent: { result: String(n) }
        }));

        const tools = (server as unknown as { _registeredTools: Record<string, { outputSchema?: unknown }> })._registeredTools;
        expect(isStandardSchema(tools['out']?.outputSchema)).toBe(true);
    });

    it('registerTool with z.object() inputSchema also works without warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('c', { inputSchema: z.object({ x: z.number() }) }, async ({ x }) => ({
            content: [{ type: 'text' as const, text: String(x) }]
        }));

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('registerPrompt accepts a raw shape for argsSchema and does not warn', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerPrompt('p', { argsSchema: { topic: z.string() } }, async ({ topic }) => ({
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: topic } }]
        }));

        const prompts = (server as unknown as { _registeredPrompts: Record<string, { argsSchema?: unknown }> })._registeredPrompts;
        expect(Object.keys(prompts)).toContain('p');
        expect(isStandardSchema(prompts['p']?.argsSchema)).toBe(true);

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});
