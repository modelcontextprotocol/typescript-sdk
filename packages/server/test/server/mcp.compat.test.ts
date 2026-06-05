import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, isStandardSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
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

// SEP-2106 / R-2106-3: when a tool declares an `outputSchema`, `registerTool` infers it as the
// `Output` type param so the handler's returned `structuredContent` is checked against the schema's
// inferred output at compile time. These cases pin that contract: correct shapes compile, wrong
// shapes fail to type-check (guarded by @ts-expect-error so a regression that loosens the typing
// turns these into compile errors). Type-only — registration side effects are covered above.
describe('registerTool compile-time outputSchema typing (SEP-2106)', () => {
    it('accepts structuredContent matching a Standard Schema outputSchema', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('bmi', { outputSchema: z.object({ bmi: z.number() }) }, async () => ({
            content: [{ type: 'text' as const, text: '22.9' }],
            structuredContent: { bmi: 22.9 }
        }));
    });

    it('rejects structuredContent that does not match the outputSchema', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        // The return-type mismatch surfaces at the registerTool call (the handler's return type is
        // contextually checked against ToolResultFor<Output>), so the directive sits on this line.
        // @ts-expect-error - bmi must be a number, not a string
        server.registerTool('bmi', { outputSchema: z.object({ bmi: z.number() }) }, async () => ({
            content: [{ type: 'text' as const, text: 'x' }],
            structuredContent: { bmi: 'not-a-number' }
        }));
    });

    it('allows omitting structuredContent at compile time (the MUST-return rule is runtime-enforced)', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        // CallToolResultWithStructuredContent<T> types structuredContent as optional (`?: T`), so a
        // handler that omits it still compiles. The "outputSchema implies structuredContent" rule is
        // enforced at runtime by validateToolOutput (covered in client/server runtime tests), not by
        // the type system — this documents and pins that boundary.
        server.registerTool('bmi', { outputSchema: z.object({ bmi: z.number() }) }, async () => ({
            content: [{ type: 'text' as const, text: 'x' }]
        }));
    });

    it('supports a non-object (array) outputSchema per SEP-2106', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('forecast', { outputSchema: z.array(z.object({ temp: z.number() })) }, async () => ({
            content: [{ type: 'text' as const, text: '[]' }],
            structuredContent: [{ temp: 1 }]
        }));
    });

    it('allows any JSON value in structuredContent when no outputSchema is declared', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('free', {}, async () => ({
            content: [{ type: 'text' as const, text: '42' }],
            structuredContent: 42
        }));
    });
});
