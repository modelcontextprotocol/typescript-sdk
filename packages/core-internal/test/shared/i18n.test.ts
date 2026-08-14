import { describe, expect, it } from 'vitest';

import {
    ACCEPT_LANGUAGE_META,
    CONTENT_LANGUAGE_META,
    getAcceptLanguage,
    getContentLanguage,
    getErrorContentLanguage,
    getMessageContentLanguage,
    getRawAcceptLanguage,
    isValidAcceptLanguage,
    languageHeaderValueConflicts,
    negotiateLanguage,
    setAcceptLanguage,
    setContentLanguage,
    setErrorContentLanguage
} from '../../src/shared/i18n';

describe('SEP-2792 metadata helpers', () => {
    it('uses the standardized metadata keys', () => {
        expect(ACCEPT_LANGUAGE_META).toBe('io.modelcontextprotocol/acceptLanguage');
        expect(CONTENT_LANGUAGE_META).toBe('io.modelcontextprotocol/contentLanguage');
    });

    it('reads and writes request and response metadata', () => {
        const request: { _meta?: Record<string, unknown> } = {};
        const result: { _meta?: Record<string, unknown> } = {};
        expect(setAcceptLanguage(request, 'fr-CA, fr;q=0.9')).toBe(request);
        expect(setContentLanguage(result, 'fr')).toBe(result);
        expect(getAcceptLanguage(request)).toBe('fr-CA, fr;q=0.9');
        expect(getContentLanguage(result)).toBe('fr');
    });

    it('rejects malformed values authored through the dedicated request setter', () => {
        expect(() => setAcceptLanguage({}, 'en;q=1.001')).toThrow(TypeError);
    });

    it('treats malformed canonical preferences as absent after retaining the raw agreement value', () => {
        const params = { _meta: { [ACCEPT_LANGUAGE_META]: '!!!' } };
        expect(getRawAcceptLanguage(params)).toBe('!!!');
        expect(getAcceptLanguage(params)).toBeUndefined();
    });

    it('uses error.data._meta only when error data is structurally an object', () => {
        const data = setErrorContentLanguage({ reason: 'wrong-answer' }, 'de');
        expect(getErrorContentLanguage(data)).toBe('de');
        expect(getErrorContentLanguage('wrong-answer')).toBeUndefined();
        expect(getErrorContentLanguage(['wrong-answer'])).toBeUndefined();
    });

    it('reads reported language from complete, input-required, error, and notification messages', () => {
        const meta = { [CONTENT_LANGUAGE_META]: 'fr' };
        expect(getMessageContentLanguage({ jsonrpc: '2.0', id: 1, result: { _meta: meta } })).toBe('fr');
        expect(
            getMessageContentLanguage({
                jsonrpc: '2.0',
                id: 2,
                result: { resultType: 'input_required', inputRequests: {}, _meta: meta }
            })
        ).toBe('fr');
        expect(
            getMessageContentLanguage({ jsonrpc: '2.0', id: 3, error: { code: -32_602, message: 'Erreur', data: { _meta: meta } } })
        ).toBe('fr');
        expect(
            getMessageContentLanguage({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: {}, _meta: meta } })
        ).toBe('fr');
    });
});

describe('Accept-Language grammar and RFC 4647 lookup', () => {
    it.each(['en', 'fr-CA, fr;q=0.9, en;q=0.5', 'zh-Hant-TW', '*;q=0.2', 'de;q=0', 'EN-us, *;Q=0.100'])(
        'accepts valid field value %s',
        value => {
            expect(isValidAcceptLanguage(value)).toBe(true);
        }
    );

    it.each(['', ' en', 'en ', 'en;q=1.001', 'en;q=.5', 'en;q=2', 'en;q=0.1234', 'en;level=1', 'en,,fr', 'toolongprimarytag'])(
        'rejects malformed field value %s',
        value => {
            expect(isValidAcceptLanguage(value)).toBe(false);
        }
    );

    it('honors quality weights and original order for ties', () => {
        expect(negotiateLanguage('fr;q=0.4, de;q=0.9', ['en', 'fr', 'de'], 'en')).toBe('de');
        expect(negotiateLanguage('fr;q=0.8, de;q=0.8', ['en', 'fr', 'de'], 'en')).toBe('fr');
    });

    it('performs case-insensitive RFC 4647 lookup and returns the advertised spelling', () => {
        expect(negotiateLanguage('FR-ca', ['en', 'fr', 'de'], 'en')).toBe('fr');
        expect(negotiateLanguage('zh-hant', ['en', 'zh-Hant-TW'], 'en')).toBe('zh-Hant-TW');
    });

    it('honors wildcard and q=0 exclusions', () => {
        expect(negotiateLanguage('fr;q=0, *;q=0.5', ['fr', 'de'], 'fr')).toBe('de');
    });

    it('applies q=0 exclusions by longest matching range', () => {
        expect(negotiateLanguage('en, en-GB;q=0', ['en-GB', 'en-US'], 'de')).toBe('en-US');
        expect(negotiateLanguage('en, en-GB;q=0', ['en-US'], 'de')).toBe('en-US');
        expect(negotiateLanguage('en, en-GB;q=0', ['en'], 'de')).toBe('en');
        expect(negotiateLanguage('fr, fr-CA;q=0', ['fr-CA', 'fr-FR'], 'de')).toBe('fr-FR');
        expect(negotiateLanguage('fr, fr;q=0', ['fr', 'de'], 'de')).toBe('de');
        expect(negotiateLanguage('fr;q=0, fr-CA;q=1', ['fr-CA', 'de'], 'de')).toBe('fr-CA');
    });

    it('uses the most specific matching range to determine a language quality', () => {
        expect(negotiateLanguage('*;q=1, en;q=0.5', ['en', 'de'], 'en')).toBe('de');
        expect(negotiateLanguage('*;q=0, en;q=0.5', ['de', 'en'], 'de')).toBe('en');
    });

    it('falls back to the server default without error for absent, malformed, or unmatched preferences', () => {
        expect(negotiateLanguage(undefined, ['en', 'fr'], 'en')).toBe('en');
        expect(negotiateLanguage('en;q=9', ['en', 'fr'], 'en')).toBe('en');
        expect(negotiateLanguage('ja', ['en', 'fr'], 'en')).toBe('en');
    });
});

describe('Streamable HTTP mirror equality', () => {
    it('accepts an exact exposed field-value match and missing mirrors', () => {
        expect(languageHeaderValueConflicts('en-US, fr;q=0.9', 'en-US, fr;q=0.9')).toBe(false);
        expect(languageHeaderValueConflicts(undefined, 'en-US')).toBe(false);
        expect(languageHeaderValueConflicts('en-US', undefined)).toBe(false);
    });

    it.each([
        ['en-US', 'en-us'],
        ['en-US,fr;q=0.9', 'en-US, fr;q=0.9'],
        ['en;q=0.9', 'en;q=0.900'],
        ['fr, en;q=0.5', 'en;q=0.5, fr']
    ])('does not normalize semantically equivalent values (%s vs %s)', (header, metadata) => {
        expect(languageHeaderValueConflicts(header, metadata)).toBe(true);
    });
});
