import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    isStandardSchema,
    LATEST_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core-internal';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { invoke } from '../../src/server/invoke';
import { McpServer } from '../../src/index';

const MODERN_REVISION = '2026-07-28';
const MODERN_ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'c', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};
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

describe('a tool handler may omit content (#2755)', () => {
    // The spec makes the serialized-JSON TextContent block a SHOULD for a tool
    // that returns structured content, not a MUST. The runtime already agrees:
    // `normalizeContentlessToolResult` turns a content-less handler result into
    // `content: []` before era validation, and `isSpecType.CallToolResult({})`
    // is documented as true because the schema defaults `content`. Only the
    // callback's return type disagreed.
    it('compiles without content, for object and non-object output schemas alike', () => {
        const server = new McpServer({ name: 's', version: '1' });
        server.registerTool('obj', { outputSchema: z.object({ a: z.number() }) }, async () => ({
            structuredContent: { a: 1 }
        }));
        // The reporter's case: a string outputSchema, no hand-written content.
        server.registerTool('str', { outputSchema: z.string() }, async () => ({
            structuredContent: `Pong at ${new Date().toISOString()}`
        }));
        // Nothing at all is a result too — a tool that only performs an effect.
        server.registerTool('none', {}, async () => ({}));
        expect(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)).toEqual([
            'obj',
            'str',
            'none'
        ]);
    });

    it('compiles on BOTH registerTool overloads', () => {
        // registerTool is overloaded, and the three registrations above bind to
        // whichever overload still accepts a content-less return — so reverting
        // one callback type alone would fall through to the other and nothing
        // would fail. These two can each bind only one: a Standard Schema
        // inputSchema selects ToolCallback, a raw Zod shape selects
        // LegacyToolCallback.
        const server = new McpServer({ name: 's', version: '1' });
        server.registerTool(
            'modern',
            { inputSchema: z.object({ x: z.number() }), outputSchema: z.object({ a: z.number() }) },
            async () => ({ structuredContent: { a: 1 } })
        );
        server.registerTool('legacy', { inputSchema: { x: z.number() }, outputSchema: { a: z.number() } }, async () => ({
            structuredContent: { a: 1 }
        }));
        expect(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)).toEqual([
            'modern',
            'legacy'
        ]);
    });

    it('still rejects a wrongly typed content or isError', () => {
        const server = new McpServer({ name: 's', version: '1' });
        // @ts-expect-error content, when supplied, is still a ContentBlock array
        server.registerTool('bad-content', {}, async () => ({ content: 'nope' }));
        // @ts-expect-error isError is still a boolean
        server.registerTool('bad-error', {}, async () => ({ isError: 'yes' }));
        expect(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)).toEqual([
            'bad-content',
            'bad-error'
        ]);
    });

    it('puts content on the wire on the 2026-07-28 era, where the schema has no default', async () => {
        // The era that matters most. On 2025-11-25 the wire schema still
        // defaults `content`, so a regression there would be masked; the
        // 2026-07-28 wire schema declares `content: z.array(ContentBlockSchema)`
        // with no default and no wire-seam guard, which makes the server-side
        // normalization the only thing supplying it.
        const server = new McpServer({ name: 's', version: '1' });
        server.registerTool('obj', { outputSchema: z.object({ a: z.number() }) }, async () => ({
            structuredContent: { a: 1 }
        }));
        setNegotiatedProtocolVersion(server.server, MODERN_REVISION);

        const response = await invoke(
            server,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'obj', arguments: {}, _meta: MODERN_ENVELOPE }
            } as JSONRPCRequest,
            { classification: { era: 'modern', revision: MODERN_REVISION } }
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result?: { content?: unknown; structuredContent?: unknown } };
        expect(body.result?.content).toEqual([]);
        expect(body.result?.structuredContent).toEqual({ a: 1 });
    });

    it('puts content on the wire even though the handler wrote none', async () => {
        // The type change alone would be worth nothing if the omission then
        // shipped a result without `content`, which the wire schema requires.
        const server = new McpServer({ name: 's', version: '1' });
        server.registerTool('obj', { outputSchema: z.object({ a: z.number() }) }, async () => ({
            structuredContent: { a: 1 }
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
            params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '1.0.0' } }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'obj', arguments: {} } } as JSONRPCMessage);
        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        const message = responses.find(r => 'id' in r && r.id === 2) as { result?: { content?: unknown; structuredContent?: unknown } };
        expect(message.result?.content).toEqual([]);
        expect(message.result?.structuredContent).toEqual({ a: 1 });

        await server.close();
    });
});
