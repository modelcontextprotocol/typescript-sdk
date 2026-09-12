import { describe, expect, it } from 'vitest';
import { normalizeHeaders } from '../../src/shared/transport.js';

describe('normalizeHeaders', () => {
    it('accepts undefined', () => {
        expect(normalizeHeaders(undefined)).toEqual({});
    });

    it('accepts standard Headers', () => {
        expect(normalizeHeaders(new Headers({ authorization: 'example' }))).toEqual({ authorization: 'example' });
    });

    it('accepts tuples', () => {
        expect(normalizeHeaders([['authorization', 'example']])).toEqual({ authorization: 'example' });
    });

    it('copies string-valued records', () => {
        const headers = { authorization: 'example' };
        expect(normalizeHeaders(headers)).toEqual(headers);
        expect(normalizeHeaders(headers)).not.toBe(headers);
    });
});
