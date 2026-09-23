import { describe, expect, it } from 'vitest';

import { canonicalJson, createBoundedCache } from '../../src/validators/schemaCache';

describe('createBoundedCache', () => {
    it('returns undefined for missing keys', () => {
        const cache = createBoundedCache<string>(10);
        expect(cache.get('nope')).toBeUndefined();
    });

    it('stores and returns values', () => {
        const cache = createBoundedCache<string>(10);
        cache.set('a', '1');
        expect(cache.get('a')).toBe('1');
    });

    it('evicts the oldest entry beyond the limit (FIFO)', () => {
        const cache = createBoundedCache<string>(3);
        cache.set('a', '1');
        cache.set('b', '2');
        cache.set('c', '3');
        cache.set('d', '4'); // evicts 'a'

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe('2');
        expect(cache.get('c')).toBe('3');
        expect(cache.get('d')).toBe('4');
    });

    it('keeps only the most recent entries after repeated overflow', () => {
        const cache = createBoundedCache<string>(2);
        for (let i = 0; i < 5; i++) {
            cache.set(`k${i}`, String(i));
        }
        expect(cache.get('k0')).toBeUndefined();
        expect(cache.get('k3')).toBe('3');
        expect(cache.get('k4')).toBe('4');
    });

    it('overwriting an existing key does not count as a new entry', () => {
        const cache = createBoundedCache<string>(2);
        cache.set('a', '1');
        cache.set('b', '2');
        cache.set('a', '1-updated'); // update, size still 2
        cache.set('c', '3'); // evicts 'a' (oldest insertion)

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe('2');
        expect(cache.get('c')).toBe('3');
    });
});

describe('canonicalJson', () => {
    it('serializes with recursively sorted keys', () => {
        expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    });

    it('produces the same key for structurally identical schemas regardless of key order', () => {
        const first = canonicalJson({ type: 'object', properties: { a: { type: 'string' } } });
        const second = canonicalJson({ properties: { a: { type: 'string' } }, type: 'object' });
        expect(first).toBe(second);
    });

    it('returns undefined for cyclic objects', () => {
        const cyclic: Record<string, unknown> = { type: 'object' };
        cyclic.self = cyclic;
        expect(canonicalJson(cyclic)).toBeUndefined();
    });

    it('handles arrays', () => {
        expect(canonicalJson({ a: [1, { b: 2, a: 1 }] })).toBe('{"a":[1,{"a":1,"b":2}]}');
    });
});
