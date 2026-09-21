import * as z from 'zod/v4';

import type { StandardSchemaWithJSON } from '../../src/util/standardSchema';
import { standardSchemaToJsonSchema } from '../../src/util/standardSchema';

/** Minimal vendor-neutral Standard Schema whose JSON Schema conversions count invocations. */
function makeCountingSchema(root: Record<string, unknown>): { schema: StandardSchemaWithJSON; calls: { input: number; output: number } } {
    const calls = { input: 0, output: 0 };
    const schema: StandardSchemaWithJSON = {
        '~standard': {
            version: 1,
            vendor: 'counting-fake',
            validate: value => ({ value }),
            jsonSchema: {
                input: () => {
                    calls.input++;
                    return { ...root };
                },
                output: () => {
                    calls.output++;
                    return { ...root };
                }
            }
        }
    };
    return { schema, calls };
}

describe('standardSchemaToJsonSchema', () => {
    test('emits type:object for plain z.object schemas', () => {
        const schema = z.object({ name: z.string(), age: z.number() });
        const result = standardSchemaToJsonSchema(schema, 'input');

        expect(result.type).toBe('object');
        expect(result.properties).toBeDefined();
    });

    test('emits type:object for discriminated unions', () => {
        const schema = z.discriminatedUnion('action', [
            z.object({ action: z.literal('create'), name: z.string() }),
            z.object({ action: z.literal('delete'), id: z.string() })
        ]);
        const result = standardSchemaToJsonSchema(schema, 'input');

        expect(result.type).toBe('object');
        // Zod emits oneOf for discriminated unions; the catchall on Tool.inputSchema
        // accepts it, but the top-level type must be present per MCP spec.
        expect(result.oneOf ?? result.anyOf).toBeDefined();
    });

    test('throws for schemas with explicit non-object type', () => {
        expect(() => standardSchemaToJsonSchema(z.string(), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.array(z.string()), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.number(), 'input')).toThrow(/must describe objects/);
    });

    test('preserves existing type:object without modification', () => {
        const schema = z.object({ x: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'input');

        // Spread order means zod's own type:"object" wins; verify no double-wrap.
        const keys = Object.keys(result);
        expect(keys.filter(k => k === 'type')).toHaveLength(1);
        expect(result.type).toBe('object');
    });

    describe('memoization', () => {
        test('converts a given schema instance at most once per io direction', () => {
            const { schema, calls } = makeCountingSchema({ type: 'object', properties: { a: { type: 'string' } } });

            const first = standardSchemaToJsonSchema(schema, 'input');
            expect(standardSchemaToJsonSchema(schema, 'input')).toBe(first);
            expect(standardSchemaToJsonSchema(schema, 'input')).toBe(first);
            expect(calls.input).toBe(1);

            // The other direction is a separate conversion, itself memoized.
            const output = standardSchemaToJsonSchema(schema, 'output');
            expect(standardSchemaToJsonSchema(schema, 'output')).toBe(output);
            expect(calls.output).toBe(1);
            expect(calls.input).toBe(1);
        });

        test('memoizes the post-stamping result for typeless roots', () => {
            const { schema, calls } = makeCountingSchema({ properties: { a: { type: 'string' } } });

            const first = standardSchemaToJsonSchema(schema, 'input');
            expect(first.type).toBe('object');
            expect(standardSchemaToJsonSchema(schema, 'input')).toBe(first);
            expect(calls.input).toBe(1);
        });

        test('returns the identical object on repeat conversion of a hoisted zod schema', () => {
            // The per-request-factory `createMcpHandler` pattern: one module-scope
            // schema, many McpServer instances — conversion must run once per process.
            const schema = z.object({ name: z.string() });
            expect(standardSchemaToJsonSchema(schema, 'input')).toBe(standardSchemaToJsonSchema(schema, 'input'));
            expect(standardSchemaToJsonSchema(schema, 'output')).toBe(standardSchemaToJsonSchema(schema, 'output'));
        });

        test('does not memoize conversion failures', () => {
            let calls = 0;
            const schema: StandardSchemaWithJSON = {
                '~standard': {
                    version: 1,
                    vendor: 'flaky-fake',
                    validate: value => ({ value }),
                    jsonSchema: {
                        input: () => {
                            calls++;
                            if (calls === 1) throw new Error('transient conversion failure');
                            return { type: 'object' as const };
                        },
                        output: () => ({ type: 'object' as const })
                    }
                }
            };

            expect(() => standardSchemaToJsonSchema(schema, 'input')).toThrow('transient conversion failure');
            expect(standardSchemaToJsonSchema(schema, 'input')).toEqual({ type: 'object' });
            expect(calls).toBe(2);
        });
    });
});
