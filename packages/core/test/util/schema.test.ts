/**
 * Tests for schema utility functions
 */

import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';
import { getParseErrorMessage, parseSchema } from '../../src/util/schema.js';

describe('getParseErrorMessage', () => {
    test('should preserve custom error messages from Zod v4', () => {
        const schema = z.object({
            name: z.string().min(1, 'Name is required'),
            email: z.string().email('Please provide a valid email address'),
            age: z.number().min(18, 'Must be at least 18 years old')
        });

        // Test with invalid data that should trigger custom errors
        const parseResult = parseSchema(schema, {
            name: '',
            email: 'invalid-email',
            age: 16
        });

        expect(parseResult.success).toBe(false);
        if (!parseResult.success) {
            const errorMessage = getParseErrorMessage(parseResult.error);

            // The error message should contain our custom messages
            expect(errorMessage).toContain('Name is required');
            expect(errorMessage).toContain('Please provide a valid email address');
            expect(errorMessage).toContain('Must be at least 18 years old');
        }
    });

    test('should handle single custom error message', () => {
        const schema = z.string().min(1, 'My custom error');

        const parseResult = parseSchema(schema, '');

        expect(parseResult.success).toBe(false);
        if (!parseResult.success) {
            const errorMessage = getParseErrorMessage(parseResult.error);
            expect(errorMessage).toBe('My custom error');
        }
    });

    test('should fall back to default error messages when no custom message is provided', () => {
        const schema = z.string().min(5); // No custom message

        const parseResult = parseSchema(schema, 'abc');

        expect(parseResult.success).toBe(false);
        if (!parseResult.success) {
            const errorMessage = getParseErrorMessage(parseResult.error);
            // Should contain some error message (exact wording may vary)
            expect(errorMessage).toBeTruthy();
            expect(errorMessage.length).toBeGreaterThan(0);
        }
    });

    test('should handle nested object validation errors', () => {
        const schema = z.object({
            user: z.object({
                profile: z.object({
                    displayName: z.string().min(1, 'Display name cannot be empty')
                })
            })
        });

        const parseResult = parseSchema(schema, {
            user: {
                profile: {
                    displayName: ''
                }
            }
        });

        expect(parseResult.success).toBe(false);
        if (!parseResult.success) {
            const errorMessage = getParseErrorMessage(parseResult.error);
            expect(errorMessage).toContain('Display name cannot be empty');
        }
    });

    test('should prefer issue messages over Zod v4 JSON error.message output', () => {
        const schema = z.string().min(1, 'Custom error message');

        const parseResult = parseSchema(schema, '');

        expect(parseResult.success).toBe(false);
        if (!parseResult.success) {
            const ourMessage = getParseErrorMessage(parseResult.error);
            const zodMessage = parseResult.error.message;

            expect(zodMessage).toContain('"message": "Custom error message"');
            expect(ourMessage).toBe('Custom error message');
            expect(ourMessage).not.toBe(zodMessage);
        }
    });

    test('should fall back to error.message when issues do not contain usable messages', () => {
        const fallbackMessage = 'Serialized Zod failure';
        const error = {
            issues: [{ message: '   ' }, {}],
            message: fallbackMessage
        } as unknown as z.core.$ZodError;

        expect(getParseErrorMessage(error)).toBe(fallbackMessage);
    });
});
