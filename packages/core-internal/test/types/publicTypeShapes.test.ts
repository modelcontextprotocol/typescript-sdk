/**
 * SEP-2106 public-type pins.
 *
 * The neutral/public schemas in `types/schemas.ts` widen `structuredContent` (any JSON value)
 * and `Tool.outputSchema` (any JSON Schema document). The 2025 wire-parse contract is preserved
 * via the FROZEN copies in `wire/rev2025-11-25/schemas.ts`. This file pins both:
 * - the public TypeScript types carry the widened shapes (type-level pins);
 * - the frozen 2025 wire schemas still REJECT the widened vocabulary (runtime pins).
 *
 * The 2025 spec-anchor parity for these names lives in `spec.types.2025-11-25.test.ts` and
 * targets the frozen wire schemas, not the public types.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
    CallToolResult,
    CompatibilityCallToolResult,
    CreateMessageResultWithTools,
    ListToolsResult,
    SamplingMessage,
    SamplingMessageContentBlock,
    Tool,
    ToolResultContent
} from '../../src/types/types.js';
import {
    CallToolResultSchema as Wire2025CallToolResultSchema,
    ToolSchema as Wire2025ToolSchema
} from '../../src/wire/rev2025-11-25/schemas.js';

describe('SEP-2106 public-type widening', () => {
    it('CallToolResult.structuredContent is unknown', () => {
        expectTypeOf<CallToolResult['structuredContent']>().toEqualTypeOf<unknown>();
    });
    it('CompatibilityCallToolResult.structuredContent is unknown (on the modern arm)', () => {
        expectTypeOf<Extract<CompatibilityCallToolResult, { content: unknown[] }>['structuredContent']>().toEqualTypeOf<unknown>();
    });
    it('ToolResultContent.structuredContent is unknown', () => {
        expectTypeOf<ToolResultContent['structuredContent']>().toEqualTypeOf<unknown>();
    });
    it('SamplingMessageContentBlock tool_result arm carries unknown structuredContent', () => {
        expectTypeOf<Extract<SamplingMessageContentBlock, { type: 'tool_result' }>['structuredContent']>().toEqualTypeOf<unknown>();
    });
    it('SamplingMessage.content composes the widened tool_result arm', () => {
        type Block = Extract<Exclude<SamplingMessage['content'], unknown[]>, { type: 'tool_result' }>;
        expectTypeOf<Block['structuredContent']>().toEqualTypeOf<unknown>();
    });
    it('CreateMessageResultWithTools.content composes the widened tool_result arm', () => {
        type Block = Extract<Exclude<CreateMessageResultWithTools['content'], unknown[]>, { type: 'tool_result' }>;
        expectTypeOf<Block['structuredContent']>().toEqualTypeOf<unknown>();
    });
    it('Tool.outputSchema is an open JSON Schema document', () => {
        expectTypeOf<NonNullable<Tool['outputSchema']>>().toEqualTypeOf<{ $schema?: string; [k: string]: unknown }>();
    });
    it('ListToolsResult.tools composes the widened Tool', () => {
        expectTypeOf<NonNullable<ListToolsResult['tools'][number]['outputSchema']>>().toEqualTypeOf<{
            $schema?: string;
            [k: string]: unknown;
        }>();
    });
});

describe('Q10-L2: frozen 2025 wire schemas still reject SEP-2106 vocabulary', () => {
    it('Wire2025 CallToolResultSchema rejects non-object structuredContent', () => {
        expect(Wire2025CallToolResultSchema.safeParse({ content: [], structuredContent: [1] }).success).toBe(false);
        expect(Wire2025CallToolResultSchema.safeParse({ content: [], structuredContent: 0 }).success).toBe(false);
        expect(Wire2025CallToolResultSchema.safeParse({ content: [], structuredContent: { ok: true } }).success).toBe(true);
    });
    it("Wire2025 ToolSchema rejects non-type:'object' outputSchema", () => {
        const base = { name: 't', inputSchema: { type: 'object' } };
        expect(Wire2025ToolSchema.safeParse({ ...base, outputSchema: { type: 'array' } }).success).toBe(false);
        expect(Wire2025ToolSchema.safeParse({ ...base, outputSchema: { type: 'object' } }).success).toBe(true);
    });
});
