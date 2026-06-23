/**
 * Self-contained test bodies for the JSON Schema 2020-12 validator posture
 * (SEP-1613 dialect, SEP-2106 non-object roots + legacy `{result:…}` wrap).
 *
 * Each export is a {@link verifies} body: it builds its own server (via a
 * factory), builds its own client, wires them with {@link wire}, and asserts.
 * There are no shared fixture imports; helpers local to multiple bodies live at
 * the top of this file.
 *
 * The era-spanning bodies use `type:'object'`-rooted output schemas (so the
 * 2025-era wire codec — which keeps `outputSchema`/`structuredContent` at their
 * object/Record shapes for byte-identity — round-trips them on every arm). The
 * non-object-root bodies are restricted to the createMcpHandler entry arms in
 * `requirements.ts` because only the 2026-07-28 wire codec carries that
 * vocabulary natively.
 */

import { Client } from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/server';
import { fromJsonSchema, McpServer, ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/** Plain client with no extra capabilities declared. */
const newClient = () => new Client({ name: 'c', version: '0' });

/** Object-root output schema with a same-document `$ref` into `$defs`. */
const SAME_DOCUMENT_REF_OUTPUT = {
    type: 'object' as const,
    properties: { point: { $ref: '#/$defs/Point' } },
    required: ['point'],
    $defs: {
        Point: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y']
        }
    }
};

/**
 * Object-root output schema with an external (network) `$ref`. The SDK does not pre-screen
 * `$ref` (the spec MUST-NOT is "do not dereference", not "reject") — the underlying Ajv engine
 * does not fetch external refs and throws a `MissingRefError` at compile time, which the client
 * captures per-tool and surfaces as `InvalidParams`.
 */
const NETWORK_REF_OUTPUT = {
    type: 'object' as const,
    properties: { point: { $ref: 'https://schemas.example.invalid/point.json' } },
    required: ['point']
};

/** Object-root output schema declaring a `$schema` dialect URI no built-in provider recognises. */
const UNKNOWN_DIALECT_OUTPUT = {
    $schema: 'https://example.invalid/json-schema/v99/schema',
    type: 'object' as const,
    properties: { value: { type: 'number' } },
    required: ['value']
};

/**
 * Low-level Server factory advertising one tool per fixture output schema.
 * The low-level Server applies no server-side output validation, so the
 * client-side validator behavior under test is the only check in the path.
 */
function refSchemaServer(): Server {
    const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
    s.setRequestHandler('tools/list', () => ({
        tools: [
            {
                name: 'network-ref',
                inputSchema: { type: 'object' },
                outputSchema: NETWORK_REF_OUTPUT
            },
            {
                name: 'local-ref',
                inputSchema: { type: 'object' },
                outputSchema: SAME_DOCUMENT_REF_OUTPUT
            },
            {
                name: 'unknown-dialect',
                inputSchema: { type: 'object' },
                outputSchema: UNKNOWN_DIALECT_OUTPUT
            }
        ]
    }));
    s.setRequestHandler('tools/call', req => {
        switch (req.params.name) {
            case 'network-ref':
            case 'local-ref': {
                return { structuredContent: { point: { x: 1, y: 2 } }, content: [] };
            }
            case 'unknown-dialect': {
                return { structuredContent: { value: 7 }, content: [] };
            }
            default: {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `unknown tool ${req.params.name}`);
            }
        }
    });
    return s;
}

verifies('client:jsonschema:same-document-ref-ok', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, refSchemaServer, client);

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'local-ref');
    expect(tool?.outputSchema).toMatchObject({ $defs: { Point: { type: 'object' } } });

    const r = await client.callTool({ name: 'local-ref', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ point: { x: 1, y: 2 } });
});

verifies('client:jsonschema:unsupported-dialect-graceful', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, refSchemaServer, client);

    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === 'unknown-dialect')?.outputSchema).toMatchObject({
        $schema: 'https://example.invalid/json-schema/v99/schema'
    });

    const call = client.callTool({ name: 'unknown-dialect', arguments: {} });
    await expect(call).rejects.toBeInstanceOf(ProtocolError);
    const err = await call.catch(error => error as ProtocolError);
    expect(err.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(err.message).toMatch(/invalid outputSchema.*unsupported dialect/i);
});

