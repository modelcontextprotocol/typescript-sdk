import { Ajv as Draft7Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AjvJsonSchemaValidator } from '../../src/validators/ajvProvider';
import type { JsonSchemaType } from '../../src/validators/types';

const vendorFormatSchema: JsonSchemaType = {
    type: 'object',
    properties: {
        a: { type: 'string', format: 'google-duration' },
        b: { type: 'string', format: 'vendor-specific-format' },
        nested: { type: 'object', properties: { c: { type: 'string', format: 'google-duration' } } }
    },
    required: ['a']
};

const dialects = [
    { name: 'default', schema: undefined, Engine: Ajv2020 },
    { name: '2020-12', schema: 'https://json-schema.org/draft/2020-12/schema', Engine: Ajv2020 },
    { name: '2019-09', schema: 'https://json-schema.org/draft/2019-09/schema', Engine: Ajv2019 },
    { name: 'draft-07', schema: 'http://json-schema.org/draft-07/schema#', Engine: Draft7Ajv },
    { name: 'draft-06', schema: 'http://json-schema.org/draft-06/schema#', Engine: Draft7Ajv }
];

afterEach(() => vi.restoreAllMocks());

describe.each(dialects)('unknown formats ($name)', ({ schema: dialect, Engine }) => {
    const schema: JsonSchemaType = { ...vendorFormatSchema, ...(dialect ? { $schema: dialect } : {}) };

    it('suppresses every warning across distinct schema compilations while preserving validation', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const provider = new AjvJsonSchemaValidator();
        for (let i = 0; i < 2; i++) {
            const validate = provider.getValidator({ ...schema, $id: `urn:test:unknown-format:${i}` });
            expect(validate({ a: 'not-a-duration', b: 'anything', nested: { c: 'anything' } }).valid).toBe(true);
            expect(validate({ a: 42 }).valid).toBe(false);
            expect(validate({}).valid).toBe(false);
        }
        expect(warn).not.toHaveBeenCalled();
    });

    it('still enforces known formats', () => {
        const validate = new AjvJsonSchemaValidator().getValidator({
            ...(dialect ? { $schema: dialect } : {}),
            type: 'string',
            format: 'email'
        });
        expect(validate('user@example.com').valid).toBe(true);
        expect(validate('not-an-email').valid).toBe(false);
    });

    it('preserves caller-supplied diagnostics, including two warnings per subschema path', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const engine = new Engine({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
        const logger = engine.logger;
        new AjvJsonSchemaValidator(engine).getValidator(schema);
        expect(engine.logger).toBe(logger);
        // Three paths each produce two warnings with the pinned Ajv version.
        expect(warn).toHaveBeenCalledTimes(6);
        for (const [format, path] of [
            ['google-duration', '#/properties/a'],
            ['vendor-specific-format', '#/properties/b'],
            ['google-duration', '#/properties/nested/properties/c']
        ]) {
            const message = `unknown format "${format}" ignored in schema at path "${path}"`;
            expect(warn.mock.calls.filter(([value]) => value === message)).toHaveLength(2);
        }
    });
});

it('forwards other logger messages and their arguments unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const detail = { schema: 'example' };
    const compile = Ajv2020.prototype.compile;
    vi.spyOn(Ajv2020.prototype, 'compile').mockImplementation(function (this: Ajv2020, schema) {
        this.logger.warn('another warning', detail);
        this.logger.warn(detail, 'extra');
        this.logger.log('unknown format diagnostic', detail);
        this.logger.error('unknown format diagnostic', detail);
        return compile.call(this, schema);
    });
    new AjvJsonSchemaValidator().getValidator({ type: 'string' });
    expect(warn.mock.calls).toEqual([
        ['another warning', detail],
        [detail, 'extra']
    ]);
    expect(log).toHaveBeenCalledExactlyOnceWith('unknown format diagnostic', detail);
    expect(error).toHaveBeenCalledExactlyOnceWith('unknown format diagnostic', detail);
});
