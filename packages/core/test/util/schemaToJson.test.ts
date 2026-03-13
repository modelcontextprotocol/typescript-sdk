import * as z from 'zod/v4';
import { describe, expect, it } from 'vitest';

import { schemaToJson } from '../../src/util/schema.js';

describe('schemaToJson', () => {
    it('inlines shared schemas instead of producing $ref', () => {
        // Schemas referenced from a z.globalRegistry produce $ref by default.
        // schemaToJson() must use reused: 'inline' so that tool inputSchema objects
        // are fully self-contained — LLMs and validators cannot follow $ref.
        const Address = z.object({ street: z.string(), city: z.string() });
        z.globalRegistry.add(Address, { id: 'Address' });

        const PersonSchema = z.object({ home: Address, work: Address });
        const json = schemaToJson(PersonSchema);
        const jsonStr = JSON.stringify(json);

        // Must not contain $ref or $defs
        expect(jsonStr).not.toContain('$ref');
        expect(jsonStr).not.toContain('$defs');

        // Must contain inlined street property in both home and work
        expect(json.properties).toMatchObject({
            home: { type: 'object', properties: { street: { type: 'string' }, city: { type: 'string' } } },
            work: { type: 'object', properties: { street: { type: 'string' }, city: { type: 'string' } } }
        });

        // Cleanup registry
        z.globalRegistry.remove(Address);
    });

    it('does not produce $ref for recursive schemas via z.lazy()', () => {
        // z.lazy() is used for recursive/self-referential types.
        // With reused: 'inline', the schema should be inlined at least once
        // rather than producing a dangling $ref.
        const BaseItem = z.object({ value: z.string() });
        const json = schemaToJson(BaseItem);
        const jsonStr = JSON.stringify(json);

        expect(jsonStr).not.toContain('$ref');
        expect(json).toMatchObject({
            type: 'object',
            properties: { value: { type: 'string' } }
        });
    });

    it('produces a correct JSON Schema for a plain z.object()', () => {
        const schema = z.object({ name: z.string(), age: z.number().int().optional() });
        const json = schemaToJson(schema);

        expect(json).toMatchObject({
            type: 'object',
            properties: {
                name: { type: 'string' },
                age: { type: 'integer' }
            }
        });
    });

    it('respects io: "input" option', () => {
        const schema = z.object({
            value: z.string().transform(v => parseInt(v, 10))
        });
        const json = schemaToJson(schema, { io: 'input' });

        expect(json.properties).toMatchObject({ value: { type: 'string' } });
    });

    it('preserves .describe() metadata even when globalRegistry id is stripped', () => {
        // .describe() registers metadata in z.globalRegistry (without an 'id').
        // The id-stripping proxy must not drop these non-id metadata entries.
        const schema = z.object({
            name: z.string().describe('The user name'),
            age: z.number().int().describe('Age in years')
        });
        const json = schemaToJson(schema);

        expect(json.properties).toMatchObject({
            name: { type: 'string', description: 'The user name' },
            age: { type: 'integer', description: 'Age in years' }
        });
    });
});