verifies('client:jsonschema:bad-schema-isolates-tool', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, refSchemaServer, client);

    // The listing carries every tool, including the one whose schema the
    // validator engine refuses to compile (external `$ref` → MissingRefError).
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).toSorted()).toEqual(['local-ref', 'network-ref', 'unknown-dialect']);

    // The good tool is callable and validates.
    const ok = await client.callTool({ name: 'local-ref', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toEqual({ point: { x: 1, y: 2 } });

    // The bad tool surfaces its compile failure lazily, per-tool.
    const bad = client.callTool({ name: 'network-ref', arguments: {} });
    await expect(bad).rejects.toBeInstanceOf(ProtocolError);
    const err = await bad.catch(error => error as ProtocolError);
    expect(err.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(err.message).toMatch(/invalid outputSchema/i);
});

verifies('client:jsonschema:non-object-output', async ({ transport }: TestArgs) => {
    // Low-level server with a non-object-root output schema. Only meaningful on
    // the 2026-07-28 wire codec (entryModern arm), where outputSchema is a
    // loose object and structuredContent is `unknown`.
    const makeServer = (): Server => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({
            tools: [
                {
                    name: 'array-out',
                    inputSchema: { type: 'object' },
                    outputSchema: { type: 'array', items: { type: 'number' } }
                }
            ]
        }));
        s.setRequestHandler('tools/call', () => ({ structuredContent: [1, 2, 3], content: [] }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === 'array-out')?.outputSchema).toMatchObject({ type: 'array' });

    const r = await client.callTool({ name: 'array-out', arguments: {} });
    expect(r.isError).toBeFalsy();
    // SEP-2106: structuredContent is typed `unknown`; narrow at the call site.
    expect(r.structuredContent).toEqual([1, 2, 3]);
    expect(Array.isArray(r.structuredContent)).toBe(true);
});

verifies('client:jsonschema:2020-12:prefixItems', async ({ transport }: TestArgs) => {
    // Low-level server advertising a 2020-12-only `prefixItems` outputSchema and
    // returning structuredContent in the WRONG positional order. Ajv2020
    // enforces prefixItems → validation fails; a draft-07 Ajv with strict:false
    // would ignore the keyword and accept. This pins the SEP-1613 default.
    const makeServer = (): Server => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({
            tools: [
                {
                    name: 'tuple-out',
                    inputSchema: { type: 'object' },
                    outputSchema: {
                        type: 'array',
                        prefixItems: [{ type: 'number' }, { type: 'string' }]
                    }
                }
            ]
        }));
        s.setRequestHandler('tools/call', () => ({ structuredContent: ['x', 1], content: [] }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    await client.listTools();
    const call = client.callTool({ name: 'tuple-out', arguments: {} });
    await expect(call).rejects.toBeInstanceOf(ProtocolError);
    const err = await call.catch(error => error as ProtocolError);
    expect(err.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(err.message).toMatch(/output schema/i);
});

/**
 * Low-level Server advertising a `prefixItems` outputSchema with no `$schema`
 * stamp. The handler returns structuredContent that violates `prefixItems`
 * (positions swapped). With the 2020-12 default, `prefixItems` is enforced and
 * validation fails.
 */
function dialectServer(): Server {
    const out: Tool['outputSchema'] = {
        type: 'object',
        properties: { v: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'string' }] } },
        required: ['v']
    };
    const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
    s.setRequestHandler('tools/list', () => ({
        tools: [{ name: 'no-stamp', inputSchema: { type: 'object' }, outputSchema: out }]
    }));
    s.setRequestHandler('tools/call', () => ({ structuredContent: { v: ['x', 1] }, content: [] }));
    return s;
}

verifies('client:jsonschema:dialect:default-is-2020-12', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, dialectServer, client);

    await client.listTools();
    // No `$schema` → 2020-12 default → `prefixItems` enforced → {v:['x',1]} invalid.
    const call = client.callTool({ name: 'no-stamp', arguments: {} });
    await expect(call).rejects.toBeInstanceOf(ProtocolError);
    const err = await call.catch(error => error as ProtocolError);
    expect(err.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(err.message).toMatch(/output schema/i);
});

