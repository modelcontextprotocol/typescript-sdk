/**
 * Validator cache behavior: validators are keyed by the schema body, so two
 * schemas that share an `$id` but describe different shapes validate
 * independently instead of silently reusing the first-compiled validator.
 */
import { describe, expect, it } from 'vitest';

import { AjvJsonSchemaValidator } from '../../src/validators/ajvProvider';
import type { JsonSchemaType } from '../../src/validators/types';

describe('AjvJsonSchemaValidator schema caching', () => {
    it('reuses a compiled validator for the identical schema body', () => {
        const provider = new AjvJsonSchemaValidator();
        const schema: JsonSchemaType = {
            $id: 'https://example.com/shared',
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a']
        };

        const first = provider.getValidator(schema);
        const second = provider.getValidator({ ...schema });

        expect(first({ a: 'x' }).valid).toBe(true);
        expect(second({ a: 'x' }).valid).toBe(true);
        expect(first({}).valid).toBe(false);
        expect(second({}).valid).toBe(false);
    });

    it('validates independently for schemas sharing an $id with different bodies', () => {
        const provider = new AjvJsonSchemaValidator();
        const schemaA: JsonSchemaType = {
            $id: 'https://example.com/collision',
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a']
        };
        const schemaB: JsonSchemaType = {
            $id: 'https://example.com/collision',
            type: 'object',
            properties: { b: { type: 'number' } },
            required: ['b']
        };

        const validatorA = provider.getValidator(schemaA);
        const validatorB = provider.getValidator(schemaB);

        // B's own body validates under B's validator even though A was
        // compiled first with the same $id.
        expect(validatorB({ b: 1 }).valid).toBe(true);
        expect(validatorB({ a: 'x' }).valid).toBe(false);

        // A keeps validating under its own body.
        expect(validatorA({ a: 'x' }).valid).toBe(true);
        expect(validatorA({ b: 1 }).valid).toBe(false);
    });

    it('handles more than two colliding schemas', () => {
        const provider = new AjvJsonSchemaValidator();
        const keys = ['a', 'b', 'c'] as const;
        const schemas: JsonSchemaType[] = keys.map(key => ({
            $id: 'https://example.com/collision',
            type: 'object',
            properties: { [key]: { type: 'string' } },
            required: [key]
        }));

        const validators = schemas.map(schema => provider.getValidator(schema));

        keys.forEach((key, index) => {
            const validator = validators[index]!;
            const payload: Record<string, string> = { [key]: 'value' };
            expect(validator(payload).valid).toBe(true);
            // A payload matching a different schema's required key is rejected.
            const otherKey = keys[(index + 1) % keys.length]!;
            expect(validator({ [otherKey]: 'value' }).valid).toBe(false);
        });
    });
});
