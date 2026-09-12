import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, isStandardSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { inputRequired, McpServer } from '../../src/index';
import type { InferRawShape, ToolCallback } from '../../src/server/mcp';
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

describe('registerTool output schema callback typing', () => {
    it('requires successful structuredContent to match object output schemas', () => {
        const server = new McpServer({ name: 's', version: '1' });

        const outputSchema = z.object({ data: z.string(), count: z.number() });
        server.registerTool('object-valid', { outputSchema }, () => ({
            content: [],
            structuredContent: { data: 'ok', count: 1 }
        }));

        // @ts-expect-error structuredContent must match outputSchema
        server.registerTool('object-wrong-root', { outputSchema }, async () => ({ content: [], structuredContent: 'wrong' }));
        // @ts-expect-error structuredContent must include every required output field
        server.registerTool('object-missing-field', { outputSchema }, () => ({ content: [], structuredContent: { data: 'missing' } }));
        // prettier-ignore
        // @ts-expect-error structuredContent field types must match outputSchema
        server.registerTool('object-wrong-field', { outputSchema }, () => ({ content: [], structuredContent: { data: 'wrong', count: 'one' } }));
        // @ts-expect-error successful callbacks with outputSchema must return structuredContent
        server.registerTool('object-missing-output', { outputSchema }, () => ({ content: [] }));
        // @ts-expect-error undefined is treated as absent by runtime output validation
        server.registerTool('undefined-output', { outputSchema: z.undefined() }, () => ({ content: [], structuredContent: undefined }));
    });

    it('supports every non-object output root without widening invalid results', () => {
        const server = new McpServer({ name: 's', version: '1' });

        server.registerTool('array-valid', { outputSchema: z.array(z.number()) }, () => ({ content: [], structuredContent: [1, 2] }));
        // @ts-expect-error array output schema rejects a string
        server.registerTool('array-invalid', { outputSchema: z.array(z.number()) }, () => ({ content: [], structuredContent: 'wrong' }));

        server.registerTool('primitive-valid', { outputSchema: z.string() }, async () => ({ content: [], structuredContent: 'ok' }));
        // @ts-expect-error primitive output schema rejects a number
        server.registerTool('primitive-invalid', { outputSchema: z.string() }, async () => ({ content: [], structuredContent: 1 }));

        const unionOutput = z.union([z.string(), z.number()]);
        server.registerTool('union-valid', { outputSchema: unionOutput }, () => ({ content: [], structuredContent: 1 }));
        // @ts-expect-error union output schema rejects values outside the union
        server.registerTool('union-invalid', { outputSchema: unionOutput }, () => ({ content: [], structuredContent: false }));

        server.registerTool('null-valid', { outputSchema: z.null() }, () => ({ content: [], structuredContent: null }));
        // @ts-expect-error null output schema rejects non-null values
        server.registerTool('null-invalid', { outputSchema: z.null() }, () => ({ content: [], structuredContent: 'not-null' }));

        server.registerTool('unknown-valid', { outputSchema: z.unknown() }, () => ({ content: [], structuredContent: null }));
        // @ts-expect-error runtime treats undefined structuredContent as absent even when the schema output is unknown
        server.registerTool('unknown-undefined', { outputSchema: z.unknown() }, () => ({ content: [], structuredContent: undefined }));
    });

    it('preserves input inference and exceptional result branches', () => {
        const server = new McpServer({ name: 's', version: '1' });
        const inputSchema = z.object({ succeed: z.boolean() });
        const outputSchema = z.object({ data: z.string() });

        server.registerTool('mixed-valid', { inputSchema, outputSchema }, async ({ succeed }) => {
            expectTypeOf(succeed).toEqualTypeOf<boolean>();
            return succeed ? { content: [], structuredContent: { data: 'ok' } } : { content: [], isError: true };
        });
        server.registerTool('input-required', { outputSchema }, () => inputRequired({ requestState: 'opaque' }));

        // @ts-expect-error an invalid success branch cannot hide beside a valid error branch
        server.registerTool('mixed-invalid', { inputSchema, outputSchema }, ({ succeed }) =>
            succeed ? { content: [], structuredContent: { data: 1 } } : { content: [], isError: true }
        );
    });

    it('retains broad callbacks when outputSchema is absent or optional', () => {
        const server = new McpServer({ name: 's', version: '1' });
        const inputSchema = z.object({ value: z.string() });
        const callback: ToolCallback<typeof inputSchema> = ({ value }) => ({ content: [], structuredContent: value.length });

        server.registerTool('no-output-schema', { inputSchema }, callback);

        const maybeOutputSchema = (enabled: boolean): typeof inputSchema | undefined => (enabled ? inputSchema : undefined);
        server.registerTool('optional-output-schema', { outputSchema: maybeOutputSchema(false) }, () => ({
            content: [],
            structuredContent: { value: 'ok' }
        }));
    });

    it('uses schema output types for coercing schemas', () => {
        const server = new McpServer({ name: 's', version: '1' });
        const outputSchema = z.coerce.number();

        server.registerTool('coerce-valid', { outputSchema }, () => ({ content: [], structuredContent: 1 }));
        // @ts-expect-error callbacks return the schema output type, not its broader input type
        server.registerTool('coerce-invalid', { outputSchema }, () => ({ content: [], structuredContent: '1' }));
    });

    it('checks deprecated raw output shapes and preserves raw input inference', () => {
        const server = new McpServer({ name: 's', version: '1' });
        const inputSchema = { n: z.number() };
        const outputSchema = { result: z.string() };

        server.registerTool('raw-valid', { inputSchema, outputSchema }, ({ n }) => {
            expectTypeOf(n).toEqualTypeOf<number>();
            return { content: [], structuredContent: { result: String(n) } };
        });
        // prettier-ignore
        // @ts-expect-error raw output shape is inferred as its object output type
        server.registerTool('raw-invalid', { inputSchema, outputSchema }, ({ n }) => ({ content: [], structuredContent: { result: n } }));
    });

    it('checks ArkType and Valibot output schemas in the server typecheck target', () => {
        const server = new McpServer({ name: 's', version: '1' });

        const arkOutput = type({ result: 'string' });
        server.registerTool('ark-output-valid', { outputSchema: arkOutput }, () => ({
            content: [],
            structuredContent: { result: 'ok' }
        }));
        // prettier-ignore
        // @ts-expect-error ArkType output schema rejects the wrong field type
        server.registerTool('ark-output-invalid', { outputSchema: arkOutput }, () => ({ content: [], structuredContent: { result: 1 } }));

        const valibotOutput = toStandardJsonSchema(v.object({ result: v.string() }));
        server.registerTool('valibot-output-valid', { outputSchema: valibotOutput }, () => ({
            content: [],
            structuredContent: { result: 'ok' }
        }));
        // prettier-ignore
        // @ts-expect-error Valibot output schema rejects a missing required field
        server.registerTool('valibot-output-invalid', { outputSchema: valibotOutput }, () => ({ content: [], structuredContent: {} }));
    });
});
