import { describe, expect, expectTypeOf, it } from 'vitest';

import type { OAuthMetadata, OAuthTokens } from '../../src/shared/auth.js';
import type { SpecTypeName, SpecTypes } from '../../src/types/specTypeSchema.js';
import { isSpecType, specTypeSchema } from '../../src/types/specTypeSchema.js';
import type {
    CallToolResult,
    ContentBlock,
    Implementation,
    JSONObject,
    JSONRPCRequest,
    JSONValue,
    ResourceTemplateType,
    Tool
} from '../../src/types/types.js';

describe('specTypeSchema', () => {
    it('returns a StandardSchemaV1 validator that accepts valid values', () => {
        const result = specTypeSchema('Implementation')['~standard'].validate({ name: 'x', version: '1.0.0' });
        expect((result as { issues?: unknown }).issues).toBeUndefined();
    });

    it('returns a validator that rejects invalid values with issues', () => {
        const result = specTypeSchema('Implementation')['~standard'].validate({ name: 'x' });
        expect((result as { issues?: readonly unknown[] }).issues?.length).toBeGreaterThan(0);
    });

    it('rejects unknown names at compile time', () => {
        // @ts-expect-error - 'NotASpecType' is not a SpecTypeName; the literal type constraint rejects it.
        expect(specTypeSchema('NotASpecType')).toBeUndefined();
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

describe('isSpecType', () => {
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

    it('ResourceTemplate — accepts valid, rejects missing uriTemplate', () => {
        expect(isSpecType('ResourceTemplate', { name: 'r', uriTemplate: 'file:///{path}' })).toBe(true);
        expect(isSpecType('ResourceTemplate', { name: 'r' })).toBe(false);
    });

    it('rejects unknown and internal-only names at compile time', () => {
        // @ts-expect-error - 'NotASpecType' is not a SpecTypeName; the literal type constraint rejects it.
        void ((v: unknown) => isSpecType('NotASpecType', v));
        // @ts-expect-error - ListChangedOptionsBase is an internal helper, not in SpecTypeName.
        void ((v: unknown) => isSpecType('ListChangedOptionsBase', v));
        // @ts-expect-error - BaseRequestParams is an internal helper, not in SpecTypeName.
        void specTypeSchema('BaseRequestParams');
        // @ts-expect-error - NotificationsParams is an internal helper, not in SpecTypeName.
        void ((v: unknown) => isSpecType('NotificationsParams', v));
    });

    it('narrows the value type to the schema input type', () => {
        const v: unknown = { name: 'x', version: '1.0.0' };
        if (isSpecType('Implementation', v)) {
            // ImplementationSchema has no defaults/transforms, so its input type equals Implementation.
            expectTypeOf(v).toEqualTypeOf<Implementation>();
        }
    });

    it('narrows to the input type, not the output type, for schemas with defaults', () => {
        const v: unknown = {};
        expect(isSpecType('CallToolResult', v)).toBe(true);
        if (isSpecType('CallToolResult', v)) {
            // CallToolResultSchema has `content: z.array(...).default([])`, so the input type
            // permits `content` to be absent. The guard narrows to that input shape.
            expectTypeOf(v.content).toEqualTypeOf<ContentBlock[] | undefined>();
            expectTypeOf(v).not.toEqualTypeOf<CallToolResult>();
        }
    });

    it('JSONValue / JSONObject — narrows to the JSON type, not unknown', () => {
        // These schemas use an explicit z.ZodType<T, T> annotation for recursion; without the
        // second param Zod's Input defaults to `unknown` and the predicate would not narrow.
        const v: unknown = { a: 1 };
        if (isSpecType('JSONValue', v)) {
            expectTypeOf(v).toEqualTypeOf<JSONValue>();
        }
        if (isSpecType('JSONObject', v)) {
            expectTypeOf(v).toEqualTypeOf<JSONObject>();
        }
    });

    it('works as a filter callback via an arrow wrapper and narrows the element type', () => {
        const mixed: unknown[] = [{ type: 'text', text: 'hi' }, 42, { type: 'text' }];
        const blocks = mixed.filter(v => isSpecType('ContentBlock', v));
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
        expectTypeOf<'ResourceTemplate'>().toMatchTypeOf<SpecTypeName>();
    });

    it('SpecTypes[K] matches the named export type', () => {
        expectTypeOf<SpecTypes['CallToolResult']>().toEqualTypeOf<CallToolResult>();
        expectTypeOf<SpecTypes['ContentBlock']>().toEqualTypeOf<ContentBlock>();
        expectTypeOf<SpecTypes['Tool']>().toEqualTypeOf<Tool>();
        expectTypeOf<SpecTypes['Implementation']>().toEqualTypeOf<Implementation>();
        expectTypeOf<SpecTypes['JSONRPCRequest']>().toEqualTypeOf<JSONRPCRequest>();
        expectTypeOf<SpecTypes['OAuthTokens']>().toEqualTypeOf<OAuthTokens>();
        expectTypeOf<SpecTypes['OAuthMetadata']>().toEqualTypeOf<OAuthMetadata>();
        // The public type is exported as ResourceTemplateType (the bare name collides with the
        // server package's ResourceTemplate class), so this is the one entry where the key and
        // the public type name differ.
        expectTypeOf<SpecTypes['ResourceTemplate']>().toEqualTypeOf<ResourceTemplateType>();
    });
});