verifies('client:jsonschema:falsy-structured-content-validated', async ({ transport }: TestArgs) => {
    // Low-level server with `outputSchema:{type:'integer'}` returning
    // `structuredContent: 0`. Pins the SEP-2106 §4.3 `=== undefined` presence
    // check on the client: a falsy value is treated as PRESENT and validated,
    // not as missing.
    const makeServer = (): Server => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({
            tools: [
                {
                    name: 'zero',
                    inputSchema: { type: 'object' },
                    outputSchema: { type: 'integer' }
                }
            ]
        }));
        s.setRequestHandler('tools/call', () => ({ structuredContent: 0, content: [] }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    await client.listTools();
    const r = await client.callTool({ name: 'zero', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toBe(0);
    expect(r.structuredContent === 0).toBe(true);
});

verifies('server:jsonschema:array-structured-content-textfallback', async ({ transport }: TestArgs) => {
    const makeServer = (): McpServer => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'list-numbers',
            {
                inputSchema: z.object({}),
                outputSchema: fromJsonSchema<number[]>({ type: 'array', items: { type: 'number' } })
            },
            () => ({ structuredContent: [1, 2, 3], content: [] })
        );
        s.registerTool(
            'list-authored',
            {
                inputSchema: z.object({}),
                outputSchema: fromJsonSchema<number[]>({ type: 'array', items: { type: 'number' } })
            },
            () => ({ structuredContent: [1], content: [{ type: 'text', text: 'mine' }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'list-numbers', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual([1, 2, 3]);
    // The auto-TextContent fallback carries the JSON serialisation because
    // the handler authored no `type:'text'` block of its own.
    expect(r.content).toContainEqual({ type: 'text', text: JSON.stringify([1, 2, 3]) });

    // Author opt-out: any author-supplied `type:'text'` block suppresses the
    // auto-fallback — exactly the authored block, no JSON-stringify append.
    const own = await client.callTool({ name: 'list-authored', arguments: {} });
    expect(own.structuredContent).toEqual([1]);
    const textBlocks = (own.content ?? []).filter(c => c.type === 'text');
    expect(textBlocks).toEqual([{ type: 'text', text: 'mine' }]);
});

verifies('server:jsonschema:primitive-structured-content', async ({ transport }: TestArgs) => {
    const makeServer = (): McpServer => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'count',
            {
                inputSchema: z.object({}),
                outputSchema: fromJsonSchema<number>({ type: 'number' })
            },
            () => ({ structuredContent: 0, content: [] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'count', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toBe(0);
    expect(r.content).toContainEqual({ type: 'text', text: '0' });
});

verifies(
    ['2025:jsonschema:non-object-output-wrapped', '2025:jsonschema:non-object-structured-content-wrapped'],
    async ({ transport }: TestArgs) => {
        // McpServer with a non-object-root outputSchema, served on the 2025 era
        // (entryStateless arm). The legacy interop wraps the outputSchema in a
        // `{type:'object',properties:{result:…},required:['result']}` envelope so
        // 2025 clients can parse it, and wraps the structuredContent as
        // `{result: <value>}` so it satisfies the envelope. The auto-TextContent
        // fallback also carries the natural JSON serialisation.
        const makeServer = (): McpServer => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool(
                'list-numbers',
                {
                    inputSchema: z.object({}),
                    outputSchema: fromJsonSchema<number[]>({ type: 'array', items: { type: 'number' } })
                },
                () => ({ structuredContent: [1, 2, 3], content: [] })
            );
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'list-numbers');
        expect(tool).toBeDefined();
        // The non-object outputSchema is wrapped in the {result:…} envelope on the legacy projection.
        expect(tool?.outputSchema).toMatchObject({
            type: 'object',
            properties: { result: { type: 'array', items: { type: 'number' } } },
            required: ['result']
        });

        // The tool stays callable on the legacy era: structuredContent is wrapped as
        // {result:[1,2,3]} so it satisfies both the 2025 wire shape (object-only) and the
        // wrapped outputSchema; the auto-TextContent fallback carries the natural value.
        const r = await client.callTool({ name: 'list-numbers', arguments: {} });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent).toEqual({ result: [1, 2, 3] });
        expect(r.content).toContainEqual({ type: 'text', text: JSON.stringify([1, 2, 3]) });
    }
);

/**
 * McpServer with a typeless-root outputSchema (`anyOf:[object, string]` from `z.union`). The
 * legacy wrap predicate is per-tool and follows the SCHEMA root (which is non-object → wraps),
 * not the runtime value's shape — so on the 2025 era both the object branch `{a:1}` and the
 * string branch `"x"` come back wrapped as `structuredContent.result`, and on the 2026 era both
 * come back natural.
 */
function unionOutputServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerTool(
        'union-out',
        {
            inputSchema: z.object({ which: z.enum(['obj', 'str']) }),
            outputSchema: z.union([z.object({ a: z.number() }), z.string()])
        },
        ({ which }) => ({ structuredContent: which === 'obj' ? { a: 1 } : 'x', content: [] })
    );
    return s;
}

verifies('2025:jsonschema:wrap-follows-schema-not-value', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, unionOutputServer, client);

    const { tools } = await client.listTools();
    const wrapped = tools.find(t => t.name === 'union-out')?.outputSchema;
    // The typeless `{anyOf:[…]}` root is wrapped in the {result:…} envelope on the legacy projection.
    expect(wrapped).toMatchObject({
        type: 'object',
        properties: { result: { anyOf: [{ type: 'object' }, { type: 'string' }] } },
        required: ['result']
    });

    // BOTH branches — including the object-valued one — are wrapped as {result:…} so the
    // result satisfies the wrapped schema (and the legacy client validates it).
    const obj = await client.callTool({ name: 'union-out', arguments: { which: 'obj' } });
    expect(obj.isError).toBeFalsy();
    expect(obj.structuredContent).toEqual({ result: { a: 1 } });

    const str = await client.callTool({ name: 'union-out', arguments: { which: 'str' } });
    expect(str.isError).toBeFalsy();
    expect(str.structuredContent).toEqual({ result: 'x' });
    // The string branch is a non-object value, so the era-agnostic auto-TextContent fires.
    expect(str.content).toContainEqual({ type: 'text', text: '"x"' });
});

verifies('server:jsonschema:union-output-natural', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, unionOutputServer, client);

    const { tools } = await client.listTools();
    // No wrap on the 2026 era — the natural typeless `{anyOf:[…]}` root is advertised.
    expect(tools.find(t => t.name === 'union-out')?.outputSchema).toMatchObject({
        anyOf: [{ type: 'object' }, { type: 'string' }]
    });

    const obj = await client.callTool({ name: 'union-out', arguments: { which: 'obj' } });
    expect(obj.isError).toBeFalsy();
    expect(obj.structuredContent).toEqual({ a: 1 });

    const str = await client.callTool({ name: 'union-out', arguments: { which: 'str' } });
    expect(str.isError).toBeFalsy();
    expect(str.structuredContent).toBe('x');
    // The auto-TextContent fallback applies on EVERY era for non-object values.
    expect(str.content).toContainEqual({ type: 'text', text: '"x"' });
});

verifies('2025:jsonschema:ref-rewrite-on-wrap', async ({ transport }: TestArgs) => {
    // A non-object outputSchema with a same-document `$ref` (e.g. a recursive array). On the
    // legacy era the schema is wrapped under `#/properties/result`, so the `$ref` JSON Pointer
    // must be rewritten to keep resolving (`#/items` → `#/properties/result/items`). Mirrors the
    // C# SDK's TransformOutputSchemaForLegacyWire.
    const NATURAL = {
        type: 'array',
        items: { anyOf: [{ type: 'number' }, { $ref: '#' }] }
    } as const;
    const makeServer = (): McpServer => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('tree', { inputSchema: z.object({}), outputSchema: fromJsonSchema<unknown[]>(NATURAL) }, () => ({
            structuredContent: [1, [2, 3]],
            content: []
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    const wrapped = tools.find(t => t.name === 'tree')?.outputSchema;
    expect(wrapped).toMatchObject({
        type: 'object',
        properties: { result: { type: 'array', items: { anyOf: [{ type: 'number' }, { $ref: '#/properties/result' }] } } },
        required: ['result']
    });

    // The wrapped schema compiles on the client (the rewritten `$ref` resolves) and validates the
    // wrapped structuredContent.
    const r = await client.callTool({ name: 'tree', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ result: [1, [2, 3]] });
});

verifies('2025:jsonschema:ref-rewrite-scope', async ({ transport }: TestArgs) => {
    // The legacy-wrap `$ref` rewrite applies to `$ref` AND `$dynamicRef` in subschema positions,
    // but NOT to instance-data positions (`const`/`enum`/`default`/`examples`) — a `{$ref:…}`
    // there is a literal value. (The TypeScript SDK goes beyond the C# RewriteRefPointers on both.)
    //
    // Listing-only assertion: Ajv2020 stack-overflows compiling a `$dynamicRef` whose fragment is
    // a JSON Pointer (rather than a `$dynamicAnchor`), so the tool is intentionally never called
    // here — the rewrite contract is about what the wrapped SCHEMA looks like in tools/list.
    const NATURAL = {
        anyOf: [{ $dynamicRef: '#/$defs/X' }, { const: { $ref: '#/foo' } }],
        $defs: {
            X: {
                type: 'object',
                properties: { v: { type: 'number', default: { $ref: '#' }, examples: [{ $ref: '#/bar' }] } },
                required: ['v']
            }
        }
    } as const;
    const makeServer = (): McpServer => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('scope', { inputSchema: z.object({}), outputSchema: fromJsonSchema<unknown>(NATURAL) }, () => ({
            structuredContent: { v: 7 },
            content: []
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    const wrapped = tools.find(t => t.name === 'scope')?.outputSchema;
    expect(wrapped).toEqual({
        type: 'object',
        properties: {
            result: {
                anyOf: [
                    { $dynamicRef: '#/properties/result/$defs/X' }, // rewritten
                    { const: { $ref: '#/foo' } } // data position — NOT rewritten
                ],
                $defs: {
                    X: {
                        type: 'object',
                        properties: {
                            v: {
                                type: 'number',
                                default: { $ref: '#' }, // data position — NOT rewritten
                                examples: [{ $ref: '#/bar' }] // data position — NOT rewritten
                            }
                        },
                        required: ['v']
                    }
                }
            }
        },
        required: ['result']
    });
});
