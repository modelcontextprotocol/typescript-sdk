import type { JSONRPCMessage, StandardSchemaWithJSON } from '@modelcontextprotocol/core';
import { InMemoryTransport, isStandardSchema, LATEST_PROTOCOL_VERSION, standardSchemaToJsonSchema } from '@modelcontextprotocol/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '../../src/index.js';
import type { InferRawShape } from '../../src/server/mcp.js';
import { completable } from '../../src/server/completable.js';

describe('registerTool/registerPrompt accept raw Zod shape (auto-wrapped)', () => {
    it('registerTool accepts a raw shape for inputSchema and auto-wraps it', () => {
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

    it('registerTool with z.object() inputSchema also works (passthrough, no auto-wrap)', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('c', { inputSchema: z.object({ x: z.number() }) }, async ({ x }) => ({
            content: [{ type: 'text' as const, text: String(x) }]
        }));

        const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
        expect(isStandardSchema(tools['c']?.inputSchema)).toBe(true);
    });

    it('registerPrompt accepts a raw shape for argsSchema', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerPrompt('p', { argsSchema: { topic: z.string() } }, async ({ topic }) => ({
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: topic } }]
        }));

        const prompts = (server as unknown as { _registeredPrompts: Record<string, { argsSchema?: unknown }> })._registeredPrompts;
        expect(Object.keys(prompts)).toContain('p');
        expect(isStandardSchema(prompts['p']?.argsSchema)).toBe(true);
    });

    it('registerPrompt raw shape accepts completable() fields (v1 pattern)', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerPrompt(
            'p',
            {
                argsSchema: {
                    language: completable(z.string(), v => ['typescript', 'python'].filter(l => l.startsWith(v)))
                }
            },
            async ({ language }) => ({
                messages: [{ role: 'user' as const, content: { type: 'text' as const, text: language } }]
            })
        );

        const prompts = (server as unknown as { _registeredPrompts: Record<string, { argsSchema?: unknown }> })._registeredPrompts;
        expect(isStandardSchema(prompts['p']?.argsSchema)).toBe(true);
    });

    it('callback receives validated, typed args end-to-end via tools/call', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        let received: { x: number } | undefined;
        server.registerTool('echo', { inputSchema: { x: z.number() } }, async args => {
            received = args;
            return { content: [{ type: 'text' as const, text: String(args.x) }] };
        });

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
            params: { name: 'echo', arguments: { x: 7 } }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        expect(received).toEqual({ x: 7 });
        const result = responses.find(r => 'id' in r && r.id === 2) as { result?: { content: Array<{ text: string }> } };
        expect(result.result?.content[0]?.text).toBe('7');

        await server.close();
    });
});

describe('InferRawShape', () => {
    it('preserves optionality from .optional() as ?: keys', () => {
        type S = InferRawShape<{ a: z.ZodString; b: z.ZodOptional<z.ZodString> }>;
        expectTypeOf<S>().toEqualTypeOf<{ a: string; b?: string | undefined }>();
    });
});

describe('McpServer.tool() legacy overload resolution', () => {
    it('treats a plain JSON Schema object as inputSchema (not ToolAnnotations)', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.tool(
            'my.tool',
            'A tool that requires a directory_id',
            {
                type: 'object',
                properties: {
                    directory_id: {
                        type: 'string',
                        format: 'uuid',
                        description: 'The UUID of the directory'
                    }
                },
                required: ['directory_id']
            },
            async (args: unknown) => ({
                content: [{ type: 'text' as const, text: JSON.stringify(args) }]
            })
        );

        const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
        expect(isStandardSchema(tools['my.tool']?.inputSchema)).toBe(true);
        const json = standardSchemaToJsonSchema(tools['my.tool']!.inputSchema as StandardSchemaWithJSON, 'input') as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(json.properties).toHaveProperty('directory_id');
        expect(json.required).toContain('directory_id');
    });

    it('still treats ToolAnnotations-only objects as annotations (empty wire input schema)', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        server.tool('annotated', 'desc', { title: 'Display title', readOnlyHint: true }, async () => ({
            content: [{ type: 'text' as const, text: 'ok' }]
        }));

        const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown; annotations?: unknown }> })
            ._registeredTools;
        expect(registered['annotated']?.annotations).toMatchObject({ title: 'Display title', readOnlyHint: true });
        expect(registered['annotated']?.inputSchema).toBeUndefined();

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
            method: 'tools/list',
            params: {}
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        const listed = responses.find(r => 'id' in r && r.id === 2) as {
            result?: { tools: Array<{ annotations?: unknown; inputSchema?: unknown }> };
        };
        expect(listed.result?.tools).toHaveLength(1);
        expect(listed.result?.tools[0]?.annotations).toMatchObject({ title: 'Display title', readOnlyHint: true });
        expect(listed.result?.tools[0]?.inputSchema).toEqual({
            type: 'object',
            properties: {}
        });

        await server.close();
    });

    it('throws when the positional object matches neither schema nor ToolAnnotations', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        expect(() =>
            server.tool('bad', 'desc', { notASchemaOrAnnotation: true }, async () => ({
                content: [{ type: 'text' as const, text: 'x' }]
            }))
        ).toThrow(TypeError);

        expect(() =>
            server.tool('bad2', 'desc', { title: 'x', extraKey: true }, async () => ({
                content: [{ type: 'text' as const, text: 'x' }]
            }))
        ).toThrow(TypeError);
    });

    it('passes validated arguments for plain JSON Schema tools end-to-end', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        let received: unknown;
        server.tool(
            'js',
            'uses json schema',
            {
                type: 'object',
                properties: { n: { type: 'number' } },
                required: ['n']
            },
            async (args: unknown) => {
                received = args;
                const { n } = args as { n: number };
                return { content: [{ type: 'text' as const, text: String(n) }] };
            }
        );

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
            params: { name: 'js', arguments: { n: 42 } }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        expect(received).toEqual({ n: 42 });
        const result = responses.find(r => 'id' in r && r.id === 2) as { result?: { content: Array<{ text?: string }> } };
        expect(result.result?.content[0]?.text).toBe('42');

        await server.close();
    });
});
