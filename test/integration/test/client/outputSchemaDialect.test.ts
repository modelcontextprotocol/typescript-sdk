/**
 * Ecosystem servers advertise tool schemas stamped with a draft-07 `$schema`
 * (zod-to-json-schema's default output — e.g. the official Filesystem server).
 * The spec honors the declared dialect (absent means 2020-12), so the default
 * validator must dispatch on it instead of rejecting pre-wire with InvalidParams.
 * Unknown dialects still produce the typed error.
 */

import { Client } from '@modelcontextprotocol/client';
import type { JsonSchemaType } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { fromJsonSchema, McpServer, Server } from '@modelcontextprotocol/server';

/** zod-to-json-schema default output shape, lifted from the official Filesystem server. */
const FILESYSTEM_STYLE_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] }
    },
    required: ['content'],
    additionalProperties: false
} as const;

/** Draft-07 tuple form: positional `items` array (2020-12 moved this to `prefixItems`). */
const DRAFT_07_TUPLE_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
        pair: { type: 'array', items: [{ type: 'number' }, { type: 'string' }] }
    },
    required: ['pair']
} as const;

/** zod-to-json-schema `target: 'openAi'` output shape (also its `target: '2019-09'`). */
const OPENAI_TARGET_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2019-09/schema#',
    type: 'object',
    properties: {
        summary: { type: 'string' },
        score: { type: 'number' }
    },
    required: ['summary'],
    additionalProperties: false
} as const;

/**
 * A real low-level Server advertising a verbatim outputSchema without compiling it —
 * the shape of a non-SDK ecosystem server. `structuredContent` comes from `results`
 * keyed by tool name.
 */
async function connectPair(
    outputSchema: unknown,
    structuredContent: () => unknown
): Promise<{ client: Client; close: () => Promise<unknown> }> {
    const server = new Server({ name: 'ecosystem-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({
        tools: [{ name: 'read_text_file', inputSchema: { type: 'object' }, outputSchema: outputSchema as JsonSchemaType }]
    }));
    server.setRequestHandler('tools/call', async () => ({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: structuredContent() as Record<string, unknown>
    }));

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    // Populate the tools/list cache — output validation derives from the cached entry.
    await client.listTools();
    return { client, close: () => Promise.all([client.close(), clientTransport.close(), serverTransport.close()]) };
}

describe('declared-dialect tool schemas end to end', () => {
    test('draft-07 outputSchema (Filesystem-server shape) validates instead of failing pre-wire', async () => {
        const { client, close } = await connectPair(FILESYSTEM_STYLE_SCHEMA, () => ({ content: 'hello', encoding: 'utf8' }));

        await expect(client.callTool({ name: 'read_text_file' })).resolves.toMatchObject({
            structuredContent: { content: 'hello', encoding: 'utf8' }
        });

        await close();
    });

    test('a VIOLATING result against a draft-07 outputSchema still fails validation', async () => {
        // `content` missing — the draft-07 engine must actually run, not pass through.
        const { client, close } = await connectPair(FILESYSTEM_STYLE_SCHEMA, () => ({ encoding: 'utf8' }));

        await expect(client.callTool({ name: 'read_text_file' })).rejects.toThrow(/does not match the tool's output schema/);

        await close();
    });

    test('draft-07 tuple `items` gets draft-07 positional semantics', async () => {
        let pair: unknown = [1, 'x'];
        const { client, close } = await connectPair(DRAFT_07_TUPLE_SCHEMA, () => ({ pair }));

        await expect(client.callTool({ name: 'read_text_file' })).resolves.toMatchObject({ structuredContent: { pair: [1, 'x'] } });

        pair = ['x', 1]; // violates the positional item schemas
        await expect(client.callTool({ name: 'read_text_file' })).rejects.toThrow(/does not match the tool's output schema/);

        await close();
    });

    test('2019-09 outputSchema (zod-to-json-schema openAi target shape) validates instead of failing pre-wire', async () => {
        const { client, close } = await connectPair(OPENAI_TARGET_SCHEMA, () => ({ summary: 'ok', score: 1 }));

        await expect(client.callTool({ name: 'read_text_file' })).resolves.toMatchObject({
            structuredContent: { summary: 'ok', score: 1 }
        });

        await close();
    });

    test('a VIOLATING result against a 2019-09 outputSchema still fails validation', async () => {
        // `summary` missing — the 2019-09 engine must actually run, not pass through.
        const { client, close } = await connectPair(OPENAI_TARGET_SCHEMA, () => ({ score: 1 }));

        await expect(client.callTool({ name: 'read_text_file' })).rejects.toThrow(/does not match the tool's output schema/);

        await close();
    });

    test('unknown dialect still fails pre-wire with the typed error', async () => {
        const { client, close } = await connectPair(
            { ...FILESYSTEM_STYLE_SCHEMA, $schema: 'http://json-schema.org/draft-04/schema#' },
            () => ({ content: 'hello' })
        );

        await expect(client.callTool({ name: 'read_text_file' })).rejects.toThrow(/invalid outputSchema.*unsupported dialect/s);

        await close();
    });

    test('fromJsonSchema registers a draft-07 inputSchema and enforces it server-side', async () => {
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });
        mcpServer.registerTool(
            'echo',
            {
                inputSchema: fromJsonSchema<{ content: string; encoding?: 'utf8' | 'base64' }>(
                    FILESYSTEM_STYLE_SCHEMA as unknown as JsonSchemaType
                )
            },
            async args => ({ content: [{ type: 'text', text: JSON.stringify(args) }] })
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

        await expect(client.callTool({ name: 'echo', arguments: { content: 'hi' } })).resolves.toMatchObject({
            content: [{ type: 'text', text: expect.stringContaining('hi') }]
        });

        // Violates the draft-07 schema (`content` missing) — the server reports an input validation error.
        await expect(client.callTool({ name: 'echo', arguments: { encoding: 'utf8' } })).resolves.toMatchObject({
            isError: true,
            content: [{ type: 'text', text: expect.stringContaining("must have required property 'content'") }]
        });

        await Promise.all([client.close(), clientTransport.close(), serverTransport.close()]);
    });
});
