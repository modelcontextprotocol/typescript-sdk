import { afterEach, describe, expect, it, vi } from 'vitest';
import * as zOld from 'zod-v40';
import * as z from 'zod/v4';

import { standardSchemaToJsonSchema } from '../../src/util/standardSchema.js';

type SchemaArg = Parameters<typeof standardSchemaToJsonSchema>[0];

// `zod-v40` is an npm alias for zod@4.0.x: a real second zod instance that implements
// StandardSchemaV1 but not `~standard.jsonSchema` (added in 4.2). Because zod stores
// `.describe()` text in a per-instance global registry, the SDK-bundled `z.toJSONSchema()`
// cannot see any metadata attached through a foreign instance — exactly the situation of
// an application that depends on zod 4.0/4.1 (or the zod@3.25.x `zod/v4` subpath) while
// the SDK bundles its own zod. These tests pin the fallback's behavior for that case.

function props(result: Record<string, unknown>): Record<string, { description?: string; items?: { description?: string } }> {
    return result.properties as Record<string, { description?: string; items?: { description?: string } }>;
}

describe('standardSchemaToJsonSchema — foreign zod instance description recovery', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('recovers .describe() metadata that the bundled converter cannot see', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const schema = zOld
            .object({
                name: zOld.string().describe('the display name'),
                age: zOld.number().optional().describe('age in years'),
                nickname: zOld.string().describe('preferred short name').optional(),
                address: zOld
                    .object({
                        street: zOld.string().describe('street and house number')
                    })
                    .describe('postal address'),
                tags: zOld.array(zOld.string().describe('a single tag')).describe('all tags')
            })
            .describe('a person');

        const result = standardSchemaToJsonSchema(schema as unknown as SchemaArg);

        expect(result.description).toBe('a person');
        expect(props(result).name?.description).toBe('the display name');
        // .describe() applied after .optional() (registry entry on the wrapper)
        expect(props(result).age?.description).toBe('age in years');
        // .describe() applied before .optional() (registry entry on the inner schema)
        expect(props(result).nickname?.description).toBe('preferred short name');
        expect(props(result).address?.description).toBe('postal address');
        const address = props(result).address as { properties?: Record<string, { description?: string }> };
        expect(address.properties?.street?.description).toBe('street and house number');
        expect(props(result).tags?.description).toBe('all tags');
        expect(props(result).tags?.items?.description).toBe('a single tag');
    });

    it('does not overwrite descriptions the converter already produced', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Bundled-instance schema with `~standard.jsonSchema` hidden: the converter shares
        // the schema's registry, so its own description survives conversion and must win.
        const real = z.object({ a: z.string().describe('from converter') });
        const { jsonSchema: _drop, ...stdNoJson } = real['~standard'] as unknown as Record<string, unknown>;
        void _drop;
        Object.defineProperty(real, '~standard', { value: { ...stdNoJson, vendor: 'zod' }, configurable: true });

        const result = standardSchemaToJsonSchema(real as unknown as SchemaArg);
        expect(props(result).a?.description).toBe('from converter');
    });

    it('recovery never throws, even when foreign getters do', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const schema = zOld.object({ a: zOld.string() });
        Object.defineProperty(schema, 'description', {
            get() {
                throw new Error('hostile getter');
            },
            configurable: true
        });

        expect(() => standardSchemaToJsonSchema(schema as unknown as SchemaArg)).not.toThrow();
    });

    it('zod 3 schemas still get the clear upgrade error', () => {
        const zod3ish = { _def: {}, '~standard': { version: 1, vendor: 'zod', validate: () => ({ value: {} }) } };
        expect(() => standardSchemaToJsonSchema(zod3ish as unknown as SchemaArg)).toThrow(/zod 3/);
    });
});

describe('standardSchemaToJsonSchema — fallback warning controls', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    async function freshConvert(schema: unknown): Promise<string[]> {
        // Fresh module instance so the once-per-process warning flag is reset.
        vi.resetModules();
        const warnings: string[] = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => {
            warnings.push(String(msg));
        });
        const mod = await import('../../src/util/standardSchema.js');
        mod.standardSchemaToJsonSchema(schema as Parameters<typeof mod.standardSchemaToJsonSchema>[0]);
        mod.standardSchemaToJsonSchema(schema as Parameters<typeof mod.standardSchemaToJsonSchema>[0]);
        warn.mockRestore();
        return warnings;
    }

    it('warns once per process and points at zod 4.2.0', async () => {
        const warnings = await freshConvert(zOld.object({ a: zOld.string() }));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('zod 4.2.0');
        expect(warnings[0]).toContain('MCP_SUPPRESS_ZOD_FALLBACK_WARNING');
    });

    it('is silenced by MCP_SUPPRESS_ZOD_FALLBACK_WARNING', async () => {
        vi.stubEnv('MCP_SUPPRESS_ZOD_FALLBACK_WARNING', '1');
        const warnings = await freshConvert(zOld.object({ a: zOld.string() }));
        expect(warnings).toHaveLength(0);
    });
});
