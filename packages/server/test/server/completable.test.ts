import * as z from 'zod/v4';
import { describe, expect, it } from 'vitest';

import { completable, getCompleter, isCompletable } from '../../src/server/completable';

describe('completable with Zod v4', () => {
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

    it('retains completion when Zod methods are chained after completable()', async () => {
        const completions = ['typescript', 'javascript', 'python'];
        const base = completable(z.string(), value => completions.filter(lang => lang.startsWith(value)));

        const chainedDescribe = base.describe('Programming language');
        expect(isCompletable(chainedDescribe)).toBe(true);
        expect(getCompleter(chainedDescribe)).toBeDefined();
        expect(await getCompleter(chainedDescribe)!('type')).toEqual(['typescript']);

        const chainedMin = base.min(2);
        expect(isCompletable(chainedMin)).toBe(true);
        expect(getCompleter(chainedMin)).toBeDefined();
        expect(await getCompleter(chainedMin)!('py')).toEqual(['python']);

        const chainedOptional = base.optional();
        expect(isCompletable(chainedOptional)).toBe(true);
        expect(getCompleter(chainedOptional)).toBeDefined();
        expect(await getCompleter(chainedOptional)!('java')).toEqual(['javascript']);

        const chainedDefault = base.default('typescript');
        expect(isCompletable(chainedDefault)).toBe(true);
        expect(getCompleter(chainedDefault)).toBeDefined();
        expect(await getCompleter(chainedDefault)!('')).toEqual(completions);

        const chainedNullable = base.nullable();
        expect(isCompletable(chainedNullable)).toBe(true);
        expect(getCompleter(chainedNullable)).toBeDefined();
        expect(await getCompleter(chainedNullable)!('')).toEqual(completions);

        const chainedMulti = base.describe('Language').min(1).optional().default('python');
        expect(isCompletable(chainedMulti)).toBe(true);
        expect(getCompleter(chainedMulti)).toBeDefined();
        expect(await getCompleter(chainedMulti)!('py')).toEqual(['python']);
    });
});
