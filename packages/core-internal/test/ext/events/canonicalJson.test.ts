import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../../src/ext/events/canonicalJson';

describe('canonicalJson', () => {
    it('sorts object keys at every depth, keeps array order and drops undefined members', () => {
        expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, z: undefined })).toBe(
            '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}'
        );
    });

    it('does not depend on key insertion order', () => {
        expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
    });

    it('sorts integer-like keys as strings', () => {
        expect(canonicalJson({ 9: 'b', 10: 'a', a: 'c' })).toBe('{"10":"a","9":"b","a":"c"}');
    });

    it('otherwise follows JSON.stringify', () => {
        const values = [undefined, () => 1, Number.NaN, 'é\n"', new Date(0), null, true, -0.5];
        expect(canonicalJson(values)).toBe(JSON.stringify(values));
        expect(canonicalJson({ when: new Date(0), nested: { toJSON: () => ({ b: 1, a: 2 }) } })).toBe(
            '{"nested":{"a":2,"b":1},"when":"1970-01-01T00:00:00.000Z"}'
        );
        expect(canonicalJson('x')).toBe('"x"');
        expect(() => canonicalJson({ big: 1n })).toThrow(TypeError);
    });

    it('throws for a value with no JSON text', () => {
        expect(() => canonicalJson(undefined)).toThrow(TypeError);
    });
});
