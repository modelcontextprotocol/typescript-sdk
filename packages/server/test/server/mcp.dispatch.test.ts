import { HandlerRegistry } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';
import { McpServer } from '../../src/index.js';

describe('McpServer registry and dispatch', () => {
    it('exposes a HandlerRegistry via .registry', () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        expect(server.registry).toBeInstanceOf(HandlerRegistry);
    });

    it('registered tools are visible in the shared registry', () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        server.registerTool('hello', { description: 'say hello' }, async () => ({
            content: [{ type: 'text', text: 'hello' }]
        }));
        expect(server.registry.hasRequestHandler('tools/call')).toBe(true);
        expect(server.registry.hasRequestHandler('tools/list')).toBe(true);
    });

    it('dispatch() invokes tools/list and returns result', async () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        server.registerTool('hello', { description: 'say hello' }, async () => ({
            content: [{ type: 'text', text: 'hello' }]
        }));

        const result = await server.dispatch('tools/list', {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {}
        });

        expect(result).toHaveProperty('tools');
        expect((result as { tools: unknown[] }).tools).toHaveLength(1);
        expect((result as { tools: Array<{ name: string }> }).tools[0]!.name).toBe('hello');
    });

    it('dispatch() invokes tools/call and returns result', async () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        server.registerTool('greet', { description: 'greet' }, async () => ({
            content: [{ type: 'text', text: 'hi' }]
        }));

        const result = await server.dispatch('tools/call', {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'greet' }
        });

        expect(result).toHaveProperty('content');
    });

    it('dispatch() throws for unregistered method', async () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        await expect(
            server.dispatch('nonexistent/method', {
                jsonrpc: '2.0',
                id: 1,
                method: 'nonexistent/method',
                params: {}
            })
        ).rejects.toThrow('Method not found');
    });

    it('registry is shared between McpServer and its underlying Server', () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        // Server registers the initialize handler in its constructor
        expect(server.registry.hasRequestHandler('initialize')).toBe(true);
    });
});
