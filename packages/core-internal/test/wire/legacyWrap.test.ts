import { describe, expect, it } from 'vitest';

import { wrapOutputSchemaForLegacy } from '../../src/wire/rev2025-11-25/legacyWrap';
import { rev2025Codec } from '../../src/wire/rev2025-11-25/codec';

/** Test helper: drill into a nested untyped object by path. */
function dig(node: unknown, ...path: ReadonlyArray<string | number>): unknown {
    let cur: unknown = node;
    for (const k of path) cur = (cur as Record<string | number, unknown>)[k];
    return cur;
}

describe('wrapOutputSchemaForLegacy: position-aware $ref rewrite', () => {
    it('rewrites $ref/$dynamicRef in keyword position; leaves data positions (const/enum/default/examples) untouched', () => {
        const wrapped = wrapOutputSchemaForLegacy({
            anyOf: [{ $dynamicRef: '#/$defs/X' }, { const: { $ref: '#/foo' } }],
            $defs: {
                X: {
                    type: 'object',
                    properties: { v: { type: 'number', default: { $ref: '#' }, examples: [{ $ref: '#/bar' }] } },
                    required: ['v']
                }
            }
        });
        expect(wrapped).toEqual({
            type: 'object',
            properties: {
                result: {
                    anyOf: [{ $dynamicRef: '#/properties/result/$defs/X' }, { const: { $ref: '#/foo' } }],
                    $defs: {
                        X: {
                            type: 'object',
                            properties: {
                                v: { type: 'number', default: { $ref: '#' }, examples: [{ $ref: '#/bar' }] }
                            },
                            required: ['v']
                        }
                    }
                }
            },
            required: ['result']
        });
    });

    it('a property NAMED default/const under properties/$defs is a name position — its value IS a subschema and is recursed into', () => {
        // `properties.default` and `$defs.const` are author-chosen NAMES that
        // collide with JSON Schema keywords. Their values are subschemas in
        // keyword position, so a `$ref` inside is rewritten.
        const wrapped = wrapOutputSchemaForLegacy({
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    default: { $ref: '#/$defs/const' },
                    const: { $ref: '#' }
                }
            },
            $defs: { const: { type: 'string' } }
        });
        expect(dig(wrapped, 'properties', 'result', 'items', 'properties', 'default')).toEqual({
            $ref: '#/properties/result/$defs/const'
        });
        expect(dig(wrapped, 'properties', 'result', 'items', 'properties', 'const')).toEqual({ $ref: '#/properties/result' });
        // `$defs.const` is a name position (its value is a subschema), so recursion descends — but
        // there's no `$ref` inside `{type:'string'}`; the entry itself is kept.
        expect(dig(wrapped, 'properties', 'result', '$defs', 'const')).toEqual({ type: 'string' });
    });

    it('patternProperties / dependentSchemas / definitions are name maps too', () => {
        const wrapped = wrapOutputSchemaForLegacy({
            anyOf: [{ $ref: '#/$defs/X' }],
            patternProperties: { '^default$': { $ref: '#' } },
            dependentSchemas: { enum: { $ref: '#/$defs/X' } },
            definitions: { examples: { $ref: '#' } },
            $defs: { X: { type: 'number' } }
        });
        expect(dig(wrapped, 'properties', 'result', 'patternProperties')).toEqual({
            '^default$': { $ref: '#/properties/result' }
        });
        expect(dig(wrapped, 'properties', 'result', 'dependentSchemas')).toEqual({
            enum: { $ref: '#/properties/result/$defs/X' }
        });
        expect(dig(wrapped, 'properties', 'result', 'definitions')).toEqual({ examples: { $ref: '#/properties/result' } });
    });
});

describe('wrapOutputSchemaForLegacy: $id-scoped rewrite', () => {
    it('a natural root with $id skips the pointer rewrite entirely (refs resolve against the embedded base)', () => {
        const natural = {
            $id: 'https://x',
            type: 'array',
            items: { $ref: '#/$defs/D' },
            $defs: { D: { type: 'number' } }
        } as const;
        const wrapped = wrapOutputSchemaForLegacy(natural);
        // Wrapped, but the embedded schema is referentially identical — NO ref was rewritten.
        expect(wrapped).toEqual({ type: 'object', properties: { result: natural }, required: ['result'] });
        expect(dig(wrapped, 'properties', 'result')).toBe(natural);
    });

    it('a nested subtree establishing its own $id is left untouched; the rest of the schema is still rewritten', () => {
        const sub = { $id: 'https://y', items: { $ref: '#/$defs/E' }, $defs: { E: { type: 'string' } } };
        const wrapped = wrapOutputSchemaForLegacy({
            anyOf: [{ $ref: '#/$defs/D' }, sub],
            $defs: { D: { type: 'number' } }
        });
        // First anyOf member rewritten; the $id-carrying member is left untouched (referentially).
        expect(dig(wrapped, 'properties', 'result', 'anyOf', 0)).toEqual({ $ref: '#/properties/result/$defs/D' });
        expect(dig(wrapped, 'properties', 'result', 'anyOf', 1)).toBe(sub);
    });

    it('a root $schema is hoisted to the wrapper root (so the SEP-1613 dialect check still fires on the projection)', () => {
        const wrapped = wrapOutputSchemaForLegacy({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'array',
            items: { type: 'number' }
        });
        expect(wrapped['$schema']).toBe('http://json-schema.org/draft-07/schema#');
        // The natural copy under properties.result also still carries it (harmless in subschema position).
        expect(dig(wrapped, 'properties', 'result', '$schema')).toBe('http://json-schema.org/draft-07/schema#');
    });

    it('a property NAMED $id under a name map does NOT establish a resolution base', () => {
        // `properties.$id` is a name-position entry whose value is a subschema; the
        // `$id` key here is a property name, not the keyword, so the surrounding
        // subtree is still rewritten.
        const wrapped = wrapOutputSchemaForLegacy({
            type: 'array',
            items: { type: 'object', properties: { $id: { type: 'string' } }, allOf: [{ $ref: '#' }] }
        });
        expect(dig(wrapped, 'properties', 'result', 'items', 'allOf')).toEqual([{ $ref: '#/properties/result' }]);
    });
});

describe('rev2025Codec.projectCallToolResult: value-shape wrap', () => {
    it('wraps a non-object structuredContent value as {result:…} when no outputSchema is advertised', () => {
        const out = rev2025Codec.projectCallToolResult({ content: [], structuredContent: [1, 2, 3] }, undefined);
        expect(out.structuredContent).toEqual({ result: [1, 2, 3] });
    });

    it.each([0, false, '', null] as const)('wraps falsy non-object value %p (presence is !== undefined)', sc => {
        const out = rev2025Codec.projectCallToolResult({ content: [], structuredContent: sc }, undefined);
        expect(out.structuredContent).toEqual({ result: sc });
    });

    it('leaves object-shaped structuredContent unwrapped when no schema is advertised (already wire-legal)', () => {
        const out = rev2025Codec.projectCallToolResult({ content: [], structuredContent: { a: 1 } }, undefined);
        expect(out.structuredContent).toEqual({ a: 1 });
    });

    it('still wraps an object-shaped value when the advertised schema has a non-object root (schema/result coherence)', () => {
        const out = rev2025Codec.projectCallToolResult(
            { content: [], structuredContent: { a: 1 } },
            { anyOf: [{ type: 'object' }, { type: 'string' }] }
        );
        expect(out.structuredContent).toEqual({ result: { a: 1 } });
    });
});
