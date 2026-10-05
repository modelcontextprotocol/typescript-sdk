/**
 * Unknown custom formats (e.g. google-duration) should not spam the console.
 * The default AJV instance skips validation for formats it does not know;
 * it should do so quietly while still enforcing known formats.
 */

import { vi } from 'vitest';

import { AjvJsonSchemaValidator } from '../../src/validation/ajv-provider.js';
import type { JsonSchemaType } from '../../src/validation/types.js';

describe('AjvJsonSchemaValidator unknown formats', () => {
    it('compiles custom formats without warning and skips their validation', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const schema: JsonSchemaType = {
                type: 'object',
                properties: {
                    alignmentPeriod: { type: 'string', format: 'google-duration' }
                }
            };
            const validator = new AjvJsonSchemaValidator().getValidator(schema);

            expect(warn).not.toHaveBeenCalled();
            expect(validator({ alignmentPeriod: '3600s' }).valid).toBe(true);
            expect(validator({ alignmentPeriod: 'bogus' }).valid).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });

    it('still enforces known formats', () => {
        const schema: JsonSchemaType = { type: 'string', format: 'email' };
        const validator = new AjvJsonSchemaValidator().getValidator(schema);

        expect(validator('user@example.com').valid).toBe(true);
        expect(validator('invalid-email').valid).toBe(false);
    });
});
