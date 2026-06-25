/**
 * The neutralKeys pin family (Q1 increment 3):
 *
 *     neutralKeys(T) = wireKeys@rev(T) − WIRE_ONLY
 *
 * For every mapped result type, the NEUTRAL public type's declared keys must
 * equal the revision's WIRE type's declared keys minus the wire-only set
 * (`resultType` — the envelope keys and retry fields are params-side and
 * never appear on result types). This closes BOTH inherited verification
 * holes at once:
 * - the old 2025 suite tolerated a phantom `resultType` key on every result
 *   (`AssertExactKeysWithResultType`), and
 * - the old 2026 suite had no key parity at all.
 *
 * OWNED PENDING DELTA (stale-checked): the 2026 cacheable results carry
 * `ttlMs`/`cacheScope` on the wire. Those are CONSUMER-RELEVANT (cache fields
 * are deliberately NOT wire-only — Q13) but the neutral model does not carry
 * them until the cache-hint surface lands (M3.2/#12). Each cacheable entry
 * below subtracts them explicitly; when M3.2 models them neutrally, the
 * subtraction breaks the build and the entry burns.
 */
import { describe, expect, test } from 'vitest';
import type * as z4 from 'zod/v4';

import type * as SDK from '../../src/types/index.js';
import type * as Wire2026 from '../../src/wire/rev2026-07-28/schemas.js';

/* eslint-disable @typescript-eslint/no-unused-vars */

type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

type AssertSameKeys<A, B> = [KnownKeys<A>] extends [KnownKeys<B>]
    ? [KnownKeys<B>] extends [KnownKeys<A>]
        ? true
        : { _brand: 'KeyMismatch'; missingFromA: Exclude<KnownKeys<B>, KnownKeys<A>> }
    : { _brand: 'KeyMismatch'; extraInA: Exclude<KnownKeys<A>, KnownKeys<B>> };

type Assert<T extends true> = T;

/** The wire-only key set on results (the hide set's result-side member). */
type WIRE_ONLY = 'resultType';

/** M3.2-owned pending delta: cache fields modeled on the wire, not yet neutrally. */
type M32_PENDING = 'ttlMs' | 'cacheScope';

type MinusWireOnly<T> = { [K in keyof T as K extends WIRE_ONLY ? never : K]: T[K] };
type MinusWireOnlyAndCache<T> = { [K in keyof T as K extends WIRE_ONLY | M32_PENDING ? never : K]: T[K] };

/* ---- 2026: neutralKeys(T) = wireKeys@2026(T) − WIRE_ONLY ---- */

type _N26_Result = Assert<AssertSameKeys<SDK.Result, MinusWireOnly<z4.infer<typeof Wire2026.ResultSchema>>>>;
type _N26_EmptyResult = Assert<AssertSameKeys<SDK.EmptyResult, MinusWireOnly<z4.infer<typeof Wire2026.ResultSchema>>>>;
type _N26_CallToolResult = Assert<AssertSameKeys<SDK.CallToolResult, MinusWireOnly<z4.infer<typeof Wire2026.CallToolResultSchema>>>>;
type _N26_CompleteResult = Assert<AssertSameKeys<SDK.CompleteResult, MinusWireOnly<z4.infer<typeof Wire2026.CompleteResultSchema>>>>;
type _N26_GetPromptResult = Assert<AssertSameKeys<SDK.GetPromptResult, MinusWireOnly<z4.infer<typeof Wire2026.GetPromptResultSchema>>>>;
// Cacheable results: ttlMs/cacheScope subtracted until M3.2 models them neutrally.
type _N26_ListToolsResult = Assert<
    AssertSameKeys<SDK.ListToolsResult, MinusWireOnlyAndCache<z4.infer<typeof Wire2026.ListToolsResultSchema>>>
>;
type _N26_ListPromptsResult = Assert<
    AssertSameKeys<SDK.ListPromptsResult, MinusWireOnlyAndCache<z4.infer<typeof Wire2026.ListPromptsResultSchema>>>
>;
type _N26_ListResourcesResult = Assert<
    AssertSameKeys<SDK.ListResourcesResult, MinusWireOnlyAndCache<z4.infer<typeof Wire2026.ListResourcesResultSchema>>>
>;
type _N26_ListResourceTemplatesResult = Assert<
    AssertSameKeys<SDK.ListResourceTemplatesResult, MinusWireOnlyAndCache<z4.infer<typeof Wire2026.ListResourceTemplatesResultSchema>>>
>;
type _N26_ReadResourceResult = Assert<
    AssertSameKeys<SDK.ReadResourceResult, MinusWireOnlyAndCache<z4.infer<typeof Wire2026.ReadResourceResultSchema>>>
>;
type _N26_DiscoverResult = Assert<
    AssertSameKeys<SDK.DiscoverResult, MinusWireOnlyAndCache<z4.infer<typeof Wire2026.DiscoverResultSchema>>>
>;

/* ---- 2025: the wire schemas ARE the neutral schemas post-cut — pin that no
 * result type re-grows a resultType slot (the masking surface stays dead). ---- */

type DeclaresResultType<T> = 'resultType' extends KnownKeys<T> ? true : false;
type _N25_Result = Assert<DeclaresResultType<SDK.Result> extends false ? true : false>;
type _N25_EmptyResult = Assert<DeclaresResultType<SDK.EmptyResult> extends false ? true : false>;
type _N25_CallToolResult = Assert<DeclaresResultType<SDK.CallToolResult> extends false ? true : false>;
type _N25_InitializeResult = Assert<DeclaresResultType<SDK.InitializeResult> extends false ? true : false>;
type _N25_CreateMessageResult = Assert<DeclaresResultType<SDK.CreateMessageResult> extends false ? true : false>;
type _N25_ElicitResult = Assert<DeclaresResultType<SDK.ElicitResult> extends false ? true : false>;
type _N25_ListRootsResult = Assert<DeclaresResultType<SDK.ListRootsResult> extends false ? true : false>;
type _N25_GetTaskResult = Assert<DeclaresResultType<SDK.GetTaskResult> extends false ? true : false>;
type _N25_ClientResult = Assert<DeclaresResultType<SDK.ClientResult> extends false ? true : false>;
type _N25_ServerResult = Assert<DeclaresResultType<SDK.ServerResult> extends false ? true : false>;

describe('neutralKeys pin family', () => {
    test('the compile of this file IS the assertion (runtime guard against truncation)', () => {
        // 11 per-type 2026 pins + 10 resultType-absence pins are enforced at
        // type level above; this runtime test exists so the file cannot be
        // silently excluded from the suite.
        expect(true).toBe(true);
    });
});
