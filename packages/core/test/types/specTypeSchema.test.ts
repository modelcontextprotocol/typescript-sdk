import { describe, expect, expectTypeOf, it } from 'vitest';

import type { OAuthMetadata, OAuthTokens } from '../../src/shared/auth.js';
import * as schemas from '../../src/types/schemas.js';
import type { SpecTypeName, SpecTypes } from '../../src/types/specTypeSchema.js';
import { isSpecType, SpecTypeValidationError, specTypeSchemas } from '../../src/types/specTypeSchema.js';
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

describe('specTypeSchemas', () => {
    it('returns a StandardSchemaV1Sync validator that accepts valid values', () => {
        const result = specTypeSchemas.Implementation['~standard'].validate({ name: 'x', version: '1.0.0' });
        expect(result.issues).toBeUndefined();
    });

    it('returns a validator that rejects invalid values with issues', () => {
        const result = specTypeSchemas.Implementation['~standard'].validate({ name: 'x' });
        expect(result.issues?.length).toBeGreaterThan(0);
    });

    it('rejects unknown names at compile time and is undefined at runtime', () => {
        // @ts-expect-error - 'NotASpecType' is not a SpecTypeName
        expect(specTypeSchemas['NotASpecType']).toBeUndefined();
    });

    it('covers JSON-RPC envelope types', () => {
        const ok = specTypeSchemas.JSONRPCRequest['~standard'].validate({ jsonrpc: '2.0', id: 1, method: 'ping' });
        expect(ok.issues).toBeUndefined();
    });

    it('covers OAuth types from shared/auth.ts', () => {
        const ok = specTypeSchemas.OAuthTokens['~standard'].validate({ access_token: 'x', token_type: 'Bearer' });
        expect(ok.issues).toBeUndefined();
        const bad = specTypeSchemas.OAuthTokens['~standard'].validate({ token_type: 'Bearer' });
        expect(bad.issues?.length).toBeGreaterThan(0);
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

    it('ResourceTemplate — accepts valid, rejects missing uriTemplate', () => {
        expect(isSpecType.ResourceTemplate({ name: 'r', uriTemplate: 'file:///{path}' })).toBe(true);
        expect(isSpecType.ResourceTemplate({ name: 'r' })).toBe(false);
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

    it('narrows the value type to the schema input type', () => {
        const v: unknown = { name: 'x', version: '1.0.0' };
        if (isSpecType.Implementation(v)) {
            // ImplementationSchema has no defaults/transforms, so its input type equals Implementation.
            expectTypeOf(v).toEqualTypeOf<Implementation>();
        }
    });

    it('narrows to the input type, not the output type, for schemas with defaults', () => {
        const v: unknown = {};
        expect(isSpecType.CallToolResult(v)).toBe(true);
        if (isSpecType.CallToolResult(v)) {
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
        if (isSpecType.JSONValue(v)) {
            expectTypeOf(v).toEqualTypeOf<JSONValue>();
        }
        if (isSpecType.JSONObject(v)) {
            expectTypeOf(v).toEqualTypeOf<JSONObject>();
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

describe('SPEC_SCHEMA_KEYS allowlist', () => {
    // Mirrors the exclusion comment in specTypeSchema.ts. If this list grows, confirm the new
    // entry has no public type in types.ts before adding it here; otherwise add it to the allowlist.
    const INTERNAL_HELPER_SCHEMAS: readonly string[] = [
        'ListChangedOptionsBaseSchema',
        'BaseRequestParamsSchema',
        'NotificationsParamsSchema',
        'ClientTasksCapabilitySchema',
        'ServerTasksCapabilitySchema'
    ];

    it('covers every public protocol schema in schemas.ts (drift guard)', () => {
        // PascalCase filters out helper functions like getRequestSchema/getResultSchema.
        const allProtocolSchemas = Object.keys(schemas).filter(k => k.endsWith('Schema') && /^[A-Z]/.test(k));
        const expected = allProtocolSchemas
            .filter(k => !INTERNAL_HELPER_SCHEMAS.includes(k))
            .map(k => k.slice(0, -'Schema'.length))
            .sort();
        // Auth schemas are sourced from shared/auth.ts, not schemas.ts, so filter them out of the
        // observed side before comparing.
        const actual = Object.keys(isSpecType)
            .filter(k => !k.startsWith('OAuth') && !k.startsWith('OpenId'))
            .sort();
        expect(actual).toEqual(expected);
    });
});

describe('specTypeSchemas.X.parse', () => {
    it('returns the parsed value for valid input', () => {
        const value = specTypeSchemas.Implementation.parse({ name: 'x', version: '1.0.0' });
        expect(value).toEqual({ name: 'x', version: '1.0.0' });
        expectTypeOf(value).toEqualTypeOf<Implementation>();
    });

    it('applies schema defaults to the returned value', () => {
        const value = specTypeSchemas.CallToolResult.parse({});
        expect(value.content).toEqual([]);
    });

    it('throws SpecTypeValidationError with issue summaries on invalid input', () => {
        expect(() => specTypeSchemas.Implementation.parse({ name: 'x' })).toThrowError(SpecTypeValidationError);
        try {
            specTypeSchemas.Implementation.parse({ name: 'x' });
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(SpecTypeValidationError);
            const validationError = error as SpecTypeValidationError;
            expect(validationError.name).toBe('SpecTypeValidationError');
            expect(validationError.specType).toBe('Implementation');
            expect(validationError.issues.length).toBeGreaterThan(0);
            expect(validationError.message).toContain('Invalid Implementation');
            expect(validationError.message).toContain('version');
        }
    });

    it('throws the SDK error class, not the schema library error', () => {
        // The entries are SDK-owned wrappers; consumers must never see the internal
        // validation library's error type cross the public boundary.
        try {
            specTypeSchemas.Implementation.parse({ name: 'x' });
            expect.unreachable();
        } catch (error) {
            expect((error as Error).name).toBe('SpecTypeValidationError');
            expect((error as Error).constructor).toBe(SpecTypeValidationError);
        }
    });

    it('is synchronous — never returns a Promise', () => {
        const value: Implementation = specTypeSchemas.Implementation.parse({ name: 'x', version: '1.0.0' });
        expect(value).not.toBeInstanceOf(Promise);
    });

    it('covers OAuth types', () => {
        const tokens = specTypeSchemas.OAuthTokens.parse({ access_token: 'x', token_type: 'Bearer' });
        expectTypeOf(tokens).toEqualTypeOf<OAuthTokens>();
        expect(tokens.access_token).toBe('x');
    });

    it("agrees with the entry's own Standard Schema validator", () => {
        const input = { name: 'x', version: '1.0.0' };
        const viaParse = specTypeSchemas.Implementation.parse(input);
        const viaValidate = specTypeSchemas.Implementation['~standard'].validate(input);
        expect(viaValidate.issues).toBeUndefined();
        if (viaValidate.issues === undefined) {
            expect(viaParse).toEqual(viaValidate.value);
        }
    });
});

describe('specTypeSchemas.X.safeParse', () => {
    it('returns { success: true, data } for valid input', () => {
        const parsed = specTypeSchemas.Tool.safeParse({ name: 't', inputSchema: { type: 'object' } });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expectTypeOf(parsed.data).toEqualTypeOf<Tool>();
            expect(parsed.data.name).toBe('t');
        }
    });

    it('returns { success: false, issues } for invalid input', () => {
        const parsed = specTypeSchemas.Tool.safeParse({ inputSchema: { type: 'object' } });
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
            expect(parsed.issues.length).toBeGreaterThan(0);
            expect(parsed.issues[0]?.message).toBeTruthy();
        }
    });

    it('applies schema defaults, distinguishing parsed output from input', () => {
        const parsed = specTypeSchemas.CallToolResult.safeParse({});
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.content).toEqual([]);
        }
    });

    it('narrows the result type through the success discriminant', () => {
        const parsed = specTypeSchemas.JSONRPCRequest.safeParse({ jsonrpc: '2.0', id: 1, method: 'ping' });
        if (parsed.success) {
            expectTypeOf(parsed.data).toEqualTypeOf<JSONRPCRequest>();
        } else {
            expectTypeOf(parsed).not.toHaveProperty('data');
        }
        expect(parsed.success).toBe(true);
    });

    it('is synchronous — result is directly accessible without await', () => {
        const parsed = specTypeSchemas.Implementation.safeParse({ name: 'x', version: '1.0.0' });
        expect(parsed).not.toBeInstanceOf(Promise);
        expect(parsed.success).toBe(true);
    });

    it('covers OAuth types', () => {
        const parsed = specTypeSchemas.OAuthTokens.safeParse({ token_type: 'Bearer' });
        expect(parsed.success).toBe(false);
    });

    it('entries are frozen — methods cannot be reassigned', () => {
        expect(Object.isFrozen(specTypeSchemas.CallToolResult)).toBe(true);
        expect(Object.isFrozen(specTypeSchemas)).toBe(true);
    });
});
