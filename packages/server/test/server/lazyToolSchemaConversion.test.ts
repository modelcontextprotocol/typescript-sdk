/**
 * `registerTool` converts tool schemas to JSON Schema on demand, not at
 * registration: `tools/list` converts the schemas it emits, and the memoised
 * `toolInputSchemaJson()` / `outputSchemaJson` slots fill on first use. A server
 * built per request therefore no longer converts every tool on every request.
 */
import { scanXMcpHeaderDeclarations, standardSchemaToJsonSchema, type StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { fromJsonSchema } from '../../src/fromJsonSchema';
import { invoke } from '../../src/server/invoke';
import { McpServer } from '../../src/server/mcp';

const LEGACY = { classification: { era: 'legacy' as const } };

type Counted = { schema: StandardSchemaWithJSON; calls: { input: number; output: number } };

/** Wraps a schema so every `~standard.jsonSchema` conversion is counted. */
function counted(inner: StandardSchemaWithJSON): Counted {
    const calls = { input: 0, output: 0 };
    const std = inner['~standard'];
    const schema = {
        '~standard': {
            ...std,
            jsonSchema: {
                input: (options: Parameters<typeof std.jsonSchema.input>[0]) => {
                    calls.input++;
                    return std.jsonSchema.input(options);
                },
                output: (options: Parameters<typeof std.jsonSchema.output>[0]) => {
                    calls.output++;
                    return std.jsonSchema.output(options);
                }
            }
        }
    } as unknown as StandardSchemaWithJSON;
    return { schema, calls };
}

const listTools = async (server: McpServer): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await invoke(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, LEGACY);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const INVALID_HEADER_SCHEMA = fromJsonSchema({
    type: 'object',
    properties: { a: { type: 'object', 'x-mcp-header': 'Data' } as Record<string, unknown> }
});

describe('lazy tool schema conversion', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('registerTool converts neither inputSchema nor outputSchema; tools/list converts both', async () => {
        const input = counted(z.object({ a: z.string() }));
        const output = counted(z.object({ b: z.number() }));
        const server = new McpServer({ name: 'lazy', version: '0' });

        server.registerTool('t', { inputSchema: input.schema, outputSchema: output.schema }, async () => ({ content: [] }));
        expect(input.calls).toEqual({ input: 0, output: 0 });
        expect(output.calls).toEqual({ input: 0, output: 0 });

        const { body } = await listTools(server);
        expect((body.result as { tools: unknown[] }).tools).toHaveLength(1);
        expect(input.calls).toEqual({ input: 1, output: 0 });
        expect(output.calls).toEqual({ input: 0, output: 1 });
    });

    it('toolInputSchemaJson() converts on first use and memoises', () => {
        const input = counted(z.object({ a: z.string() }));
        const server = new McpServer({ name: 'lazy', version: '0' });
        server.registerTool('t', { inputSchema: input.schema }, async () => ({ content: [] }));
        expect(input.calls.input).toBe(0);

        const first = server.toolInputSchemaJson('t');
        expect(first).toEqual(standardSchemaToJsonSchema(z.object({ a: z.string() }), 'input'));
        expect(input.calls.input).toBe(1);

        expect(server.toolInputSchemaJson('t')).toBe(first);
        expect(input.calls.input).toBe(1);
    });

    it('outputSchemaJson converts on first read and memoises', () => {
        const output = counted(z.object({ b: z.number() }));
        const server = new McpServer({ name: 'lazy', version: '0' });
        const tool = server.registerTool('t', { outputSchema: output.schema }, async () => ({ content: [] }));
        expect(output.calls.output).toBe(0);

        const first = tool.outputSchemaJson;
        expect(first).toEqual(standardSchemaToJsonSchema(z.object({ b: z.number() }), 'output'));
        expect(output.calls.output).toBe(1);

        expect(tool.outputSchemaJson).toBe(first);
        expect(output.calls.output).toBe(1);
    });

    it('update({ outputSchema }) replaces outputSchemaJson', () => {
        const server = new McpServer({ name: 'lazy', version: '0' });
        const tool = server.registerTool('t', { outputSchema: z.object({ b: z.number() }) }, async () => ({ content: [] }));
        expect(tool.outputSchemaJson).toEqual(standardSchemaToJsonSchema(z.object({ b: z.number() }), 'output'));

        const replacement = counted(z.object({ c: z.string() }));
        tool.update({ outputSchema: replacement.schema });
        expect(tool.outputSchemaJson).toEqual(standardSchemaToJsonSchema(z.object({ c: z.string() }), 'output'));
        expect(replacement.calls.output).toBe(1);
        // The replacement stays memoised.
        tool.outputSchemaJson;
        expect(replacement.calls.output).toBe(1);
    });

    it('the invalid x-mcp-header warning fires each time tools are listed, not at registration', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const server = new McpServer({ name: 'lazy', version: '0' });
        server.registerTool('bad', { inputSchema: INVALID_HEADER_SCHEMA }, async () => ({ content: [] }));
        expect(warn).toHaveBeenCalledTimes(0);

        await listTools(server);
        await listTools(server);
        await listTools(server);
        expect(warn).toHaveBeenCalledTimes(3);
        const scan = scanXMcpHeaderDeclarations(standardSchemaToJsonSchema(INVALID_HEADER_SCHEMA, 'input'));
        expect(scan.valid).toBe(false);
        for (const call of warn.mock.calls) {
            expect(call[0]).toBe(
                `[mcp-sdk] tool 'bad' carries an invalid x-mcp-header declaration and will be excluded by ` +
                    `conforming Streamable HTTP clients: ${(scan as { reason?: string }).reason}`
            );
        }
    });

    it('tools/list emits the same bytes as a direct conversion', async () => {
        const server = new McpServer({ name: 'lazy', version: '0' });
        const inputSchema = z.object({ a: z.string().describe('first'), n: z.number().optional() });
        const outputSchema = z.object({ ok: z.boolean() });
        server.registerTool('t', { title: 'T', description: 'd', inputSchema, outputSchema }, async () => ({ content: [] }));
        server.registerTool('bare', {}, async () => ({ content: [] }));

        const { body } = await listTools(server);
        expect(JSON.stringify(body.result)).toBe(
            JSON.stringify({
                tools: [
                    {
                        name: 't',
                        title: 'T',
                        description: 'd',
                        inputSchema: standardSchemaToJsonSchema(inputSchema, 'input'),
                        outputSchema: standardSchemaToJsonSchema(outputSchema, 'output')
                    },
                    { name: 'bare', inputSchema: { type: 'object', properties: {} } }
                ]
            })
        );
    });

    it('a conversion failure still surfaces at tools/list, and toolInputSchemaJson() returns undefined', async () => {
        const unconvertible = {
            '~standard': { version: 1, vendor: 'custom', validate: (value: unknown) => ({ value }) }
        } as unknown as StandardSchemaWithJSON;
        const server = new McpServer({ name: 'lazy', version: '0' });
        // Registration does not convert, so it does not throw.
        expect(() => server.registerTool('t', { inputSchema: unconvertible }, async () => ({ content: [] }))).not.toThrow();

        expect(server.toolInputSchemaJson('t')).toBeUndefined();

        const { body } = await listTools(server);
        expect(body.result).toBeUndefined();
        expect(JSON.stringify(body.error)).toContain('does not implement StandardJSONSchemaV1');
    });
});
