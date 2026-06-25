/**
 * Integration tests for SEP-2106: tool `inputSchema`/`outputSchema` conform to JSON Schema 2020-12,
 * and `structuredContent` may be any JSON value.
 *
 * Covers, end-to-end (client <-> server over an in-memory transport):
 * - array and primitive `structuredContent` round-trips and is validated against `outputSchema`
 * - falsy structured values (`0`, `false`, `""`) are not mistaken for "no structured content"
 * - the server auto-emits a serialized `TextContent` fallback for non-object `structuredContent`
 *   (pre-SEP client interop) but not for object `structuredContent` or when text already exists
 * - clients narrow `structuredContent` at runtime before reading properties
 */

import { Client } from '@modelcontextprotocol/client';
import type { TextContent } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

describe('SEP-2106: JSON Schema 2020-12 tool output', () => {
    let mcpServer: McpServer;
    let client: Client;

    beforeEach(() => {
        mcpServer = new McpServer({ name: 'sep2106 server', version: '1.0' });
        client = new Client({ name: 'sep2106 client', version: '1.0' });
    });

    async function connect() {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
        // Prime the client's cached output-schema validators.
        await client.listTools();
    }

    function textBlocks(content: ReadonlyArray<{ type: string }>): TextContent[] {
        return content.filter((block): block is TextContent => block.type === 'text');
    }

    test('round-trips array structuredContent and validates it against outputSchema', async () => {
        mcpServer.registerTool('hourly', { outputSchema: z.array(z.object({ hour: z.string(), temp: z.number() })) }, () => ({
            content: [],
            structuredContent: [
                { hour: '09:00', temp: 68 },
                { hour: '10:00', temp: 72 }
            ]
        }));
        await connect();

        const result = await client.callTool({ name: 'hourly', arguments: {} });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual([
            { hour: '09:00', temp: 68 },
            { hour: '10:00', temp: 72 }
        ]);
        expect(Array.isArray(result.structuredContent)).toBe(true);
        const structuredContent = result.structuredContent as Array<{ hour: string; temp: number }>;
        expect(structuredContent[0]?.hour).toBe('09:00');
    });

    test('auto-injects a serialized TextContent fallback for array structuredContent', async () => {
        mcpServer.registerTool('nums', { outputSchema: z.array(z.number()) }, () => ({ content: [], structuredContent: [1, 2, 3] }));
        await connect();

        const result = await client.callTool({ name: 'nums', arguments: {} });

        const texts = textBlocks(result.content);
        expect(texts).toHaveLength(1);
        expect(JSON.parse(texts[0].text)).toEqual([1, 2, 3]);
    });

    test('accepts a falsy primitive (0) as valid structured content', async () => {
        mcpServer.registerTool('count', { outputSchema: z.number() }, () => ({ content: [], structuredContent: 0 }));
        await connect();

        const result = await client.callTool({ name: 'count', arguments: {} });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBe(0);
        // Non-object value gets a serialized text fallback.
        expect(textBlocks(result.content).map(t => t.text)).toEqual(['0']);
    });

    // R-2106-6 + the `=== undefined` (not truthiness) fix in client/server: every falsy JSON value
    // must round-trip as real structured content, not be mistaken for "absent". `0` is covered above;
    // this pins `false`, `""`, and `null` so the truthiness bug cannot regress.
    test.each([
        { name: 'false', schema: z.boolean(), value: false, text: 'false' },
        { name: 'empty-string', schema: z.string(), value: '', text: '""' },
        { name: 'null', schema: z.null(), value: null, text: 'null' }
    ])('round-trips falsy structured content: $name', async ({ name, schema, value, text }) => {
        mcpServer.registerTool(name, { outputSchema: schema }, () => ({ content: [], structuredContent: value }));
        await connect();

        const result = await client.callTool({ name, arguments: {} });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBe(value);
        // Non-object falsy values also get a serialized text fallback for pre-SEP clients.
        expect(textBlocks(result.content).map(t => t.text)).toEqual([text]);
    });

    // R-2106-9/11/12: the SSRF / composition-DoS guards are wired into the *shipped default* validator,
    // not just unit-tested in isolation. Registering a raw JSON Schema outputSchema via the public
    // `fromJsonSchema` entry point compiles it through that default validator, so an unsafe schema
    // surfaces as a clean, descriptive error at registration — never an opaque crash or a network fetch.
    describe('schema safety guards surface cleanly through the default validator', () => {
        test('rejects a non-local $ref outputSchema (SSRF guard)', () => {
            expect(() => fromJsonSchema({ $ref: 'https://evil.example/schema.json' })).toThrow(/non-local|external reference/i);
        });

        test('rejects an over-deep outputSchema (composition-DoS depth bound)', () => {
            // Build a schema nested far deeper than the default depth bound (64).
            let deep: Record<string, unknown> = { type: 'object' };
            for (let i = 0; i < 200; i++) {
                deep = { type: 'object', properties: { nested: deep } };
            }
            expect(() => fromJsonSchema(deep)).toThrow(/too deeply nested|max depth/i);
        });

        test('accepts a same-document $ref outputSchema (local refs are allowed)', () => {
            expect(() =>
                fromJsonSchema({
                    type: 'object',
                    properties: { self: { $ref: '#/$defs/node' } },
                    $defs: { node: { type: 'string' } }
                })
            ).not.toThrow();
        });
    });

    test('does not add a text fallback for object structuredContent', async () => {
        mcpServer.registerTool('obj', { outputSchema: z.object({ ok: z.boolean() }) }, () => ({
            content: [],
            structuredContent: { ok: true }
        }));
        await connect();

        const result = await client.callTool({ name: 'obj', arguments: {} });

        expect(result.structuredContent).toEqual({ ok: true });
        expect(textBlocks(result.content)).toHaveLength(0);
    });

    test('does not duplicate an existing text block when one is already present', async () => {
        mcpServer.registerTool('nums-with-text', { outputSchema: z.array(z.number()) }, () => ({
            content: [{ type: 'text', text: 'pre-existing summary' }],
            structuredContent: [9, 8, 7]
        }));
        await connect();

        const result = await client.callTool({ name: 'nums-with-text', arguments: {} });

        const texts = textBlocks(result.content);
        expect(texts).toHaveLength(1);
        expect(texts[0].text).toBe('pre-existing summary');
    });

    test('rejects array structuredContent that does not conform to outputSchema (server-side)', async () => {
        mcpServer.registerTool('bad-nums', { outputSchema: z.array(z.number()) }, () => ({
            content: [],
            // @ts-expect-error intentionally non-conforming output to exercise server-side validation
            structuredContent: ['not', 'numbers']
        }));
        await connect();

        const result = await client.callTool({ name: 'bad-nums', arguments: {} });
        expect(result.isError).toBe(true);
        expect(textBlocks(result.content)[0]?.text).toMatch(/output validation error/i);
    });
});
