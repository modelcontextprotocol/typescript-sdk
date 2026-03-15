import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { schemaToJson } from '../src/util/schema.js';

describe('schemaToJson', () => {
    test('adds empty required arrays for empty object schemas recursively', () => {
        const schema = z.object({
            nested: z.object({}).strict(),
            configured: z.object({
                name: z.string()
            })
        });

        expect(schemaToJson(schema)).toEqual({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
                nested: {
                    type: 'object',
                    properties: {},
                    required: [],
                    additionalProperties: false
                },
                configured: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string'
                        }
                    },
                    required: ['name'],
                    additionalProperties: false
                }
            },
            required: ['nested', 'configured'],
            additionalProperties: false
        });
    });

    test('does not normalize literal values in default fields', () => {
        const schema = z.any().default({
            type: 'object',
            properties: {}
        });

        expect(schemaToJson(schema)).toEqual({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            default: {
                type: 'object',
                properties: {}
            }
        });
    });
});
