import { describe, expect, it } from 'vitest';

import { AjvJsonSchemaValidator } from '../../src/validators/ajvProvider';

/** Peeks at the provider's private engine slot without triggering the lazy getter. */
function engineSlot(provider: AjvJsonSchemaValidator): unknown {
    return (provider as unknown as { _ajv: unknown })._ajv;
}

describe('AjvJsonSchemaValidator lazy engine construction', () => {
    it('does not construct the default Ajv engine until the first getValidator call', () => {
        const provider = new AjvJsonSchemaValidator();
        expect(engineSlot(provider)).toBeUndefined();

        const validate = provider.getValidator<{ a?: string }>({ type: 'object', properties: { a: { type: 'string' } } });
        expect(engineSlot(provider)).toBeDefined();
        expect(validate({ a: 'x' }).valid).toBe(true);
        expect(validate({ a: 1 }).valid).toBe(false);
    });

    it('reuses one engine across getValidator calls', () => {
        const provider = new AjvJsonSchemaValidator();
        provider.getValidator({ type: 'string' });
        const first = engineSlot(provider);
        provider.getValidator({ type: 'number' });
        expect(engineSlot(provider)).toBe(first);
    });

    it('uses a caller-supplied engine immediately and never replaces it', () => {
        let compiles = 0;
        const fake = {
            compile: () => {
                compiles += 1;
                return Object.assign(() => true, { errors: undefined });
            },
            getSchema: () => undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            errorsText: (_errors?: any) => ''
        };
        const provider = new AjvJsonSchemaValidator(fake);
        expect(engineSlot(provider)).toBe(fake);

        const validate = provider.getValidator({ type: 'object' });
        expect(compiles).toBe(1);
        expect(validate({}).valid).toBe(true);
        expect(engineSlot(provider)).toBe(fake);
    });

    it('still rejects unknown $schema dialects before constructing the default engine', () => {
        const provider = new AjvJsonSchemaValidator();
        expect(() => provider.getValidator({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' })).toThrow(
            /unsupported dialect/
        );
        // The dialect check fires before engine construction — no engine was built for the rejected schema.
        expect(engineSlot(provider)).toBeUndefined();
    });

    it('a draft-07 schema builds only the draft-07 engine, not the 2020-12 one', () => {
        const provider = new AjvJsonSchemaValidator();
        const validate = provider.getValidator({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' });
        expect(validate({}).valid).toBe(true);
        expect(engineSlot(provider)).toBeUndefined();
        expect((provider as unknown as { _ajvDraft7: unknown })._ajvDraft7).toBeDefined();
    });

    it('a 2019-09 schema builds only the 2019-09 engine', () => {
        const provider = new AjvJsonSchemaValidator();
        const validate = provider.getValidator({ $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object' });
        expect(validate({}).valid).toBe(true);
        expect(engineSlot(provider)).toBeUndefined();
        expect((provider as unknown as { _ajvDraft7: unknown })._ajvDraft7).toBeUndefined();
        expect((provider as unknown as { _ajv2019: unknown })._ajv2019).toBeDefined();
    });
});
