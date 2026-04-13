import { describe, expect, expectTypeOf, it } from 'vitest';

import type { OAuthMetadata, OAuthTokens } from '../../src/shared/auth.js';
import type { SpecTypeName, SpecTypes } from '../../src/types/specTypeSchema.js';
import { isSpecType, specTypeSchema } from '../../src/types/specTypeSchema.js';
import type { CallToolResult, ContentBlock, Implementation, JSONRPCRequest, Tool } from '../../src/types/types.js';

describe('specTypeSchema()', () => {
    it('returns a StandardSchemaV1 validator that accepts valid values', () => {
        const schema = specTypeSchema('Implementation');
        const result = schema['~standard'].validate({ name: 'x', version: '1.0.0' });
        expect((result as { issues?: unknown }).issues).toBeUndefined();
    });

    it('returns a validator that rejects invalid values with issues', () => {
        const schema = specTypeSchema('Implementation');
        const result = schema['~standard'].validate({ name: 'x' });
        expect((result as { issues?: readonly unknown[] }).issues?.length).toBeGreaterThan(0);
    });

    it('throws TypeError for an unknown name', () => {
        expect(() => specTypeSchema('NotASpecType' as SpecTypeName)).toThrow(TypeError);
    });

    it('covers JSON-RPC envelope types', () => {
        const ok = specTypeSchema('JSONRPCRequest')['~standard'].validate({ jsonrpc: '2.0', id: 1, method: 'ping' });
        expect((ok as { issues?: unknown }).issues).toBeUndefined();
    });

    it('covers OAuth types from shared/auth.ts', () => {
        const ok = specTypeSchema('OAuthTokens')['~standard'].validate({ access_token: 'x', token_type: 'Bearer' });
        expect((ok as { issues?: unknown }).issues).toBeUndefined();
        const bad = specTypeSchema('OAuthTokens')['~standard'].validate({ token_type: 'Bearer' });
        expect((bad as { issues?: readonly unknown[] }).issues?.length).toBeGreaterThan(0);
    });
});

describe('isSpecType()', () => {
    it('CallToolResult — accepts valid, rejects invalid/null/primitive', () => {
        expect(isSpecType('CallToolResult', { content: [{ type: 'text', text: 'hi' }] })).toBe(true);
        expect(isSpecType('CallToolResult', { content: 'not-an-array' })).toBe(false);
        expect(isSpecType('CallToolResult', null)).toBe(false);
        expect(isSpecType('CallToolResult', 'string')).toBe(false);
    });

    it('ContentBlock — accepts text block, rejects wrong shape', () => {
        expect(isSpecType('ContentBlock', { type: 'text', text: 'hi' })).toBe(true);
        expect(isSpecType('ContentBlock', { type: 'text' })).toBe(false);
        expect(isSpecType('ContentBlock', {})).toBe(false);
    });

    it('Tool — accepts valid, rejects missing inputSchema', () => {
        expect(isSpecType('Tool', { name: 'echo', inputSchema: { type: 'object' } })).toBe(true);
        expect(isSpecType('Tool', { name: 'echo' })).toBe(false);
    });

    it('returns false (not throw) for unknown name', () => {
        expect(isSpecType('NotASpecType' as SpecTypeName, {})).toBe(false);
    });

    it('narrows the value type', () => {
        const v: unknown = { name: 'x', version: '1.0.0' };
        if (isSpecType('Implementation', v)) {
            expectTypeOf(v).toEqualTypeOf<SpecTypes['Implementation']>();
        }
    });
});

describe('SpecTypeName / SpecTypes (type-level)', () => {
    it('SpecTypeName includes representative names', () => {
        expectTypeOf<'CallToolResult'>().toMatchTypeOf<SpecTypeName>();
        expectTypeOf<'ContentBlock'>().toMatchTypeOf<SpecTypeName>();
        expectTypeOf<'Tool'>().toMatchTypeOf<SpecTypeName>();
        expectTypeOf<'Implementation'>().toMatchTypeOf<SpecTypeName>();
        expectTypeOf<'JSONRPCRequest'>().toMatchTypeOf<SpecTypeName>();
        expectTypeOf<'OAuthTokens'>().toMatchTypeOf<SpecTypeName>();
        expectTypeOf<'OAuthMetadata'>().toMatchTypeOf<SpecTypeName>();
    });

    it('SpecTypes[K] matches the named export type', () => {
        expectTypeOf<SpecTypes['CallToolResult']>().toEqualTypeOf<CallToolResult>();
        expectTypeOf<SpecTypes['ContentBlock']>().toEqualTypeOf<ContentBlock>();
        expectTypeOf<SpecTypes['Tool']>().toEqualTypeOf<Tool>();
        expectTypeOf<SpecTypes['Implementation']>().toEqualTypeOf<Implementation>();
        expectTypeOf<SpecTypes['JSONRPCRequest']>().toEqualTypeOf<JSONRPCRequest>();
        expectTypeOf<SpecTypes['OAuthTokens']>().toEqualTypeOf<OAuthTokens>();
        expectTypeOf<SpecTypes['OAuthMetadata']>().toEqualTypeOf<OAuthMetadata>();
    });
});
