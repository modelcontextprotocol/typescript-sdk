import { describe, expect, it } from 'vitest';

import { isJsonContentType, mediaTypeEssence } from '../../src/shared/mediaType';

describe('mediaTypeEssence', () => {
    it('parses well-formed headers', () => {
        expect(mediaTypeEssence('application/json')).toBe('application/json');
        expect(mediaTypeEssence('text/event-stream; charset=utf-8')).toBe('text/event-stream');
        expect(mediaTypeEssence('Application/JSON; charset=utf-8')).toBe('application/json');
    });

    it('falls back to the pre-parameter segment for malformed parameter sections', () => {
        expect(mediaTypeEssence('application/json;')).toBe('application/json');
        expect(mediaTypeEssence('application/json; charset=')).toBe('application/json');
        expect(mediaTypeEssence('text/plain;')).toBe('text/plain');
    });

    it('returns undefined for missing or empty headers', () => {
        expect(mediaTypeEssence(null)).toBeUndefined();
        expect(mediaTypeEssence(undefined)).toBeUndefined();
        expect(mediaTypeEssence('')).toBeUndefined();
        expect(mediaTypeEssence('   ')).toBeUndefined();
        expect(mediaTypeEssence(';charset=utf-8')).toBeUndefined();
    });

    it('yields a no-match essence for a bare joined duplicate header', () => {
        // Headers.get() joins repeated headers with ', '; the comparison sees
        // the joined string, which does not equal 'application/json'.
        expect(mediaTypeEssence('application/json, application/json')).toBe('application/json, application/json');
    });
});

describe('isJsonContentType', () => {
    it('accepts application/json with or without parameters', () => {
        expect(isJsonContentType('application/json')).toBe(true);
        expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
        expect(isJsonContentType('Application/JSON')).toBe(true);
        expect(isJsonContentType('  application/json ; charset=utf-8')).toBe(true);
    });

    it('accepts unambiguous media types with malformed parameter sections', () => {
        expect(isJsonContentType('application/json;')).toBe(true);
        expect(isJsonContentType('application/json; charset=')).toBe(true);
        expect(isJsonContentType('application/json; charset=utf-8; charset=x')).toBe(true);
    });

    it('never matches on substrings: parameters and sibling types are not application/json', () => {
        expect(isJsonContentType('text/plain; a=application/json')).toBe(false);
        expect(isJsonContentType('text/plain;')).toBe(false);
        expect(isJsonContentType('text/plain, application/json')).toBe(false);
        expect(isJsonContentType('application/json, application/json')).toBe(false);
        expect(isJsonContentType('application/json-patch+json')).toBe(false);
        expect(isJsonContentType('application/jsonp')).toBe(false);
    });

    it('rejects missing, empty, and non-JSON types', () => {
        expect(isJsonContentType(null)).toBe(false);
        expect(isJsonContentType(undefined)).toBe(false);
        expect(isJsonContentType('')).toBe(false);
        expect(isJsonContentType('text/plain')).toBe(false);
        expect(isJsonContentType('multipart/form-data')).toBe(false);
    });
});
