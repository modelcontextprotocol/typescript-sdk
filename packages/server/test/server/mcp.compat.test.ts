import { isStandardSchema } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '../../src/index.js';

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
