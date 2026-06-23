/**
 * The 2026-07-28 outbound encode contract, tested as pure steps and through
 * the codec's `encodeResult` integration:
 *
 *  step 1 — resultType stamp: `'complete'` stamped when absent; a
 *           handler-provided value passes through only for methods whose spec
 *           result vocabulary goes beyond `'complete'` (the multi round-trip
 *           methods); a stray non-`'complete'` value anywhere else fails
 *           loudly instead of being mis-typed on the wire.
 *  step 2 — cache fill: `ttlMs`/`cacheScope` filled only on post-stamp
 *           `'complete'` results of the cacheable operations, resolved most
 *           specific author first (valid handler-returned values, then the
 *           attached configured hint, then the defaults), with an encode-time
 *           validity gate on handler-returned values.
 *
 * The ordering (stamp before fill, `input_required` excluded from the fill)
 * is pinned here.
 */
import { describe, expect, test } from 'vitest';

import {
    attachCacheHintFallback,
    CACHEABLE_RESULT_METHODS,
    cacheHintFallbackOf,
    RESULT_CACHE_HINT_FALLBACK
} from '../../src/shared/resultCacheHints.js';
import { ProtocolError } from '../../src/types/errors.js';
import type { Result } from '../../src/types/types.js';
import { rev2025Codec } from '../../src/wire/rev2025-11-25/codec.js';
import { rev2026Codec } from '../../src/wire/rev2026-07-28/codec.js';
import { DiscoverResultSchema as Wire2026DiscoverResultSchema } from '../../src/wire/rev2026-07-28/schemas.js';
import {
    DEFAULT_CACHE_SCOPE,
    DEFAULT_CACHE_TTL_MS,
    EXTENDED_RESULT_TYPE_METHODS,
    fillCacheFields,
    stampResultType
} from '../../src/wire/rev2026-07-28/encodeContract.js';

const asResult = (value: Record<string, unknown>): Result => value as unknown as Result;
const fieldsOf = (value: Result): Record<string, unknown> => value as unknown as Record<string, unknown>;

describe('step 1 — the resultType stamp', () => {
    test("stamps 'complete' when the handler did not provide a resultType", () => {
        const stamped = fieldsOf(stampResultType('tools/list', asResult({ tools: [] })));
        expect(stamped['resultType']).toBe('complete');
    });

    test("keeps a handler-provided 'complete' as-is (same reference)", () => {
        const result = asResult({ tools: [], resultType: 'complete' });
        expect(stampResultType('tools/list', result)).toBe(result);
    });

    test.each(EXTENDED_RESULT_TYPE_METHODS.map(method => [method]))(
        'passes a handler-provided input_required through for %s (extended result vocabulary)',
        method => {
            const result = asResult({ resultType: 'input_required', inputRequests: {} });
            expect(stampResultType(method, result)).toBe(result);
        }
    );

    test('passes other handler-provided values through on extended-vocabulary methods (the wire vocabulary is an open union)', () => {
        const result = asResult({ resultType: 'some_future_kind' });
        expect(stampResultType('tools/call', result)).toBe(result);
    });

    test.each([['tools/list'], ['prompts/list'], ['server/discover'], ['completion/complete']])(
        'a stray input_required from a handler for %s fails loudly with an internal error',
        method => {
            expect(() => stampResultType(method, asResult({ resultType: 'input_required' }))).toThrowError(ProtocolError);
            try {
                stampResultType(method, asResult({ resultType: 'input_required' }));
            } catch (error) {
                expect((error as ProtocolError).code).toBe(-32_603);
                expect((error as ProtocolError).message).toContain(method);
            }
        }
    );

    test('the extended-vocabulary method set is exactly the multi round-trip request methods', () => {
        expect([...EXTENDED_RESULT_TYPE_METHODS].sort()).toEqual(['prompts/get', 'resources/read', 'tools/call'].sort());
    });
});

