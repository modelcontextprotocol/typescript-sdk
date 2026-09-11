import { describe, expect, it } from 'vitest';

import { AjvJsonSchemaValidator } from '../../src/validators/ajvProvider';

/**
 * Regression tests for #2605: `getValidator()` must not recompile a schema
 * that has no `$id` on every call. Repeated `Client.listTools()` refreshes
 * call `getValidator` with structurally identical schemas; without caching,
 * each call compiles a fresh validator that the AJV engine retains forever,
 * so the heap grows without bound in long-running clients.
 */

function makeFakeEngine() {
    let compiles = 0;
    let getSchemaCalls = 0;
    const engine = {
        compile: () => {
            compiles += 1;
            return Object.assign(() => true, { errors: undefined });
        },
        getSchema: () => {
            getSchemaCalls += 1;
            // eslint-disable-next-line unicorn/no-useless-undefined -- AjvLike.getSchema must return undefined
            return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        errorsText: (_errors?: any) => ''
    };
    return { engine, compileCount: () => compiles, getSchemaCount: () => getSchemaCalls };
}

describe('AjvJsonSchemaValidator validator caching', () => {
    it('compiles a schema without $id only once across repeated getValidator calls', () => {
        const { engine, compileCount } = makeFakeEngine();
        const provider = new AjvJsonSchemaValidator(engine);
        const schema = { type: 'object', properties: { a: { type: 'string' } } };

        provider.getValidator(schema);
        provider.getValidator(schema);

        expect(compileCount()).toBe(1);
    });

    it('hits the cache for structurally identical schemas with different object identity', () => {
        const { engine, compileCount } = makeFakeEngine();
        const provider = new AjvJsonSchemaValidator(engine);

        provider.getValidator({ type: 'object', properties: { a: { type: 'string' } } });
        provider.getValidator({ type: 'object', properties: { a: { type: 'string' } } });

        expect(compileCount()).toBe(1);
    });

    it('compiles distinct schemas independently', () => {
        const { engine, compileCount } = makeFakeEngine();
        const provider = new AjvJsonSchemaValidator(engine);

        provider.getValidator({ type: 'string' });
        provider.getValidator({ type: 'number' });
        provider.getValidator({ type: 'object' });

        expect(compileCount()).toBe(3);
    });

    it('shares one compilation for schemas that differ only in key order', () => {
        const { engine, compileCount } = makeFakeEngine();
        const provider = new AjvJsonSchemaValidator(engine);

        provider.getValidator({ type: 'object', properties: { a: { type: 'string' } } });
        provider.getValidator({ properties: { a: { type: 'string' } }, type: 'object' });

        expect(compileCount()).toBe(1);
    });

    it('is not poisoned when a caller mutates its schema object in place', () => {
        const { engine, compileCount } = makeFakeEngine();
        const provider = new AjvJsonSchemaValidator(engine);

        const schema: Record<string, unknown> = {
            type: 'object',
            properties: { a: { type: 'string' } }
        };
        provider.getValidator(schema);
        expect(compileCount()).toBe(1);

        // Mutate the same object in place — a fresh content key must trigger a
        // fresh compilation instead of reusing the stale validator for the
        // original content.
        schema.properties = { b: { type: 'number' } };
        provider.getValidator(schema);

        expect(compileCount()).toBe(2);
    });

    it('falls back to compiling without caching when a schema is not serializable', () => {
        const { engine, compileCount } = makeFakeEngine();
        const provider = new AjvJsonSchemaValidator(engine);

        const cyclic: Record<string, unknown> = { type: 'object' };
        cyclic.self = cyclic;

        expect(() => provider.getValidator(cyclic)).not.toThrow();
        expect(compileCount()).toBe(1);
    });

    it('keeps using the $id-based lookup for schemas with an $id', () => {
        const { engine, compileCount, getSchemaCount } = makeFakeEngine();
        const provider = new AjvJsonSchemaValidator(engine);
        const schema = { $id: 'https://example.com/schema', type: 'string' };

        provider.getValidator(schema);
        provider.getValidator(schema);

        expect(getSchemaCount()).toBe(2);
        // getSchema always misses in the fake engine, so each call compiles once —
        // the $id path is unchanged by this fix.
        expect(compileCount()).toBe(2);
    });

    it('returns a working validator after caching', () => {
        const provider = new AjvJsonSchemaValidator();
        const schema = { type: 'object', properties: { a: { type: 'string' } } };

        const validate = provider.getValidator<{ a?: string }>(schema);
        expect(validate({ a: 'x' }).valid).toBe(true);
        expect(validate({ a: 1 }).valid).toBe(false);
    });
});
