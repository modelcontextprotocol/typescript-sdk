// Unit tests for dereferenceLocalRefs
// Tests raw JSON Schema edge cases independent of the server/client pipeline.
// See: https://github.com/anthropics/claude-code/issues/18260

import { describe, expect, test } from 'vitest';

import { dereferenceLocalRefs } from '../src/util/schema.js';

describe('dereferenceLocalRefs', () => {
    test('schema with no $ref passes through unchanged', () => {
        const schema = {
            type: 'object',
            properties: { name: { type: 'string' }, age: { type: 'number' } }
        };
        const result = dereferenceLocalRefs(schema);
        expect(result).toEqual(schema);
    });

    test('local $ref is inlined and $defs removed', () => {
        const schema = {
            type: 'object',
            properties: {
                primary: { $ref: '#/$defs/Tag' },
                secondary: { $ref: '#/$defs/Tag' }
            },
            $defs: {
                Tag: { type: 'object', properties: { label: { type: 'string' } } }
            }
        };
        const result = dereferenceLocalRefs(schema);
        expect(JSON.stringify(result)).not.toContain('$ref');
        expect(JSON.stringify(result)).not.toContain('$defs');
        expect(result['properties']).toMatchObject({
            primary: { type: 'object', properties: { label: { type: 'string' } } },
            secondary: { type: 'object', properties: { label: { type: 'string' } } }
        });
    });

    test('diamond references resolve correctly', () => {
        const schema = {
            type: 'object',
            properties: {
                b: { type: 'object', properties: { inner: { $ref: '#/$defs/Shared' } } },
                c: { type: 'object', properties: { inner: { $ref: '#/$defs/Shared' } } }
            },
            $defs: {
                Shared: { type: 'object', properties: { x: { type: 'number' } } }
            }
        };
        const result = dereferenceLocalRefs(schema);
        expect(JSON.stringify(result)).not.toContain('$ref');
        const props = result['properties'] as Record<string, Record<string, unknown>>;
        const bInner = (props['b']!['properties'] as Record<string, unknown>)['inner'];
        const cInner = (props['c']!['properties'] as Record<string, unknown>)['inner'];
        expect(bInner).toMatchObject({ type: 'object', properties: { x: { type: 'number' } } });
        expect(cInner).toMatchObject({ type: 'object', properties: { x: { type: 'number' } } });
    });

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
        expect((result['properties'] as Record<string, unknown>)['ext']).toEqual({
            $ref: 'https://example.com/schemas/Foo.json'
        });
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

    test('recursive $ref through $defs throws', () => {
        const schema = {
            type: 'object',
            properties: {
                value: { type: 'string' },
                children: { type: 'array', items: { $ref: '#/$defs/TreeNode' } }
            },
            $defs: {
                TreeNode: {
                    type: 'object',
                    properties: {
                        value: { type: 'string' },
                        children: { type: 'array', items: { $ref: '#/$defs/TreeNode' } }
                    }
                }
            }
        };
        expect(() => dereferenceLocalRefs(schema)).toThrow(/Recursive schema detected/);
    });

    test('$ref: "#" root self-reference throws', () => {
        const schema = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                child: { $ref: '#' }
            }
        };
        expect(() => dereferenceLocalRefs(schema)).toThrow(/Recursive schema detected/);
    });

    // The following tests cover real Zod v4 output patterns where $ref appears
    // with sibling keywords. Zod only produces metadata siblings (description,
    // title, default, etc.) — never schema nodes containing nested $ref.
    // These prove the sibling merge path handles all real-world scenarios.

    test('$ref with multiple metadata siblings (Zod .meta() on registered type)', () => {
        const schema = {
            type: 'object',
            properties: {
                home: { $ref: '#/$defs/Address', title: 'Home', deprecated: true }
            },
            $defs: {
                Address: { type: 'object', properties: { street: { type: 'string' } } }
            }
        };
        const result = dereferenceLocalRefs(schema);
        const home = (result['properties'] as Record<string, Record<string, unknown>>)['home']!;
        expect(home['type']).toBe('object');
        expect(home['title']).toBe('Home');
        expect(home['deprecated']).toBe(true);
        expect(JSON.stringify(result)).not.toContain('$ref');
    });

    test('$ref with default value sibling (Zod .default() on registered type)', () => {
        const schema = {
            type: 'object',
            properties: {
                home: { $ref: '#/$defs/Address', default: { street: '123 Main' } }
            },
            $defs: {
                Address: { type: 'object', properties: { street: { type: 'string' } } }
            }
        };
        const result = dereferenceLocalRefs(schema);
        const home = (result['properties'] as Record<string, Record<string, unknown>>)['home']!;
        expect(home['type']).toBe('object');
        expect(home['default']).toEqual({ street: '123 Main' });
        expect(JSON.stringify(result)).not.toContain('$ref');
    });

    test('$def referencing another $def (nested registered types)', () => {
        const schema = {
            type: 'object',
            properties: {
                employer: { $ref: '#/$defs/Company', description: 'The company' }
            },
            $defs: {
                Address: { type: 'object', properties: { street: { type: 'string' } } },
                Company: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        hq: { $ref: '#/$defs/Address' }
                    }
                }
            }
        };
        const result = dereferenceLocalRefs(schema);
        expect(JSON.stringify(result)).not.toContain('$ref');
        expect(JSON.stringify(result)).not.toContain('$defs');
        const employer = (result['properties'] as Record<string, Record<string, unknown>>)['employer']!;
        expect(employer['description']).toBe('The company');
        expect(employer['type']).toBe('object');
        const hq = (employer['properties'] as Record<string, Record<string, unknown>>)['hq']!;
        expect(hq['type']).toBe('object');
        expect(hq['properties']).toEqual({ street: { type: 'string' } });
    });
});