describe('step 2 — the cache fill', () => {
    test('the cacheable-operation list is closed at exactly six operations', () => {
        expect([...CACHEABLE_RESULT_METHODS].sort()).toEqual(
            ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read', 'server/discover'].sort()
        );
    });

    test.each(CACHEABLE_RESULT_METHODS.map(method => [method]))('fills the defaults on a complete %s result', method => {
        const filled = fieldsOf(fillCacheFields(method, asResult({ resultType: 'complete' })));
        expect(filled['ttlMs']).toBe(DEFAULT_CACHE_TTL_MS);
        expect(filled['cacheScope']).toBe(DEFAULT_CACHE_SCOPE);
    });

    test.each([['tools/call'], ['prompts/get'], ['completion/complete'], ['app/custom']])(
        'never fills cache fields for %s (not a cacheable operation)',
        method => {
            const filled = fieldsOf(fillCacheFields(method, asResult({ resultType: 'complete' })));
            expect('ttlMs' in filled).toBe(false);
            expect('cacheScope' in filled).toBe(false);
        }
    );

    test('input_required results are never given cache fields (stamp-before-fill ordering)', () => {
        const filled = fieldsOf(fillCacheFields('resources/read', asResult({ resultType: 'input_required', inputRequests: {} })));
        expect('ttlMs' in filled).toBe(false);
        expect('cacheScope' in filled).toBe(false);
    });

    test('valid handler-returned values are respected over the attached hint and the defaults', () => {
        const result = attachCacheHintFallback(asResult({ resultType: 'complete', ttlMs: 30_000, cacheScope: 'public' }), {
            ttlMs: 5_000,
            cacheScope: 'private'
        });
        const filled = fieldsOf(fillCacheFields('tools/list', result));
        expect(filled['ttlMs']).toBe(30_000);
        expect(filled['cacheScope']).toBe('public');
    });

    test('the attached configured hint wins over the defaults when the handler provided nothing', () => {
        const result = attachCacheHintFallback(asResult({ resultType: 'complete' }), { ttlMs: 5_000, cacheScope: 'public' });
        const filled = fieldsOf(fillCacheFields('resources/read', result));
        expect(filled['ttlMs']).toBe(5_000);
        expect(filled['cacheScope']).toBe('public');
    });

    test('a partial hint fills only its own field; the other falls back to the default', () => {
        const result = attachCacheHintFallback(asResult({ resultType: 'complete' }), { ttlMs: 9_000 });
        const filled = fieldsOf(fillCacheFields('server/discover', result));
        expect(filled['ttlMs']).toBe(9_000);
        expect(filled['cacheScope']).toBe(DEFAULT_CACHE_SCOPE);
    });

    test.each([
        ['a negative ttlMs', { ttlMs: -1 }],
        ['a non-integer ttlMs', { ttlMs: 1.5 }],
        ['an unsafe-integer ttlMs (above 2^53 - 1, rejected by the wire schemas)', { ttlMs: 1e20 }],
        ['a NaN ttlMs', { ttlMs: Number.NaN }],
        ['an infinite ttlMs', { ttlMs: Number.POSITIVE_INFINITY }],
        ['a non-numeric ttlMs', { ttlMs: 'soon' }],
        ['an unknown cacheScope', { cacheScope: 'shared' }]
    ])('invalid handler-returned values (%s) never reach the wire — the next author wins', (_label, invalid) => {
        const result = attachCacheHintFallback(asResult({ resultType: 'complete', ...invalid }), { ttlMs: 1_000, cacheScope: 'public' });
        const filled = fieldsOf(fillCacheFields('tools/list', result));
        expect(filled['ttlMs']).toBe(1_000);
        expect(filled['cacheScope']).toBe('public');
    });

    test('the configured-hint carrier never survives past the encode seam', () => {
        const filledTarget = fillCacheFields('tools/list', attachCacheHintFallback(asResult({ resultType: 'complete' }), { ttlMs: 1 }));
        expect(cacheHintFallbackOf(filledTarget)).toBeUndefined();

        const nonTarget = fillCacheFields('tools/call', attachCacheHintFallback(asResult({ resultType: 'complete' }), { ttlMs: 1 }));
        expect(cacheHintFallbackOf(nonTarget)).toBeUndefined();
        expect(RESULT_CACHE_HINT_FALLBACK in (nonTarget as object)).toBe(false);
    });

    test('attachCacheHintFallback never overwrites an already-attached, more specific hint', () => {
        const withSpecific = attachCacheHintFallback(asResult({}), { ttlMs: 2_000 });
        const withBoth = attachCacheHintFallback(withSpecific, { ttlMs: 50 });
        expect(cacheHintFallbackOf(withBoth)).toEqual({ ttlMs: 2_000 });
    });

    test('attachCacheHintFallback combines hints per field: a less specific hint fills only the fields the attached hint leaves unset', () => {
        const withSpecific = attachCacheHintFallback(asResult({}), { cacheScope: 'public' });
        const withBoth = attachCacheHintFallback(withSpecific, { ttlMs: 50, cacheScope: 'private' });
        expect(cacheHintFallbackOf(withBoth)).toEqual({ ttlMs: 50, cacheScope: 'public' });
    });
});

