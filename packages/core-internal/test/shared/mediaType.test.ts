import { describe, expect, it } from 'vitest';

import { isJsonContentType, listsMediaType, mediaTypeEssence } from '../../src/shared/mediaType';

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

    it('yields no essence for joined duplicate headers, with or without parameters', () => {
        // Headers.get() joins repeated headers with ', '. Without parameters
        // the comma lands in the first segment; with parameters it hides in
        // the tail — both must behave the same.
        expect(mediaTypeEssence('application/json, application/json')).toBe('application/json, application/json');
        expect(mediaTypeEssence('application/json; charset=utf-8, text/plain')).toBeUndefined();
        expect(mediaTypeEssence('application/json; charset=utf-8, application/json')).toBeUndefined();
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
        expect(isJsonContentType('application/json; charset=utf-8, text/plain')).toBe(false);
        expect(isJsonContentType('text/plain; charset=utf-8, application/json')).toBe(false);
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

describe('listsMediaType', () => {
    it('matches comma-separated Accept values by parsed media type', () => {
        expect(listsMediaType('application/json, text/event-stream', 'application/json')).toBe(true);
        expect(listsMediaType('application/json, text/event-stream', 'text/event-stream')).toBe(true);
        expect(listsMediaType('Application/JSON; q=0.9, text/event-stream; charset=utf-8', 'application/json')).toBe(true);
        expect(listsMediaType('text/plain; note="a,b", application/json', 'application/json')).toBe(true);
    });

    it('never matches required media types by substring or wildcard', () => {
        expect(listsMediaType('application/jsonx, text/event-stream-bogus', 'application/json')).toBe(false);
        expect(listsMediaType('application/jsonx, text/event-stream-bogus', 'text/event-stream')).toBe(false);
        expect(listsMediaType('text/plain; note=application/json', 'application/json')).toBe(false);
        expect(listsMediaType('*/*, application/*', 'application/json')).toBe(false);
    });

    it('rejects missing or empty Accept values', () => {
        expect(listsMediaType(null, 'application/json')).toBe(false);
        expect(listsMediaType(undefined, 'application/json')).toBe(false);
        expect(listsMediaType('', 'application/json')).toBe(false);
    });
});
