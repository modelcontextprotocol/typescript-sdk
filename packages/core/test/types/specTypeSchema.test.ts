import { describe, expect, expectTypeOf, it } from 'vitest';

import type { OAuthMetadata, OAuthTokens } from '../../src/shared/auth.js';
import type { SpecTypeName, SpecTypes } from '../../src/types/specTypeSchema.js';
import { isSpecType, specTypeSchemas } from '../../src/types/specTypeSchema.js';
import type { CallToolResult, ContentBlock, Implementation, JSONRPCRequest, Tool } from '../../src/types/types.js';

describe('specTypeSchemas', () => {
    it('returns a StandardSchemaV1 validator that accepts valid values', () => {
        const result = specTypeSchemas.Implementation['~standard'].validate({ name: 'x', version: '1.0.0' });
        expect((result as { issues?: unknown }).issues).toBeUndefined();
    });

    it('returns a validator that rejects invalid values with issues', () => {
        const result = specTypeSchemas.Implementation['~standard'].validate({ name: 'x' });
        expect((result as { issues?: readonly unknown[] }).issues?.length).toBeGreaterThan(0);
    });

    it('rejects unknown names at compile time and is undefined at runtime', () => {
        // @ts-expect-error - 'NotASpecType' is not a SpecTypeName
        expect(specTypeSchemas['NotASpecType']).toBeUndefined();
    });

    it('covers JSON-RPC envelope types', () => {
        const ok = specTypeSchemas.JSONRPCRequest['~standard'].validate({ jsonrpc: '2.0', id: 1, method: 'ping' });
        expect((ok as { issues?: unknown }).issues).toBeUndefined();
    });

    it('covers OAuth types from shared/auth.ts', () => {
        const ok = specTypeSchemas.OAuthTokens['~standard'].validate({ access_token: 'x', token_type: 'Bearer' });
        expect((ok as { issues?: unknown }).issues).toBeUndefined();
        const bad = specTypeSchemas.OAuthTokens['~standard'].validate({ token_type: 'Bearer' });
        expect((bad as { issues?: readonly unknown[] }).issues?.length).toBeGreaterThan(0);
    });
});

describe('isSpecType', () => {
    it('CallToolResult — accepts valid, rejects invalid/null/primitive', () => {
        expect(isSpecType.CallToolResult({ content: [{ type: 'text', text: 'hi' }] })).toBe(true);
        expect(isSpecType.CallToolResult({ content: 'not-an-array' })).toBe(false);
        expect(isSpecType.CallToolResult(null)).toBe(false);
        expect(isSpecType.CallToolResult('string')).toBe(false);
    });

    it('ContentBlock — accepts text block, rejects wrong shape', () => {
        expect(isSpecType.ContentBlock({ type: 'text', text: 'hi' })).toBe(true);
        expect(isSpecType.ContentBlock({ type: 'text' })).toBe(false);
        expect(isSpecType.ContentBlock({})).toBe(false);
    });

    it('Tool — accepts valid, rejects missing inputSchema', () => {
        expect(isSpecType.Tool({ name: 'echo', inputSchema: { type: 'object' } })).toBe(true);
        expect(isSpecType.Tool({ name: 'echo' })).toBe(false);
    });

    it('rejects unknown names at compile time and is undefined at runtime', () => {
        // @ts-expect-error - 'NotASpecType' is not a SpecTypeName
        expect(isSpecType['NotASpecType']).toBeUndefined();
    });

    it('excludes internal helper schemas (no matching public type)', () => {
        // @ts-expect-error - ListChangedOptionsBase is internal-only
        expect(isSpecType['ListChangedOptionsBase']).toBeUndefined();
        // @ts-expect-error - BaseRequestParams is internal-only
        expect(specTypeSchemas['BaseRequestParams']).toBeUndefined();
        // @ts-expect-error - NotificationsParams is internal-only
        expect(isSpecType['NotificationsParams']).toBeUndefined();
    });

    it('narrows the value type', () => {
        const v: unknown = { name: 'x', version: '1.0.0' };
        if (isSpecType.Implementation(v)) {
            expectTypeOf(v).toEqualTypeOf<SpecTypes['Implementation']>();
        }
    });

    it('guards work as filter callbacks and narrow the element type', () => {
        const mixed: unknown[] = [{ type: 'text', text: 'hi' }, 42, { type: 'text' }];
        const blocks = mixed.filter(isSpecType.ContentBlock);
        expect(blocks).toHaveLength(1);
        expectTypeOf(blocks).toEqualTypeOf<ContentBlock[]>();
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