describe('the codec integration (encodeResult applies the contract in pinned order)', () => {
    test('a complete cacheable result is stamped and filled', () => {
        const encoded = fieldsOf(rev2026Codec.encodeResult('tools/list', asResult({ tools: [] })));
        expect(encoded).toMatchObject({ resultType: 'complete', ttlMs: DEFAULT_CACHE_TTL_MS, cacheScope: DEFAULT_CACHE_SCOPE });
    });

    test('deleted-field strictness, stamp and fill compose on the same emission', () => {
        const encoded = fieldsOf(
            rev2026Codec.encodeResult(
                'tools/list',
                asResult({ tools: [{ name: 't', inputSchema: { type: 'object' }, execution: { taskSupport: 'optional' } }] })
            )
        );
        expect(encoded).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
        expect('execution' in (encoded['tools'] as Array<Record<string, unknown>>)[0]!).toBe(false);
    });

    test('an input_required result from a multi round-trip method is passed through unfilled', () => {
        const encoded = fieldsOf(
            rev2026Codec.encodeResult('resources/read', asResult({ resultType: 'input_required', inputRequests: {} }))
        );
        expect(encoded['resultType']).toBe('input_required');
        expect('ttlMs' in encoded).toBe(false);
        expect('cacheScope' in encoded).toBe(false);
    });

    test('a stray input_required from a non-multi-round-trip handler throws out of encodeResult (answered as an internal error upstream)', () => {
        expect(() => rev2026Codec.encodeResult('tools/list', asResult({ resultType: 'input_required' }))).toThrowError(ProtocolError);
    });
});

describe('inbound receiver-side defaults (the parse-side leniency that lets the probe classifier route through the codec)', () => {
    const minimalDiscover = {
        supportedVersions: ['2026-07-28'],
        capabilities: {},
        serverInfo: { name: 's', version: '1' }
    };

    test("validateResult('server/discover', …) fills ttlMs/cacheScope when absent", () => {
        const outcome = rev2026Codec.validateResult('server/discover', minimalDiscover);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error('unreachable');
        expect(outcome.value.ttlMs).toBe(0);
        expect(outcome.value.cacheScope).toBe('private');
    });

    test("the wire-true DiscoverResultSchema fills resultType: 'complete' when absent", () => {
        // Schema-level receiver leniency (spec schema.ts:208). `decodeResult`
        // step 1 stays strict per Q1-SD3(i) — this defaults the wire-true Zod
        // parse only.
        const parsed = Wire2026DiscoverResultSchema.parse(minimalDiscover);
        expect(parsed.resultType).toBe('complete');
        expect(parsed.ttlMs).toBe(0);
        expect(parsed.cacheScope).toBe('private');
    });

    test('explicit values still win over the defaults', () => {
        const outcome = rev2026Codec.validateResult('server/discover', {
            ...minimalDiscover,
            ttlMs: 30_000,
            cacheScope: 'public'
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error('unreachable');
        expect(outcome.value.ttlMs).toBe(30_000);
        expect(outcome.value.cacheScope).toBe('public');
    });
});

describe('the error half of the encode seam — encodeErrorCode', () => {
    test('the -32002 resource-not-found domain code maps to -32602 on BOTH eras (flat; no era branch preserves -32002)', () => {
        // The seam owns wire-code selection; both era codecs select -32602.
        expect(rev2026Codec.encodeErrorCode(-32_002)).toBe(-32_602);
        expect(rev2025Codec.encodeErrorCode(-32_002)).toBe(-32_602);
    });

    test('every other code passes through identically on both eras', () => {
        for (const code of [-32_700, -32_600, -32_601, -32_602, -32_603, -32_000, -32_020, -32_021, -32_022, -32_042, -1, 0]) {
            expect(rev2026Codec.encodeErrorCode(code)).toBe(code);
            expect(rev2025Codec.encodeErrorCode(code)).toBe(code);
        }
    });
});
