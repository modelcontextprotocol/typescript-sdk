// Unit tests for dereferenceLocalRefs and schemaToJson
// Tests raw JSON Schema edge cases independent of the server/client pipeline.
// See: https://github.com/anthropics/claude-code/issues/18260

import { describe, expect, test, afterEach } from 'vitest';
import * as z from 'zod/v4';
import { dereferenceLocalRefs, schemaToJson } from '../src/util/schema.js';

describe('schemaToJson $ref dereferencing', () => {
    const registeredSchemas: z.core.$ZodType[] = [];
    afterEach(() => {
        for (const s of registeredSchemas) z.globalRegistry.remove(s);
        registeredSchemas.length = 0;
    });

    test('passthrough: schema with no $ref is unchanged', () => {
        const result = schemaToJson(z.object({ name: z.string(), age: z.number() }), { io: 'input' });
        expect(result).toMatchObject({
            type: 'object',
            properties: { name: { type: 'string' }, age: { type: 'number' } }
        });
        expect(JSON.stringify(result)).not.toContain('$ref');
    });

    test('registered types are inlined and $defs removed', () => {
        const Tag = z.object({ label: z.string() });
        z.globalRegistry.add(Tag, { id: 'Tag' });
        registeredSchemas.push(Tag);

        const result = schemaToJson(z.object({ primary: Tag, secondary: Tag }), { io: 'input' });
        expect(JSON.stringify(result)).not.toContain('$ref');
        expect(JSON.stringify(result)).not.toContain('$defs');
        expect(result['properties']).toMatchObject({
            primary: { type: 'object', properties: { label: { type: 'string' } } },
            secondary: { type: 'object', properties: { label: { type: 'string' } } }
        });
    });

    test('recursive types produce { type: "object" } at cycle point', () => {
        const TreeNode: z.ZodType = z.object({
            value: z.string(),
            children: z.lazy(() => z.array(TreeNode))
        });
        const result = schemaToJson(z.object({ root: TreeNode }), { io: 'input' });
        expect(JSON.stringify(result)).not.toContain('$ref');
        expect(JSON.stringify(result)).not.toContain('$defs');

        const root = (result['properties'] as Record<string, unknown>)['root'] as Record<string, unknown>;
        expect(root).toHaveProperty('type', 'object');
        const children = (root['properties'] as Record<string, unknown>)['children'] as Record<string, unknown>;
        expect(children).toHaveProperty('type', 'array');
        expect(children['items']).toMatchObject({ type: 'object' });
    });

    test('diamond references resolve correctly', () => {
        const Shared = z.object({ x: z.number() });
        z.globalRegistry.add(Shared, { id: 'Shared' });
        registeredSchemas.push(Shared);

        const result = schemaToJson(
            z.object({
                b: z.object({ inner: Shared }),
                c: z.object({ inner: Shared })
            }),
            { io: 'input' }
        );

        expect(JSON.stringify(result)).not.toContain('$ref');
        const props = result['properties'] as Record<string, Record<string, unknown>>;
        const bInner = (props['b']!['properties'] as Record<string, unknown>)['inner'];
        const cInner = (props['c']!['properties'] as Record<string, unknown>)['inner'];
        expect(bInner).toMatchObject({ type: 'object', properties: { x: { type: 'number' } } });
        expect(cInner).toMatchObject({ type: 'object', properties: { x: { type: 'number' } } });
    });
});

describe('dereferenceLocalRefs edge cases', () => {
    test('non-existent $def reference is left as-is', () => {
        const schema = {
            type: 'object',
            properties: {
                broken: { $ref: '#/$defs/DoesNotExist' }
            },
            $defs: {}
        };
        const result = dereferenceLocalRefs(schema);
        expect((result['properties'] as Record<string, unknown>)['broken']).toEqual({ $ref: '#/$defs/DoesNotExist' });
    });

    test('external $ref is left as-is', () => {
        const schema = {
            type: 'object',
            properties: {
                ext: { $ref: 'https://example.com/schemas/Foo.json' }
            }
        };
        const result = dereferenceLocalRefs(schema);
        expect((result['properties'] as Record<string, unknown>)['ext']).toEqual({ $ref: 'https://example.com/schemas/Foo.json' });
    });

    test('sibling keywords alongside $ref are preserved', () => {
        const schema = {
            type: 'object',
            properties: {
                addr: { $ref: '#/$defs/Address', description: 'Home address' }
            },
            $defs: {
                Address: { type: 'object', properties: { street: { type: 'string' } } }
            }
        };
        const result = dereferenceLocalRefs(schema);
        const addr = (result['properties'] as Record<string, unknown>)['addr'] as Record<string, unknown>;
        expect(addr['type']).toBe('object');
        expect(addr['properties']).toEqual({ street: { type: 'string' } });
        expect(addr['description']).toBe('Home address');
    });

    test('$ref: "#" root self-reference with cycle detection', () => {
        const schema = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                child: { $ref: '#' }
            }
        };
        const result = dereferenceLocalRefs(schema);
        expect(JSON.stringify(result)).not.toContain('$ref');
        const child = (result['properties'] as Record<string, unknown>)['child'] as Record<string, unknown>;
        expect(child['type']).toBe('object');
        expect((child['properties'] as Record<string, unknown>)['name']).toEqual({ type: 'string' });
        // Recursive position should be bounded
        const grandchild = (child['properties'] as Record<string, unknown>)['child'] as Record<string, unknown>;
        expect(grandchild).toEqual({ type: 'object' });
    });

    test('schema with no $ref passes through unchanged', () => {
        const schema = {
            type: 'object',
            properties: { x: { type: 'number' } }
        };
        const result = dereferenceLocalRefs(schema);
        expect(result).toEqual(schema);
    });
});
