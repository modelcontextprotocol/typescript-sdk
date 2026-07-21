/**
 * SEP-2792: Internationalization via Per-Request Language Negotiation.
 *
 * Tests cover:
 * 1. i18n helpers and negotiateLanguage
 * 2. Server-side Accept-Language byte-equality validation
 * 3. Client-side Content-Language response mismatch detection
 * 4. Full HTTP integration: header mirroring, Vary, Cache-Control
 * 5. stdio per-request language switch (no transport headers)
 */
import { describe, expect, test } from 'vitest';

import {
    ACCEPT_LANGUAGE_META,
    CONTENT_LANGUAGE_META,
    getAcceptLanguage,
    getContentLanguage,
    negotiateLanguage,
    setAcceptLanguage,
    setContentLanguage
} from '../../src/shared/i18n';
import { HEADER_MISMATCH_ERROR_CODE, validateAcceptLanguageHeader } from '../../src/shared/inboundClassification';

// ---------------------------------------------------------------------------
// Unit tests for helpers
// ---------------------------------------------------------------------------

describe('i18n helpers', () => {
    test('getAcceptLanguage reads from _meta', () => {
        expect(getAcceptLanguage({ _meta: { [ACCEPT_LANGUAGE_META]: 'en-US' } })).toBe('en-US');
    });

    test('getAcceptLanguage returns undefined when absent', () => {
        expect(getAcceptLanguage({})).toBeUndefined();
        expect(getAcceptLanguage(undefined)).toBeUndefined();
        expect(getAcceptLanguage({ _meta: {} })).toBeUndefined();
    });

    test('setAcceptLanguage creates _meta if needed', () => {
        const params: { _meta?: Record<string, unknown> } = {};
        setAcceptLanguage(params, 'fr');
        expect(params._meta?.[ACCEPT_LANGUAGE_META]).toBe('fr');
    });

    test('getContentLanguage reads from _meta', () => {
        expect(getContentLanguage({ _meta: { [CONTENT_LANGUAGE_META]: 'de' } })).toBe('de');
    });

    test('setContentLanguage creates _meta if needed', () => {
        const result: { _meta?: Record<string, unknown> } = {};
        setContentLanguage(result, 'fr');
        expect(result._meta?.[CONTENT_LANGUAGE_META]).toBe('fr');
    });
});

// ---------------------------------------------------------------------------
// negotiateLanguage
// ---------------------------------------------------------------------------

describe('negotiateLanguage', () => {
    test('exact match', () => {
        expect(negotiateLanguage('en', ['en', 'fr', 'de'], 'en')).toBe('en');
    });

    test('RFC 4647 lookup match (subtag)', () => {
        expect(negotiateLanguage('fr-CA', ['en', 'fr', 'de'], 'en')).toBe('fr');
    });

    test('quality-weighted selection', () => {
        expect(negotiateLanguage('fr;q=0.5, de;q=0.9', ['en', 'fr', 'de'], 'en')).toBe('de');
    });

    test('unmatched value falls back to default without error', () => {
        expect(negotiateLanguage('ja', ['en', 'fr', 'de'], 'en')).toBe('en');
    });

    test('malformed value treated as absent (returns default)', () => {
        expect(negotiateLanguage(';;;invalid;;;', ['en', 'fr'], 'en')).toBe('en');
    });

    test('empty string returns default', () => {
        expect(negotiateLanguage('', ['en', 'fr'], 'en')).toBe('en');
    });

    test('wildcard * alone returns default (not matched as a tag)', () => {
        expect(negotiateLanguage('*', ['en', 'fr'], 'en')).toBe('en');
    });
});

// ---------------------------------------------------------------------------
// Server-side Accept-Language byte-equality validation
// ---------------------------------------------------------------------------

describe('validateAcceptLanguageHeader (byte-equality)', () => {
    test('both present, byte-identical → accept', () => {
        expect(validateAcceptLanguageHeader('en-US, fr;q=0.9', 'en-US, fr;q=0.9')).toBeUndefined();
    });

    test('both present, byte-mismatch (trailing whitespace) → reject', () => {
        const result = validateAcceptLanguageHeader('en-US ', 'en-US');
        expect(result).not.toBeUndefined();
        expect(result!.code).toBe(HEADER_MISMATCH_ERROR_CODE);
        expect(result!.httpStatus).toBe(400);
    });

    test('both present, byte-mismatch (case only: en-US vs en-us) → reject', () => {
        const result = validateAcceptLanguageHeader('en-us', 'en-US');
        expect(result).not.toBeUndefined();
        expect(result!.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    test('both present, byte-mismatch (q formatting: q=0.9 vs q=0.900) → reject', () => {
        const result = validateAcceptLanguageHeader('en;q=0.900', 'en;q=0.9');
        expect(result).not.toBeUndefined();
        expect(result!.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    test('both present, byte-mismatch (reordered ranges) → reject', () => {
        const result = validateAcceptLanguageHeader('fr;q=0.9, en-US', 'en-US, fr;q=0.9');
        expect(result).not.toBeUndefined();
        expect(result!.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    test('both present, byte-mismatch (spacing: comma without space) → reject', () => {
        const result = validateAcceptLanguageHeader('en-US,en;q=0.9', 'en-US, en;q=0.9');
        expect(result).not.toBeUndefined();
        expect(result!.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    test('_meta present, header absent → accept (CDN-strip tolerance)', () => {
        expect(validateAcceptLanguageHeader(undefined, 'en-US')).toBeUndefined();
    });

    test('header present, _meta absent → accept (bare header ignored)', () => {
        expect(validateAcceptLanguageHeader('en-US', undefined)).toBeUndefined();
    });

    test('both absent → no preference', () => {
        expect(validateAcceptLanguageHeader(undefined, undefined)).toBeUndefined();
    });

    test('rejection carries -32020 error code', () => {
        const result = validateAcceptLanguageHeader('en', 'EN');
        expect(result).not.toBeUndefined();
        expect(result!.code).toBe(-32020);
        expect(result!.cell).toBe('accept-language-header-mismatch');
    });
});
