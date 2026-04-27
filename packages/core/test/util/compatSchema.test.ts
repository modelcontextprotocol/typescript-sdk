import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { extractMethodLiteral, isResultSchemaLike, isZodLikeSchema } from '../../src/util/compatSchema.js';

describe('compatSchema helpers', () => {
    describe('isZodLikeSchema', () => {
        it('detects a Zod object schema', () => {
            expect(isZodLikeSchema(z.object({ method: z.literal('x') }))).toBe(true);
        });
        it('rejects strings, plain objects, and null', () => {
            expect(isZodLikeSchema('tools/call')).toBe(false);
            expect(isZodLikeSchema({ shape: {} })).toBe(false);
            expect(isZodLikeSchema(null)).toBe(false);
        });
    });

    describe('extractMethodLiteral', () => {
        it('reads the method literal from a Zod object schema', () => {
            expect(extractMethodLiteral(z.object({ method: z.literal('acme/echo') }))).toBe('acme/echo');
        });
        it('throws when no string method literal is present', () => {
            expect(() => extractMethodLiteral(z.object({ method: z.string() }))).toThrow(TypeError);
            expect(() => extractMethodLiteral(z.object({}))).toThrow(TypeError);
        });
    });

    describe('isResultSchemaLike', () => {
        it('detects Standard Schema (~standard) and Zod-style parse()', () => {
            expect(isResultSchemaLike(z.string())).toBe(true);
            expect(isResultSchemaLike({ '~standard': { version: 1, vendor: 't', validate: () => ({ value: 1 }) } })).toBe(true);
            expect(isResultSchemaLike({ parse: (v: unknown) => v })).toBe(true);
        });
        it('rejects RequestOptions-shaped objects, undefined, and primitives', () => {
            expect(isResultSchemaLike({ timeout: 100 })).toBe(false);
            expect(isResultSchemaLike(undefined)).toBe(false);
            expect(isResultSchemaLike('x')).toBe(false);
        });
    });
});
