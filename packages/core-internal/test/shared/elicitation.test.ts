import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { normalizeElicitInputFormParams } from '../../src/shared/elicitation';
import { ProtocolError } from '../../src/types/errors';
import type { StandardSchemaWithJSON } from '../../src/util/standardSchema';

function schemaFromJson(jsonSchema: Record<string, unknown>): StandardSchemaWithJSON {
    return {
        '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value: unknown) => ({ value }),
            jsonSchema: {
                input: () => jsonSchema,
                output: () => ({})
            }
        }
    } satisfies StandardSchemaWithJSON;
}

describe('normalizeElicitInputFormParams root keywords', () => {
    test('keeps the spec-declared root keys including $schema', () => {
        const { params } = normalizeElicitInputFormParams({
            message: 'Name?',
            requestedSchema: z.object({ name: z.string() })
        });

        expect(params.requestedSchema).toEqual({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        });
    });

    test('drops annotation-only root keywords', () => {
        const { params } = normalizeElicitInputFormParams({
            message: 'Name?',
            requestedSchema: z.object({ name: z.string() }).meta({ title: 'User', description: 'User info', 'x-ui-hint': 'compact' })
        });

        expect(params.requestedSchema).toEqual({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        });
    });

    test.each([
        ['z.strictObject emits additionalProperties: false', z.strictObject({ name: z.string() }), /additionalProperties/],
        ['z.looseObject emits additionalProperties: {}', z.looseObject({ name: z.string() }), /additionalProperties/],
        [
            'catchall emits a nested schema under additionalProperties',
            z.object({ name: z.string() }).catchall(z.object({ x: z.string() })),
            /additionalProperties/
        ],
        ['a root default cannot ride the wire', z.object({ name: z.string() }).default({ name: 'x' }), /default/],
        [
            'a custom schema emitting $defs',
            schemaFromJson({
                $defs: { Name: { type: 'string' } },
                type: 'object',
                properties: { name: { $ref: '#/$defs/Name' } },
                required: ['name']
            }),
            /\$defs/
        ]
    ])('rejects unsupported root keywords: %s', (_label, requestedSchema, message) => {
        const params = { message: 'Name?', requestedSchema } as Parameters<typeof normalizeElicitInputFormParams>[0];
        const act = () => normalizeElicitInputFormParams(params);
        expect(act).toThrow(ProtocolError);
        expect(act).toThrow(/unsupported JSON Schema keyword\(s\)/);
        expect(act).toThrow(message);
    });
});

describe('normalizeElicitInputFormParams redundant format patterns', () => {
    test.each([
        ['z.email()', z.email(), 'email'],
        ['z.url()', z.url(), 'uri'],
        ['z.iso.date()', z.iso.date(), 'date'],
        ['z.iso.datetime()', z.iso.datetime(), 'date-time'],
        ['z.iso.datetime({ offset: true })', z.iso.datetime({ offset: true }), 'date-time'],
        ['z.iso.datetime({ local: true })', z.iso.datetime({ local: true }), 'date-time'],
        ['z.iso.datetime({ precision: -1 })', z.iso.datetime({ precision: -1 }), 'date-time'],
        ['z.iso.datetime({ precision: 0 })', z.iso.datetime({ precision: 0 }), 'date-time'],
        ['z.iso.datetime({ precision: 3, offset: true })', z.iso.datetime({ precision: 3, offset: true }), 'date-time']
    ])('accepts %s and strips the zod-emitted pattern', (_label, fieldSchema, format) => {
        const { params } = normalizeElicitInputFormParams({
            message: 'Value?',
            requestedSchema: z.object({ value: fieldSchema })
        });

        const valueSchema = (params.requestedSchema.properties as Record<string, Record<string, unknown>>).value!;
        expect(valueSchema.format).toBe(format);
        expect(valueSchema.pattern).toBeUndefined();
    });

    test('accepts exactly the pattern the installed zod emits for a format', () => {
        const emittedPattern = (z.toJSONSchema(z.email(), { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>)
            .pattern as string;
        const { params } = normalizeElicitInputFormParams({
            message: 'Email?',
            requestedSchema: schemaFromJson({
                type: 'object',
                properties: { email: { type: 'string', format: 'email', pattern: emittedPattern } },
                required: ['email']
            })
        });

        const emailSchema = (params.requestedSchema.properties as Record<string, Record<string, unknown>>).email!;
        expect(emailSchema.format).toBe('email');
        expect(emailSchema.pattern).toBeUndefined();
    });

    test.each([
        ['a customized email pattern', z.object({ email: z.email({ pattern: /@corp\.com$/ }) }), /properties\.email\.pattern/],
        [
            'a pattern the installed zod would not emit for the format',
            schemaFromJson({
                type: 'object',
                properties: { email: { type: 'string', format: 'email', pattern: '^different$' } },
                required: ['email']
            }),
            /properties\.email\.pattern/
        ],
        ['a pattern without a supported format', z.object({ code: z.string().regex(/^[A-Z]{3}$/) }), /properties\.code\.pattern/]
    ])('rejects %s', (_label, requestedSchema, message) => {
        const params = { message: 'Value?', requestedSchema } as Parameters<typeof normalizeElicitInputFormParams>[0];
        const act = () => normalizeElicitInputFormParams(params);
        expect(act).toThrow(ProtocolError);
        expect(act).toThrow(message);
    });
});
