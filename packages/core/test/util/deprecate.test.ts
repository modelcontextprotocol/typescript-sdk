import { describe, it, expect, vi, afterEach } from 'vitest';
import { deprecate, _resetDeprecationWarnings } from '../../src/util/deprecate.js';

describe('deprecate', () => {
    afterEach(() => _resetDeprecationWarnings());
    it('warns once per key', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        deprecate('k', 'msg');
        deprecate('k', 'msg');
        deprecate('other', 'msg2');
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
    });
});
