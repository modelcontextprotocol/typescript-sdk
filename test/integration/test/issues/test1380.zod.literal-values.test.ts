/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/1380
 *
 * Some Zod runtimes store literal values only in `._def.values[0]`, with both
 * the top-level `.value` shortcut and `._def.value` absent. This test verifies
 * McpServer initialization still succeeds in that scenario.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

describe('Issue #1380: Zod literal method extraction', () => {
    afterEach(() => {
        vi.resetModules();
        vi.doUnmock('zod/v4');
    });

    test('should construct McpServer when method literal is stored only in _def.values[0]', async () => {
        vi.resetModules();
        vi.doMock('zod/v4', async () => {
            const actual = await vi.importActual<typeof import('zod/v4')>('zod/v4');

            return {
                ...actual,
                literal: ((...args: Parameters<typeof actual.literal>) => {
                    const schema = actual.literal(...args);

                    // Simulate a Zod runtime that stores the literal value only in
                    // _def.values[0], with neither the top-level .value shortcut
                    // nor _def.value present.
                    //
                    // We wrap the schema in a plain object that shadows .value with
                    // undefined and exposes a new _def that has only .values (no .value).
                    const originalDef = (schema as Record<string, unknown>)._def as Record<string, unknown>;
                    const value = originalDef.value ?? originalDef.values?.[0] ?? (schema as Record<string, unknown>).value;

                    const strippedDef: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(originalDef)) {
                        if (k !== 'value') strippedDef[k] = v;
                    }
                    if (!strippedDef.values) {
                        strippedDef.values = [value];
                    }

                    return Object.create(schema as object, {
                        value: { get: () => void 0, enumerable: true, configurable: true },
                        _def: { get: () => strippedDef, enumerable: true, configurable: true }
                    }) as typeof schema;
                }) as typeof actual.literal
            };
        });

        const { McpServer } = await import('@modelcontextprotocol/server');

        expect(
            () =>
                new McpServer({
                    name: 'test server',
                    version: '1.0'
                })
        ).not.toThrow();
    });
});
