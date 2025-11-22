import { describe, expect, test } from 'vitest';
import { object, string } from 'valibot';

import { safeParseAsync, type AnyObjectSchema } from './zod-compat.js';
import { toJsonSchemaCompat } from './zod-json-schema-compat.js';

describe('Standard Schema (Valibot) compatibility', () => {
    const valibotSchema = object({ name: string() });

    test('safeParseAsync validates Valibot schema', async () => {
        const ok = await safeParseAsync(valibotSchema, { name: 'alice' });
        expect(ok.success).toBe(true);
        if (ok.success) {
            expect(ok.data).toEqual({ name: 'alice' });
        }

        const bad = await safeParseAsync(valibotSchema, { name: 123 });
        expect(bad.success).toBe(false);
    });

    test('toJsonSchemaCompat converts Valibot schema to JSON Schema', async () => {
        const jsonSchema = await toJsonSchemaCompat(valibotSchema as unknown as AnyObjectSchema, {
            pipeStrategy: 'input'
        });

        expect(jsonSchema).toMatchObject({
            type: 'object',
            properties: {
                name: { type: 'string' }
            },
            required: ['name']
        });
    });
});
