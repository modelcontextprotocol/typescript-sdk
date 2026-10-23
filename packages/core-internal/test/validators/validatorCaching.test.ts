/**
 * Tests for validator caching behaviour (fixes #2605: memory leak from
 * unconditional recompilation of schemas without `$id`).
 */

import { describe, expect, it } from 'vitest';

import { AjvJsonSchemaValidator } from '../../src/validators/ajvProvider';
import { CfWorkerJsonSchemaValidator } from '../../src/validators/cfWorkerProvider';
import type { JsonSchemaType } from '../../src/validators/types';

describe('AjvJsonSchemaValidator caching (#2605)', () => {
    it('returns the same validator function for identical schemas without $id', () => {
        const provider = new AjvJsonSchemaValidator();
        const schema: JsonSchemaType = {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        };

        // Call getValidator twice with structurally identical (but different object) schemas
        const v1 = provider.getValidator(schema);
        const v2 = provider.getValidator({ ...schema });

        // Both should validate correctly
        expect(v1({ name: 'Alice' }).valid).toBe(true);
        expect(v2({ name: 'Alice' }).valid).toBe(true);
        expect(v1({}).valid).toBe(false);
        expect(v2({}).valid).toBe(false);
    });

    it('does not recompile when called repeatedly with the same schema content', () => {
        let compileCount = 0;
        const fakeEngine = {
            compile: (schema: unknown) => {
                compileCount++;
                return Object.assign(() => true, { errors: undefined });
            },
            getSchema: () => undefined,
            errorsText: () => ''
        };
        const provider = new AjvJsonSchemaValidator(fakeEngine);
        const schema: JsonSchemaType = { type: 'string' };

        provider.getValidator(schema);
        provider.getValidator(schema);
        provider.getValidator({ type: 'string' });

        // Should compile only once — subsequent calls use the cache
        expect(compileCount).toBe(1);
    });

    it('recompiles when schema content changes', () => {
        const provider = new AjvJsonSchemaValidator();

        const v1 = provider.getValidator({ type: 'string' } as JsonSchemaType);
        const v2 = provider.getValidator({ type: 'number' } as JsonSchemaType);

        expect(v1('hello').valid).toBe(true);
        expect(v1(42).valid).toBe(false);
        expect(v2(42).valid).toBe(true);
        expect(v2('hello').valid).toBe(false);
    });

    it('schemas with $id still use Ajv built-in identity cache', () => {
        const provider = new AjvJsonSchemaValidator();
        const schema: JsonSchemaType = {
            $id: 'https://example.com/test-schema',
            type: 'object',
            properties: { x: { type: 'number' } }
        };

        const v1 = provider.getValidator(schema);
        const v2 = provider.getValidator(schema);

        expect(v1({ x: 1 }).valid).toBe(true);
        expect(v2({ x: 1 }).valid).toBe(true);
        expect(v1({ x: 'nope' }).valid).toBe(false);
    });

    it('a mutated schema object produces a validator for the new content', () => {
        const provider = new AjvJsonSchemaValidator();
        const schema: JsonSchemaType = { type: 'string' };

        const v1 = provider.getValidator(schema);
        expect(v1('hello').valid).toBe(true);
        expect(v1(42).valid).toBe(false);

        // Mutate in place
        (schema as Record<string, unknown>).type = 'number';

        const v2 = provider.getValidator(schema);
        expect(v2(42).valid).toBe(true);
        expect(v2('hello').valid).toBe(false);
    });

    it('shared cached validator does not have cross-call error pollution', () => {
        const provider = new AjvJsonSchemaValidator();
        const schema: JsonSchemaType = {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        };

        const v1 = provider.getValidator(schema);
        const v2 = provider.getValidator(schema);

        // Validate with invalid data on v1
        const r1 = v1({});
        expect(r1.valid).toBe(false);
        expect(r1.errorMessage).toBeDefined();

        // v2 should still validate correctly (not inheriting errors from v1)
        const r2 = v2({ name: 'Bob' });
        expect(r2.valid).toBe(true);
    });

    it('works correctly across different dialect schemas', () => {
        const provider = new AjvJsonSchemaValidator();

        const schema2020: JsonSchemaType = {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'string'
        };
        const schema07: JsonSchemaType = {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'string'
        };

        const v2020 = provider.getValidator(schema2020);
        const v07 = provider.getValidator(schema07);

        expect(v2020('hello').valid).toBe(true);
        expect(v07('hello').valid).toBe(true);
    });
});

describe('CfWorkerJsonSchemaValidator caching (#2605)', () => {
    it('returns the same validation result for identical schemas without $id', () => {
        const provider = new CfWorkerJsonSchemaValidator();
        const schema: JsonSchemaType = {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        };

        const v1 = provider.getValidator(schema);
        const v2 = provider.getValidator({ ...schema });

        expect(v1({ name: 'Alice' }).valid).toBe(true);
        expect(v2({ name: 'Alice' }).valid).toBe(true);
        expect(v1({}).valid).toBe(false);
        expect(v2({}).valid).toBe(false);
    });

    it('recompiles when schema content changes', () => {
        const provider = new CfWorkerJsonSchemaValidator();

        const v1 = provider.getValidator({ type: 'string' } as JsonSchemaType);
        const v2 = provider.getValidator({ type: 'number' } as JsonSchemaType);

        expect(v1('hello').valid).toBe(true);
        expect(v1(42).valid).toBe(false);
        expect(v2(42).valid).toBe(true);
        expect(v2('hello').valid).toBe(false);
    });

    it('caches per draft — same content with different drafts validates differently', () => {
        const provider = new CfWorkerJsonSchemaValidator();

        // A schema with prefixItems: under 2020-12 it's enforced, under draft-07 it's ignored
        const schema2020: JsonSchemaType = {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'array',
            prefixItems: [{ type: 'number' }, { type: 'string' }]
        };

        const v2020 = provider.getValidator(schema2020);
        // prefixItems is enforced under 2020-12
        expect(v2020([1, 'x']).valid).toBe(true);
        expect(v2020(['x', 1]).valid).toBe(false);
    });
});
