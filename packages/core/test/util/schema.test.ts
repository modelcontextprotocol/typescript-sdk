import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { schemaToJson } from '../../src/util/schema.js';

describe('schemaToJson', () => {
    describe('required field handling for OpenAI compatibility', () => {
        // https://github.com/modelcontextprotocol/typescript-sdk/issues/1659
        it('should include empty required array for empty object schemas', () => {
            const schema = z.object({}).strict();
            const jsonSchema = schemaToJson(schema);

            expect(jsonSchema.type).toBe('object');
            expect(jsonSchema.required).toEqual([]);
        });

        it('should include empty required array for objects with only optional properties', () => {
            const schema = z.object({
                name: z.string().optional()
            });
            const jsonSchema = schemaToJson(schema);

            expect(jsonSchema.type).toBe('object');
            expect(jsonSchema.required).toEqual([]);
        });

        it('should preserve required array for objects with required properties', () => {
            const schema = z.object({
                name: z.string(),
                age: z.number().optional()
            });
            const jsonSchema = schemaToJson(schema);

            expect(jsonSchema.type).toBe('object');
            expect(jsonSchema.required).toEqual(['name']);
        });

        it('should add required field to nested object schemas', () => {
            const schema = z.object({
                nested: z.object({}).strict()
            });
            const jsonSchema = schemaToJson(schema);

            const nestedSchema = (jsonSchema.properties as Record<string, unknown>).nested as Record<string, unknown>;
            expect(nestedSchema.type).toBe('object');
            expect(nestedSchema.required).toEqual([]);
        });

        it('should add required field to array item schemas', () => {
            const schema = z.array(z.object({}).strict());
            const jsonSchema = schemaToJson(schema);

            const itemsSchema = jsonSchema.items as Record<string, unknown>;
            expect(itemsSchema.type).toBe('object');
            expect(itemsSchema.required).toEqual([]);
        });

        it('should add required field to deeply nested object schemas', () => {
            const schema = z.object({
                level1: z.object({
                    level2: z.object({
                        level3: z.object({}).strict()
                    })
                })
            });
            const jsonSchema = schemaToJson(schema);

            const level1 = (jsonSchema.properties as Record<string, unknown>).level1 as Record<string, unknown>;
            const level2 = (level1.properties as Record<string, unknown>).level2 as Record<string, unknown>;
            const level3 = (level2.properties as Record<string, unknown>).level3 as Record<string, unknown>;

            expect(level3.type).toBe('object');
            expect(level3.required).toEqual([]);
        });

        it('should add required field to union schemas (anyOf)', () => {
            const schema = z.union([
                z.object({}).strict(),
                z.object({ name: z.string().optional() })
            ]);
            const jsonSchema = schemaToJson(schema);

            // Union creates an anyOf schema
            expect(jsonSchema.anyOf).toBeDefined();
            const variants = jsonSchema.anyOf as Record<string, unknown>[];
            
            // Both variants should have required field
            for (const variant of variants) {
                if (variant.type === 'object') {
                    expect(variant.required).toBeDefined();
                    expect(Array.isArray(variant.required)).toBe(true);
                }
            }
        });

        it('should not mutate the original schema', () => {
            const schema = z.object({}).strict();
            const originalJsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
            const hasRequiredBefore = 'required' in originalJsonSchema;
            
            // Call schemaToJson
            schemaToJson(schema);
            
            // Original should not be mutated
            const hasRequiredAfter = 'required' in originalJsonSchema;
            expect(hasRequiredBefore).toBe(hasRequiredAfter);
        });
    });
});
