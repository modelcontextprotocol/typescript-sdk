import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import { McpServer, ResourceTemplate } from '../../src/index.js';

/**
 * Names that are inherited as own properties of Object.prototype. Indexing a
 * plain `{}` registry by these names finds the inherited member, so
 * registerTool/Prompt/Resource treat an empty server as already registered.
 */
const PROTOTYPE_NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'] as const;

describe('McpServer registries ignore Object.prototype names', () => {
    it.each(PROTOTYPE_NAMES)('registerTool accepts %s on an empty server', name => {
        const server = new McpServer({ name: 'r', version: '0' });
        expect(() =>
            server.registerTool(name, { description: 'x' }, async () => ({ content: [{ type: 'text', text: name }] }))
        ).not.toThrow();
    });

    it.each(PROTOTYPE_NAMES)('registerPrompt accepts %s on an empty server', name => {
        const server = new McpServer({ name: 'r', version: '0' });
        expect(() =>
            server.registerPrompt(name, { description: 'x' }, async () => ({
                messages: [{ role: 'user' as const, content: { type: 'text' as const, text: name } }]
            }))
        ).not.toThrow();
    });

    it.each(PROTOTYPE_NAMES)('registerResource template accepts %s on an empty server', name => {
        const server = new McpServer({ name: 'r', version: '0' });
        const template = new ResourceTemplate('proto://{id}', { list: undefined });
        expect(() =>
            server.registerResource(name, template, { description: 'x' }, async uri => ({
                contents: [{ uri: uri.href, text: name }]
            }))
        ).not.toThrow();
    });

    it('lists and calls a tool whose name is inherited from Object.prototype', async () => {
        const server = new McpServer({ name: 'r', version: '0' });
        server.registerTool('constructor', { description: 'x' }, async () => ({
            content: [{ type: 'text', text: 'from-constructor' }]
        }));

        const [client, srv] = InMemoryTransport.createLinkedPair();
        await server.connect(srv);
        await client.start();

        const responses: JSONRPCMessage[] = [];
        client.onmessage = m => responses.push(m);

        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'c', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' } as JSONRPCMessage);
        await client.send({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'constructor', arguments: {} }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 3)).toBe(true));
        const listed = responses.find(r => 'id' in r && r.id === 2) as { result?: { tools: Array<{ name: string }> } };
        expect(listed.result?.tools.map(t => t.name)).toContain('constructor');

        const called = responses.find(r => 'id' in r && r.id === 3) as {
            result?: { content: Array<{ type: string; text?: string }> };
            error?: unknown;
        };
        expect(called.error).toBeUndefined();
        expect(called.result?.content?.[0]?.text).toBe('from-constructor');

        await server.close();
    });

    it('calling an unregistered prototype-named tool returns not found, not disabled', async () => {
        // With a plain `{}` registry, `_registeredTools['toString']` resolves to
        // Object.prototype.toString (truthy but without `.enabled`), so tools/call
        // used to answer "Tool toString disabled". Null-prototype maps make it
        // correctly answer "not found".
        // Register an unrelated tool so tools/call handlers are installed (lazy).
        const server = new McpServer({ name: 'r', version: '0' });
        server.registerTool('hello', { description: 'x' }, async () => ({
            content: [{ type: 'text', text: 'hi' }]
        }));

        const [client, srv] = InMemoryTransport.createLinkedPair();
        await server.connect(srv);
        await client.start();

        const responses: JSONRPCMessage[] = [];
        client.onmessage = m => responses.push(m);

        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'c', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
        await client.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'toString', arguments: {} }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));
        const called = responses.find(r => 'id' in r && r.id === 2) as {
            error?: { message?: string };
        };
        expect(called.error?.message).toMatch(/Tool toString not found/);
        expect(called.error?.message).not.toMatch(/disabled/);

        await server.close();
    });

    it('still rejects a true duplicate registration', () => {
        const server = new McpServer({ name: 'r', version: '0' });
        server.registerTool('constructor', { description: 'x' }, async () => ({ content: [] }));
        expect(() => server.registerTool('constructor', { description: 'y' }, async () => ({ content: [] }))).toThrow(/already registered/);
    });
});
