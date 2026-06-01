import { describe, expect, it } from 'vitest';
import {
    ACCEPT_LANGUAGE_META,
    CONTENT_LANGUAGE_META,
    getAcceptLanguage,
    getContentLanguage,
    getErrorContentLanguage,
    HEADER_MISMATCH_ERROR_CODE,
    negotiateLanguage,
    setAcceptLanguage,
    setContentLanguage,
    setErrorContentLanguage
} from '../../src/shared/i18n.js';

describe('i18n helpers', () => {
    describe('constants', () => {
        it('has correct meta key names', () => {
            expect(ACCEPT_LANGUAGE_META).toBe('io.modelcontextprotocol/acceptLanguage');
            expect(CONTENT_LANGUAGE_META).toBe('io.modelcontextprotocol/contentLanguage');
        });

        it('HEADER_MISMATCH_ERROR_CODE equals -32005', () => {
            expect(HEADER_MISMATCH_ERROR_CODE).toBe(-32_005);
        });
    });

    describe('getAcceptLanguage', () => {
        it('returns undefined when _meta is absent', () => {
            expect(getAcceptLanguage({})).toBeUndefined();
        });

        it('returns undefined when key is absent', () => {
            expect(getAcceptLanguage({ _meta: {} })).toBeUndefined();
        });

        it('returns the value when present', () => {
            const params = { _meta: { [ACCEPT_LANGUAGE_META]: 'fr-CA,en;q=0.5' } };
            expect(getAcceptLanguage(params)).toBe('fr-CA,en;q=0.5');
        });
    });

    describe('setAcceptLanguage', () => {
        it('creates _meta if absent', () => {
            const params: { _meta?: Record<string, unknown> } = {};
            setAcceptLanguage(params, 'de');
            expect(params._meta?.[ACCEPT_LANGUAGE_META]).toBe('de');
        });

        it('sets value on existing _meta', () => {
            const params: { _meta: Record<string, unknown> } = { _meta: { other: 'value' } };
            setAcceptLanguage(params, 'en-US');
            expect(params._meta[ACCEPT_LANGUAGE_META]).toBe('en-US');
            expect(params._meta.other).toBe('value');
        });
    });

    describe('getContentLanguage', () => {
        it('returns undefined when _meta is absent', () => {
            expect(getContentLanguage({})).toBeUndefined();
        });

        it('returns the value when present', () => {
            const result = { _meta: { [CONTENT_LANGUAGE_META]: 'fr' } };
            expect(getContentLanguage(result)).toBe('fr');
        });
    });

    describe('setContentLanguage', () => {
        it('creates _meta if absent', () => {
            const result: { _meta?: Record<string, unknown> } = {};
            setContentLanguage(result, 'de');
            expect(result._meta?.[CONTENT_LANGUAGE_META]).toBe('de');
        });

        it('sets value on existing _meta', () => {
            const result: { _meta: Record<string, unknown> } = { _meta: { other: 'x' } };
            setContentLanguage(result, 'en');
            expect(result._meta[CONTENT_LANGUAGE_META]).toBe('en');
        });
    });

    describe('negotiateLanguage', () => {
        const available = ['en', 'fr', 'de'];

        it('returns exact match', () => {
            expect(negotiateLanguage('fr', available)).toBe('fr');
        });

        it('returns best match from quality-value list', () => {
            expect(negotiateLanguage('fr-CA,fr;q=0.9,en;q=0.5', available)).toBe('fr');
        });

        it('returns defaultLocale when no match', () => {
            expect(negotiateLanguage('ja', available, 'en')).toBe('en');
        });

        it('returns undefined when no match and no default', () => {
            expect(negotiateLanguage('ja', available)).toBeUndefined();
        });

        it('handles empty acceptLanguage', () => {
            expect(negotiateLanguage('', available, 'en')).toBe('en');
        });

        it('handles wildcard only', () => {
            // Wildcard is filtered out, should fall back to default
            expect(negotiateLanguage('*', available, 'en')).toBe('en');
        });

        it('handles empty available list', () => {
            expect(negotiateLanguage('en', [], 'en')).toBe('en');
        });

        it('respects quality-value ordering', () => {
            // de has highest quality
            expect(negotiateLanguage('en;q=0.5,de;q=0.9,fr;q=0.7', available)).toBe('de');
        });

        it('handles subtag matching (en-US matches en)', () => {
            expect(negotiateLanguage('en-US', available)).toBe('en');
        });

        it('handles multiple subtag matches preferring higher quality', () => {
            expect(negotiateLanguage('de-AT;q=0.8,fr-CA;q=0.9', available)).toBe('fr');
        });
    });

    describe('getErrorContentLanguage', () => {
        it('returns undefined for null/undefined data', () => {
            expect(getErrorContentLanguage(undefined)).toBeUndefined();
            expect(getErrorContentLanguage(null)).toBeUndefined();
        });

        it('returns undefined when data has no _meta', () => {
            expect(getErrorContentLanguage({ message: 'error' })).toBeUndefined();
        });

        it('returns undefined when _meta has no contentLanguage', () => {
            expect(getErrorContentLanguage({ _meta: { other: 'x' } })).toBeUndefined();
        });

        it('returns the contentLanguage from data._meta', () => {
            const data = { _meta: { [CONTENT_LANGUAGE_META]: 'fr' } };
            expect(getErrorContentLanguage(data)).toBe('fr');
        });

        it('returns undefined for non-string contentLanguage', () => {
            const data = { _meta: { [CONTENT_LANGUAGE_META]: 123 } };
            expect(getErrorContentLanguage(data)).toBeUndefined();
        });
    });

    describe('setErrorContentLanguage', () => {
        it('sets contentLanguage on an existing object', () => {
            const data = { message: 'err' };
            const result = setErrorContentLanguage(data, 'de');
            expect(result._meta).toBeDefined();
            expect((result._meta as Record<string, unknown>)[CONTENT_LANGUAGE_META]).toBe('de');
            expect(result.message).toBe('err');
        });

        it('creates a wrapper object for non-object data', () => {
            const result = setErrorContentLanguage('raw string', 'fr');
            expect(result.originalData).toBe('raw string');
            expect((result._meta as Record<string, unknown>)[CONTENT_LANGUAGE_META]).toBe('fr');
        });

        it('creates an empty object for undefined data', () => {
            const result = setErrorContentLanguage(undefined, 'en');
            expect((result._meta as Record<string, unknown>)[CONTENT_LANGUAGE_META]).toBe('en');
            expect(result.originalData).toBeUndefined();
        });

        it('preserves existing _meta fields', () => {
            const data = { _meta: { other: 'value' } };
            const result = setErrorContentLanguage(data, 'de');
            expect((result._meta as Record<string, unknown>).other).toBe('value');
            expect((result._meta as Record<string, unknown>)[CONTENT_LANGUAGE_META]).toBe('de');
        });
    });
});
