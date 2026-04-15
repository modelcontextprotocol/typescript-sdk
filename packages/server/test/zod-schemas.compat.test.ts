import * as z from 'zod/v4';

// Compat: the deprecated `/zod-schemas` subpath re-exports the internal Zod
// schema constants for v1 source compatibility. This test asserts the import
// resolves and the values are usable Zod schemas at runtime.
import {
    CallToolRequestSchema,
    getResultSchema,
    JSONRPCMessageSchema,
    ListToolsResultSchema
} from '@modelcontextprotocol/server/zod-schemas';

describe('@modelcontextprotocol/server/zod-schemas (compat subpath)', () => {
    it('re-exports Zod schema constants from core', () => {
        expect(CallToolRequestSchema).toBeInstanceOf(z.ZodType);
        expect(JSONRPCMessageSchema).toBeInstanceOf(z.ZodType);
        expect(ListToolsResultSchema).toBeInstanceOf(z.ZodType);
    });

    it('re-exports the get*Schema lookup helpers', () => {
        expect(getResultSchema('tools/call')).toBeInstanceOf(z.ZodType);
    });

    it('schemas parse valid spec values', () => {
        const parsed = CallToolRequestSchema.parse({
            method: 'tools/call',
            params: { name: 'echo', arguments: {} }
        });
        expect(parsed.method).toBe('tools/call');
        expect(parsed.params.name).toBe('echo');
    });
});
