import { describe, expect, test } from 'vitest';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SchemaError } from '@standard-schema/utils';

import { objectFromShape, safeParse, safeParseAsync } from './zod-compat.js';

const standardString: StandardSchemaV1<string> = {
    '~standard': {
        version: 1,
        vendor: 'custom',
        types: { input: '' as string, output: '' as string },
        validate(value) {
            return typeof value === 'string' ? { value } : { issues: [{ message: 'Expected string', path: [] }] };
        }
    }
};

describe('zod-compat with Standard Schema', () => {
    test('safeParse works with Standard Schema input', () => {
        const success = safeParse(standardString, 'hello');
        expect(success.success).toBe(true);
        if (success.success) {
            expect(success.data).toBe('hello');
        }

        const failure = safeParse(standardString, 42);
        expect(failure.success).toBe(false);
        if (!failure.success) {
            expect(failure.error).toBeInstanceOf(SchemaError);
        }
    });

    test('objectFromShape validates Standard Schema members', async () => {
        const shapeSchema = objectFromShape({ name: standardString });

        const ok = await safeParseAsync(shapeSchema, { name: 'world' });
        expect(ok.success).toBe(true);
        if (ok.success) {
            expect(ok.data).toEqual({ name: 'world' });
        }

        const bad = await safeParseAsync(shapeSchema, { name: 123 });
        expect(bad.success).toBe(false);
        if (!bad.success) {
            expect(bad.error).toBeInstanceOf(SchemaError);
            const issues = (bad.error as SchemaError).issues;
            expect(issues[0]?.path?.[0]).toBe('name');
        }
    });
});
