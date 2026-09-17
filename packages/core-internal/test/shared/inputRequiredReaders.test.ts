/**
 * Typed readers for a retried request's `inputResponses`
 * (`ctx.mcpReq.inputResponses`): the schema-aware `acceptedContent` overload
 * and the discriminated `inputResponse` view.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { acceptedContent, inputResponse } from '../../src/shared/inputRequired';

const ACCEPTED = { action: 'accept', content: { count: '10', theme: 'release week' } };
const DECLINED = { action: 'decline' };
const SAMPLING = { role: 'assistant', content: { type: 'text', text: 'idea-1' }, model: 'test-model' };
const ROOTS = { roots: [{ uri: 'file:///ws', name: 'ws' }] };

describe('acceptedContent schema overload', () => {
    const schema = z.object({ count: z.string(), theme: z.string().optional() });

    it('returns validated, typed content for an accepted response', () => {
        const content = acceptedContent({ key: ACCEPTED }, 'key', schema);
        expect(content).toEqual({ count: '10', theme: 'release week' });
    });

    it('returns undefined when validation fails (malformed untrusted content never reaches the handler typed)', () => {
        expect(acceptedContent({ key: { action: 'accept', content: { count: 42 } } }, 'key', schema)).toBeUndefined();
    });

    it('returns undefined for declined, missing, and non-elicit entries (same as the 2-arg form)', () => {
        expect(acceptedContent({ key: DECLINED }, 'key', schema)).toBeUndefined();
        expect(acceptedContent({}, 'key', schema)).toBeUndefined();
        expect(acceptedContent(undefined, 'key', schema)).toBeUndefined();
        expect(acceptedContent({ key: SAMPLING }, 'key', schema)).toBeUndefined();
    });

    it('applies schema transforms (the output type, not the input shape)', () => {
        const coercing = z.object({ count: z.string().transform(value => Number.parseInt(value, 10)) });
        expect(acceptedContent({ key: ACCEPTED }, 'key', coercing)).toEqual({ count: 10 });
    });

    it('throws on an asynchronously-validating schema', () => {
        const asyncSchema = z.object({ count: z.string() }).refine(async () => true);
        expect(() => acceptedContent({ key: ACCEPTED }, 'key', asyncSchema)).toThrow(TypeError);
    });

    it('the 2-arg form is unchanged (structural read, unvalidated cast)', () => {
        expect(acceptedContent<{ count: string }>({ key: ACCEPTED }, 'key')).toEqual({ count: '10', theme: 'release week' });
        expect(acceptedContent({ key: DECLINED }, 'key')).toBeUndefined();
    });
});

describe('inputResponse discriminated view', () => {
    it('discriminates elicitation responses with action and content', () => {
        expect(inputResponse({ key: ACCEPTED }, 'key')).toEqual({
            kind: 'elicit',
            action: 'accept',
            content: { count: '10', theme: 'release week' }
        });
        expect(inputResponse({ key: DECLINED }, 'key')).toEqual({ kind: 'elicit', action: 'decline' });
        expect(inputResponse({ key: { action: 'cancel' } }, 'key')).toEqual({ kind: 'elicit', action: 'cancel' });
    });

    it('discriminates sampling and roots responses', () => {
        expect(inputResponse({ key: SAMPLING }, 'key')).toEqual({ kind: 'sampling', result: SAMPLING });
        expect(inputResponse({ key: ROOTS }, 'key')).toEqual({ kind: 'roots', roots: ROOTS.roots });
    });

    it('reads missing keys and malformed entries as missing', () => {
        expect(inputResponse({}, 'key')).toEqual({ kind: 'missing' });
        expect(inputResponse(undefined, 'key')).toEqual({ kind: 'missing' });
        expect(inputResponse({ key: 'not-an-object' }, 'key')).toEqual({ kind: 'missing' });
        expect(inputResponse({ key: { action: 'something-else' } }, 'key')).toEqual({ kind: 'missing' });
        expect(inputResponse({ key: null }, 'key')).toEqual({ kind: 'missing' });
        expect(inputResponse({ key: [1, 2] }, 'key')).toEqual({ kind: 'missing' });
    });
});
