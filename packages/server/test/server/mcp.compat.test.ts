import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, isStandardSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '../../src/index';
import type { InferRawShape } from '../../src/server/mcp';
import { completable } from '../../src/server/completable';

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

describe('SEP-2106: registerTool with non-object outputSchema (type-level)', () => {
    it('accepts z.array(z.number()) as outputSchema and a number[] structuredContent compiles', () => {
        const server = new McpServer({ name: 's', version: '1' });
        server.registerTool('arr', { inputSchema: z.object({ n: z.number() }), outputSchema: z.array(z.number()) }, async ({ n }) => ({
            content: [],
            structuredContent: [n, n + 1] satisfies number[]
        }));
        // NOTE (SEP-2106 PR-B verification item): the OutputArgs generic on registerTool is
        // captured but does NOT currently flow into the callback's return type — ToolCallback's
        // SendResultT is `CallToolResult | InputRequiredResult` (structuredContent: unknown), so
        // a wrong-typed structuredContent ALSO compiles. Runtime validation (validateToolOutput)
        // is the guard. Tightening the generic is out of this commit's scope.
        server.registerTool('arr-loose', { outputSchema: z.array(z.number()) }, async () => ({
            content: [],
            structuredContent: 'not-an-array' // compiles: structuredContent is `unknown`
        }));
        expectTypeOf<number[]>().toMatchTypeOf<z.infer<ReturnType<typeof z.array<z.ZodNumber>>>>();
    });
});
