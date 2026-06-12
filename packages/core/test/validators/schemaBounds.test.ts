/**
 * Tests for the SEP-2106 schema safety guards: non-local `$ref` rejection (SSRF) and
 * composition bounds (depth / subschema count, composition-DoS).
 */

import { assertSchemaSafeToCompile } from '../../src/validators/schemaBounds.js';

describe('assertSchemaSafeToCompile', () => {
    describe('reference guards', () => {
        it('accepts a same-document $ref into $defs', () => {
            const schema = {
                type: 'object',
                $defs: { Name: { type: 'string' } },
                properties: { name: { $ref: '#/$defs/Name' } }
            };
            expect(() => assertSchemaSafeToCompile(schema)).not.toThrow();
        });

        it('accepts a same-document $dynamicRef anchor', () => {
            expect(() => assertSchemaSafeToCompile({ $dynamicRef: '#meta' })).not.toThrow();
        });

        it('rejects an http(s) $ref (SSRF guard)', () => {
            expect(() => assertSchemaSafeToCompile({ $ref: 'https://evil.example/schema.json' })).toThrow(/non-local/i);
        });

        it('rejects a relative/file $ref as non-same-document', () => {
            expect(() => assertSchemaSafeToCompile({ type: 'object', properties: { x: { $ref: 'other.json#/X' } } })).toThrow(/non-local/i);
        });

        it('rejects a non-local $dynamicRef', () => {
            expect(() => assertSchemaSafeToCompile({ $dynamicRef: 'http://evil.example#x' })).toThrow(/non-local/i);
        });

        it('ignores URL-looking strings that are not $ref/$dynamicRef keywords', () => {
            const schema = { type: 'string', description: 'see https://example.com/docs', default: 'http://x' };
            expect(() => assertSchemaSafeToCompile(schema)).not.toThrow();
        });
    });

    describe('composition bounds', () => {
        it('accepts composition keywords within bounds', () => {
            const schema = {
                type: 'object',
                oneOf: [{ required: ['a'] }, { required: ['b'] }],
                allOf: [{ type: 'object' }]
            };
            expect(() => assertSchemaSafeToCompile(schema)).not.toThrow();
        });

        it('rejects a schema nested deeper than the depth bound', () => {
            let deep: Record<string, unknown> = { type: 'object' };
            for (let i = 0; i < 12; i++) {
                deep = { type: 'object', properties: { nested: deep } };
            }
            expect(() => assertSchemaSafeToCompile(deep, { maxDepth: 4 })).toThrow(/too deeply nested/i);
        });

        it('rejects a schema with more subschemas than the count bound', () => {
            const schema = { allOf: Array.from({ length: 20 }, () => ({ type: 'object' })) };
            expect(() => assertSchemaSafeToCompile(schema, { maxSubschemas: 5 })).toThrow(/too many subschemas/i);
        });

        it('accepts a large-but-bounded schema under the default limits', () => {
            const schema = { anyOf: Array.from({ length: 100 }, (_unused, i) => ({ const: i })) };
            expect(() => assertSchemaSafeToCompile(schema)).not.toThrow();
        });
    });
});
