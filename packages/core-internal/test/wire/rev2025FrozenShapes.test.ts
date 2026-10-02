/**
 * Q10-L2 byte-identity pins for the frozen 2025-11-25 wire shapes that were
 * decoupled from `types/schemas.ts` so the public/neutral schema layer can
 * evolve (SEP-2106 widening) without changing the 2025 wire-parse contract.
 * Each pin proves the FROZEN copy still rejects the SEP-2106 vocabulary on
 * the 2025 wire.
 */
import { describe, expect, it } from 'vitest';

import {
    CallToolResultSchema,
    CreateMessageResultWithToolsSchema,
    ListToolsResultSchema,
    ToolResultContentSchema,
    ToolSchema
} from '../../src/wire/rev2025-11-25/schemas';

describe('frozen 2025-11-25 wire shapes (Q10-L2)', () => {
    it('CallToolResultSchema rejects non-object structuredContent', () => {
        expect(CallToolResultSchema.safeParse({ content: [], structuredContent: [1, 2, 3] }).success).toBe(false);
        expect(CallToolResultSchema.safeParse({ content: [], structuredContent: 0 }).success).toBe(false);
        expect(CallToolResultSchema.safeParse({ content: [], structuredContent: { result: [1] } }).success).toBe(true);
    });

    it("ToolSchema rejects non-type:'object' outputSchema", () => {
        const base = { name: 't', inputSchema: { type: 'object' } };
        expect(ToolSchema.safeParse({ ...base, outputSchema: { type: 'array' } }).success).toBe(false);
        expect(ToolSchema.safeParse({ ...base, outputSchema: { type: 'object' } }).success).toBe(true);
    });

    it('ListToolsResultSchema composes the frozen ToolSchema', () => {
        const arr = { tools: [{ name: 't', inputSchema: { type: 'object' }, outputSchema: { type: 'array' } }] };
        expect(ListToolsResultSchema.safeParse(arr).success).toBe(false);
    });

    it('ToolResultContentSchema rejects non-object structuredContent', () => {
        const base = { type: 'tool_result', toolUseId: 'x', content: [] };
        expect(ToolResultContentSchema.safeParse({ ...base, structuredContent: [1] }).success).toBe(false);
        expect(ToolResultContentSchema.safeParse({ ...base, structuredContent: { ok: true } }).success).toBe(true);
    });

    it('CreateMessageResultWithToolsSchema composes the frozen tool_result arm', () => {
        const tr = { type: 'tool_result', toolUseId: 'x', content: [], structuredContent: [1] };
        expect(CreateMessageResultWithToolsSchema.safeParse({ model: 'm', role: 'assistant', content: [tr] }).success).toBe(false);
    });
});
