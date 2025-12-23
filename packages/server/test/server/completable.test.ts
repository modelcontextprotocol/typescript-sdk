import { completable, getCompleter } from '../../src/server/completable.js';
import type { ZodMatrixEntry } from './__fixtures__/zodTestMatrix.js';
import { zodTestMatrix } from './__fixtures__/zodTestMatrix.js';

describe.each(zodTestMatrix)('completable with $zodVersionLabel', (entry: ZodMatrixEntry) => {
    const { z } = entry;
    it('preserves types and values of underlying schema', () => {
        const baseSchema = z.string();
        const schema = completable(baseSchema, () => []);

        expect(schema.parse('test')).toBe('test');
        expect(() => schema.parse(123)).toThrow();
    });

    it('provides access to completion function', async () => {
        const completions = ['foo', 'bar', 'baz'];
        const schema = completable(z.string(), () => completions);

        const completer = getCompleter(schema);
        expect(completer).toBeDefined();
        expect(await completer!('')).toEqual(completions);
    });

    it('allows async completion functions', async () => {
        const completions = ['foo', 'bar', 'baz'];
        const schema = completable(z.string(), async () => completions);

        const completer = getCompleter(schema);
        expect(completer).toBeDefined();
        expect(await completer!('')).toEqual(completions);
    });

    it('passes current value to completion function', async () => {
        const schema = completable(z.string(), value => [value + '!']);

        const completer = getCompleter(schema);
        expect(completer).toBeDefined();
        expect(await completer!('test')).toEqual(['test!']);
    });

    it('works with number schemas', async () => {
        const schema = completable(z.number(), () => [1, 2, 3]);

        expect(schema.parse(1)).toBe(1);
        const completer = getCompleter(schema);
        expect(completer).toBeDefined();
        expect(await completer!(0)).toEqual([1, 2, 3]);
    });

    it('preserves schema description', () => {
        const desc = 'test description';
        const schema = completable(z.string().describe(desc), () => []);

        expect(schema.description).toBe(desc);
    });
});
