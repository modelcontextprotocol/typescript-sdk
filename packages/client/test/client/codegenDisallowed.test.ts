/**
 * The node shim's default JSON Schema validator depends on whether the process
 * may generate code from strings. A process started with
 * `--disallow-code-generation-from-strings` throws an EvalError from
 * `new Function`; the test stands that in by replacing the global `Function`
 * while the shim module loads.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const RealFunction = globalThis.Function;

async function loadShim(): Promise<typeof import('../../src/shimsNode')> {
    vi.resetModules();
    return import('../../src/shimsNode');
}

describe('node shim default JSON Schema validator', () => {
    afterEach(() => {
        globalThis.Function = RealFunction;
    });

    test('is Ajv when code generation is allowed', async () => {
        const { DefaultJsonSchemaValidator } = await loadShim();
        // Modules reload per test, so the classes are compared by name.
        expect(DefaultJsonSchemaValidator.name).toBe('AjvJsonSchemaValidator');
    });

    test('is the cf-worker validator when code generation is disallowed, and it validates', async () => {
        globalThis.Function = function () {
            throw new EvalError('Code generation from strings disallowed for this context');
        } as unknown as FunctionConstructor;
        const { DefaultJsonSchemaValidator } = await loadShim();
        globalThis.Function = RealFunction;

        expect(DefaultJsonSchemaValidator.name).toBe('CfWorkerJsonSchemaValidator');
        const check = new DefaultJsonSchemaValidator().getValidator<{ a: number }>({
            type: 'object',
            properties: { a: { type: 'number' } },
            required: ['a']
        });
        expect(check({ a: 1 }).valid).toBe(true);
        expect(check({ a: 'x' }).valid).toBe(false);
    });
});
