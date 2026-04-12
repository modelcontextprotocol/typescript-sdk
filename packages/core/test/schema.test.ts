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
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: {
                primary: { type: 'object', properties: { label: { type: 'string' } } },
                secondary: { type: 'object', properties: { label: { type: 'string' } } }
            }
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
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: {
                b: { type: 'object', properties: { inner: { type: 'object', properties: { x: { type: 'number' } } } } },
                c: { type: 'object', properties: { inner: { type: 'object', properties: { x: { type: 'number' } } } } }
            }
        });
    });

    test('non-existent $def reference is left as-is', () => {
        const schema = {
            type: 'object',
            properties: { broken: { $ref: '#/$defs/DoesNotExist' } },
            $defs: {}
        };
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: { broken: { $ref: '#/$defs/DoesNotExist' } }
        });
    });

    test('external $ref and root self-reference are left as-is', () => {
        const schema = {
            type: 'object',
            properties: {
                ext: { $ref: 'https://example.com/schemas/Foo.json' },
                self: { $ref: '#' }
            }
        };
        const result = dereferenceLocalRefs(schema);
        expect(result).toEqual(schema);
    });

    test('sibling keywords alongside $ref are preserved', () => {
        const schema = {
            type: 'object',
            properties: {
                addr: { $ref: '#/$defs/Address', description: 'Home address', title: 'Home', default: { street: '123 Main' } }
            },
            $defs: {
                Address: { type: 'object', properties: { street: { type: 'string' } } }
            }
        };
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: {
                addr: {
                    type: 'object',
                    properties: { street: { type: 'string' } },
                    description: 'Home address',
                    title: 'Home',
                    default: { street: '123 Main' }
                }
            }
        });
    });

    test('mixed cyclic and non-cyclic refs: non-cyclic inlined, cyclic preserved', () => {
        const schema = {
            type: 'object',
            properties: {
                tag: { $ref: '#/$defs/Tag' },
                tree: { $ref: '#/$defs/TreeNode' }
            },
            $defs: {
                Tag: { type: 'object', properties: { label: { type: 'string' } } },
                TreeNode: {
                    type: 'object',
                    properties: {
                        value: { type: 'string' },
                        tag: { $ref: '#/$defs/Tag' },
                        children: { type: 'array', items: { $ref: '#/$defs/TreeNode' } }
                    }
                }
            }
        };
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: {
                // Tag fully inlined
                tag: { type: 'object', properties: { label: { type: 'string' } } },
                // TreeNode resolved one level: Tag inlined, self-ref stays
                tree: {
                    type: 'object',
                    properties: {
                        value: { type: 'string' },
                        tag: { type: 'object', properties: { label: { type: 'string' } } },
                        children: { type: 'array', items: { $ref: '#/$defs/TreeNode' } }
                    }
                }
            },
            // Only cyclic def preserved, with Tag inlined inside it
            $defs: {
                TreeNode: {
                    type: 'object',
                    properties: {
                        value: { type: 'string' },
                        tag: { type: 'object', properties: { label: { type: 'string' } } },
                        children: { type: 'array', items: { $ref: '#/$defs/TreeNode' } }
                    }
                }
            }
        });
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
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: {
                employer: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        hq: { type: 'object', properties: { street: { type: 'string' } } }
                    },
                    description: 'The company'
                }
            }
        });
    });

    // Defensive: hand-crafted synthetic schema — no known schema generator (Zod v4,
    // ArkType, Valibot) produces $ref with a sibling containing nested $ref.
    // See: https://github.com/modelcontextprotocol/typescript-sdk/pull/1563#discussion_r3022304127
    test('$ref siblings containing nested $ref are resolved (defensive)', () => {
        const schema = {
            type: 'object',
            properties: { x: { $ref: '#/$defs/Outer' } },
            $defs: {
                Outer: { $ref: '#/$defs/Inner', allOf: [{ $ref: '#/$defs/Mixin' }] },
                Inner: { type: 'object' },
                Mixin: { title: 'mixin' }
            }
        };
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: { x: { type: 'object', allOf: [{ title: 'mixin' }] } }
        });
    });

    test('multi-hop cycle (A → B → C → A) with non-cyclic sibling: cycle detected, all non-cyclic parts inlined', () => {
        // Company → Employee → Department → Company (cycle)
        // Department also → Location (non-cyclic sibling)
        const schema = {
            type: 'object',
            properties: { company: { $ref: '#/$defs/Company' } },
            $defs: {
                // Intentionally unordered — function follows $ref pointers, not declaration order
                Location: {
                    type: 'object',
                    properties: { city: { type: 'string' } }
                },
                Employee: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        department: { $ref: '#/$defs/Department' }
                    }
                },
                Department: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        company: { $ref: '#/$defs/Company' },
                        location: { $ref: '#/$defs/Location' }
                    }
                },
                Company: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        employee: { $ref: '#/$defs/Employee' }
                    }
                }
            }
        };
        const inlinedDepartment = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                company: { $ref: '#/$defs/Company' },
                location: { type: 'object', properties: { city: { type: 'string' } } }
            }
        };
        const inlinedEmployee = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                department: inlinedDepartment
            }
        };
        const inlinedCompany = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                employee: inlinedEmployee
            }
        };
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: { company: inlinedCompany },
            // Only Company preserved — Location fully inlined everywhere including inside $defs
            $defs: { Company: inlinedCompany }
        });
    });

    test('boolean $defs entry resolves without sibling merge (SDK excludes boolean schemas by design)', () => {
        // JSON Schema allows boolean schemas (true = accept all, false = reject all) in $defs.
        // When a $ref resolves to a boolean, sibling keywords (description, title, etc.) are
        // dropped because the merge guard requires an object. This test documents that behavior.
        // No schema library produces boolean $defs — Zod: z.any() → {}, z.never() → {not:{}},
        // and the SDK's JsonSchemaType explicitly excludes boolean schemas (validators/types.ts).
        const schema = {
            type: 'object',
            properties: {
                x: { $ref: '#/$defs/AlwaysValid', description: 'Any value' }
            },
            $defs: { AlwaysValid: true }
        };
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: { x: true }
        });
    });

    test('$ref inlined from real $defs while properties named "$defs" and "definitions" are preserved', () => {
        const schema = {
            type: 'object',
            properties: {
                definitions: { type: 'array', items: { type: 'string' } },
                $defs: { type: 'object', properties: { x: { type: 'number' } } },
                tag: { $ref: '#/$defs/Tag' }
            },
            required: ['definitions', '$defs'],
            $defs: {
                Tag: { type: 'object', properties: { label: { type: 'string' } } }
            }
        };
        expect(dereferenceLocalRefs(schema)).toEqual({
            type: 'object',
            properties: {
                definitions: { type: 'array', items: { type: 'string' } },
                $defs: { type: 'object', properties: { x: { type: 'number' } } },
                tag: { type: 'object', properties: { label: { type: 'string' } } }
            },
            required: ['definitions', '$defs']
        });
    });
});
