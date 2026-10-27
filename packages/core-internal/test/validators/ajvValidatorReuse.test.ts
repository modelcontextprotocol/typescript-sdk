import { describe, expect, it } from 'vitest';

import { AjvJsonSchemaValidator } from '../../src/validators/ajvProvider';

/** Counting stand-in for an Ajv instance, so compile calls are observable. */
function countingAjv() {
    const state = {
        compiles: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compile: () => {
            state.compiles += 1;
            return Object.assign(() => true, { errors: undefined });
        },
        getSchema: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        errorsText: (_errors?: any) => ''
    };
    return state;
}

describe('AjvJsonSchemaValidator validator reuse', () => {
    it('compiles an identical schema only once', () => {
        const ajv = countingAjv();
        const provider = new AjvJsonSchemaValidator(ajv);
        const schema = { type: 'object' as const, properties: { a: { type: 'string' } } };

        provider.getValidator(schema);
        provider.getValidator(schema);
        provider.getValidator({ type: 'object', properties: { a: { type: 'string' } } });

        expect(ajv.compiles).toBe(1);
    });

    it('treats a freshly parsed but identical schema as the same schema', () => {
        const ajv = countingAjv();
        const provider = new AjvJsonSchemaValidator(ajv);

        // What a client does on every tools/list: re-parse the tool catalogue.
        for (let i = 0; i < 5; i += 1) {
            provider.getValidator(JSON.parse('{"type":"object","properties":{"a":{"type":"string"}}}'));
        }

        expect(ajv.compiles).toBe(1);
    });

    it('still compiles distinct schemas separately', () => {
        const ajv = countingAjv();
        const provider = new AjvJsonSchemaValidator(ajv);

        provider.getValidator({ type: 'object', properties: { a: { type: 'string' } } });
        provider.getValidator({ type: 'object', properties: { a: { type: 'number' } } });

        expect(ajv.compiles).toBe(2);
    });

    it('caches per dialect engine rather than across them', () => {
        const provider = new AjvJsonSchemaValidator();
        const validate = provider.getValidator<{ a?: string }>({ type: 'object', properties: { a: { type: 'string' } } });

        expect(validate({ a: 'x' }).valid).toBe(true);
        expect(validate({ a: 1 }).valid).toBe(false);
    });

    it('returns a validator that keeps reporting the right verdict', () => {
        const provider = new AjvJsonSchemaValidator();
        const schema = { type: 'object' as const, properties: { a: { type: 'string' } } };
        const first = provider.getValidator<{ a?: string }>(schema);
        const second = provider.getValidator<{ a?: string }>(schema);

        for (const validate of [first, second]) {
            expect(validate({ a: 'x' }).valid).toBe(true);
            expect(validate({ a: 1 }).valid).toBe(false);
            expect(validate({ a: 1 }).errorMessage).toBeTruthy();
        }
    });
});
