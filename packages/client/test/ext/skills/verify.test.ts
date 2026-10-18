import { describe, expect, it } from 'vitest';

import { frontmatterDifferences } from '../../../src/ext/skills/verify';

describe('frontmatterDifferences', () => {
    it('accepts equal values, objects in any key order', () => {
        expect(frontmatterDifferences({ name: 'a', metadata: { x: '1', y: '2' } }, { metadata: { y: '2', x: '1' }, name: 'a' })).toEqual(
            []
        );
    });

    it('names every differing field, both ways', () => {
        expect(frontmatterDifferences({ name: 'a', extra: 'e' }, { name: 'b', other: 'o' })).toEqual([
            'extra: the entry has "e", SKILL.md has nothing',
            'name: the entry has "a", SKILL.md has "b"',
            'other: the entry has nothing, SKILL.md has "o"'
        ]);
    });

    it('compares arrays in order and never coerces types', () => {
        expect(frontmatterDifferences({ tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toHaveLength(2);
        expect(frontmatterDifferences({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual(['tags: the entry has 1 items, SKILL.md has 2']);
        expect(frontmatterDifferences({ version: 1 }, { version: '1' })).toEqual(['version: the entry has 1, SKILL.md has "1"']);
        expect(frontmatterDifferences({ value: null }, { value: false })).toHaveLength(1);
        expect(frontmatterDifferences({ n: 1 }, { n: 1 })).toEqual([]);
    });

    it('reports nested paths', () => {
        expect(frontmatterDifferences({ metadata: { author: 'a' } }, { metadata: { author: 'b' } })).toEqual([
            'metadata.author: the entry has "a", SKILL.md has "b"'
        ]);
    });

    it('reads own keys only, never what Object.prototype supplies', () => {
        expect(frontmatterDifferences({}, { constructor: 'x' })).toEqual(['constructor: the entry has nothing, SKILL.md has "x"']);
        // JSON.parse makes "__proto__" an own key; a lookup through the prototype would see Object.prototype, an empty object.
        expect(frontmatterDifferences(JSON.parse('{"__proto__":{}}'), {})).toEqual(['__proto__: the entry has {}, SKILL.md has nothing']);
    });

    it('sees fields inherited through a prototype, as a reader of the object does', () => {
        expect(frontmatterDifferences(Object.create({ 'allowed-tools': 'Bash(*)' }), {})).toEqual([
            'allowed-tools: the entry has "Bash(*)", SKILL.md has nothing'
        ]);
        expect(frontmatterDifferences({ a: { b: 1 } }, { a: Object.create({ b: 1, c: 2 }) })).toEqual([
            'a.c: the entry has nothing, SKILL.md has 2'
        ]);
    });
});
