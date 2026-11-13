import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, paginate, resolvePageSize } from '../../../src/ext/skills/paging';

const items = ['skill://a', 'skill://b', 'skill://c'];
const identity = (item: string): string => item;

describe('paging', () => {
    it('round-trips cursors and rejects anything else', () => {
        expect(decodeCursor(encodeCursor('skill://b/SKILL.md'))).toBe('skill://b/SKILL.md');
        expect(decodeCursor('not a cursor!')).toBeUndefined();
        expect(decodeCursor('garbage')).toBeUndefined();
    });

    it('pages by position after the last URI, so inserts elsewhere do not shift the boundary', () => {
        const first = paginate(items, undefined, 2, identity);
        expect(first.items).toEqual(['skill://a', 'skill://b']);
        expect(paginate(['skill://0', ...items], first.nextCursor, 2, identity)).toEqual({ items: ['skill://c'] });
    });

    it('returns everything with Infinity and throws -32602 for a bad cursor', () => {
        expect(paginate(items, undefined, Number.POSITIVE_INFINITY, identity)).toEqual({ items });
        expect(() => paginate(items, 'garbage', 2, identity)).toThrow(/Invalid cursor/);
    });

    it('validates page sizes', () => {
        expect(resolvePageSize(undefined)).toBe(100);
        expect(resolvePageSize(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
        for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => resolvePageSize(bad)).toThrow(RangeError);
    });
});
