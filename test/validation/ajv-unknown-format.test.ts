import { afterEach, describe, expect, it, vi } from 'vitest';

import { AjvJsonSchemaValidator } from '../../src/validation/ajv-provider.js';
import type { JsonSchemaType } from '../../src/validation/types.js';

/**
 * Servers may declare vendor-specific string `format` values that this SDK does not
 * know about (e.g. `google-duration` used by the Google Monitoring MCP server).
 * JSON Schema treats `format` as an annotation, so those schemas must still validate,
 * and Ajv's "unknown format ... ignored" warnings must not flood the console every
 * time tool outputSchemas are compiled (see issue #2855).
 */
describe('AjvJsonSchemaValidator with unknown formats', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const schemaWithUnknownFormat: JsonSchemaType = {
        type: 'object',
        properties: {
            d: {
                type: 'string',
                format: 'google-duration'
            }
        }
    };

    it('does not warn about unknown formats', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const validator = new AjvJsonSchemaValidator();

        validator.getValidator(schemaWithUnknownFormat);

        const unknownFormatWarnings = warnSpy.mock.calls.filter(
            ([message]) => typeof message === 'string' && message.startsWith('unknown format')
        );
        expect(unknownFormatWarnings).toHaveLength(0);
    });

    it('stays quiet across repeated compiles of the same schema', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const validator = new AjvJsonSchemaValidator();

        for (let i = 0; i < 10; i++) {
            validator.getValidator(schemaWithUnknownFormat);
        }

        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('still validates data when the format is unknown', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const validator = new AjvJsonSchemaValidator();
        const validate = validator.getValidator<{ d: string }>(schemaWithUnknownFormat);

        const result = validate({ d: '1800s' });
        expect(result.valid).toBe(true);
        expect(result.data).toEqual({ d: '1800s' });

        const invalidResult = validate({ d: 5 });
        expect(invalidResult.valid).toBe(false);
        expect(invalidResult.errorMessage).toBeDefined();
    });

    it('still validates known formats', () => {
        const validator = new AjvJsonSchemaValidator();
        const validate = validator.getValidator<{ email: string }>({
            type: 'object',
            properties: {
                email: {
                    type: 'string',
                    format: 'email'
                }
            },
            required: ['email']
        });

        expect(validate({ email: 'user@example.com' }).valid).toBe(true);
        expect(validate({ email: 'not-an-email' }).valid).toBe(false);
    });
});
