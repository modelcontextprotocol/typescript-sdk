/**
 * The multi-round-trip authoring helpers (M4.1): the `inputRequired()`
 * builder family, the `acceptedContent` reader, and the `withInputRequired`
 * manual-mode schema wrapper. No nominal brand exists — the builder returns a
 * plain `resultType: 'input_required'` value (F-10).
 */
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { acceptedContent, inputRequired, withInputRequired } from '../../src/shared/inputRequired';
import { isInputRequiredResult } from '../../src/types/guards';
import { validateStandardSchema } from '../../src/util/standardSchema';

describe('inputRequired() builder', () => {
    test('builds a plain discriminated value (no brand) from inputRequests', () => {
        const value = inputRequired({
            inputRequests: { confirm: inputRequired.elicit({ message: 'OK?', requestedSchema: { type: 'object', properties: {} } }) }
        });
        expect(value.resultType).toBe('input_required');
        expect(Object.getOwnPropertySymbols(value)).toEqual([]);
        expect(isInputRequiredResult(value)).toBe(true);
        expect(value.inputRequests?.confirm).toMatchObject({ method: 'elicitation/create', params: { mode: 'form', message: 'OK?' } });
        expect(value.requestState).toBeUndefined();
    });

    test('builds a requestState-only value (load shedding)', () => {
        const value = inputRequired({ requestState: 'opaque-blob' });
        expect(value).toEqual({ resultType: 'input_required', requestState: 'opaque-blob' });
    });

    test('enforces the at-least-one rule', () => {
        expect(() => inputRequired({})).toThrow(TypeError);
        expect(() => inputRequired({ inputRequests: {} })).toThrow(/at least one/);
    });

    test('hand-built literals discriminate identically (hand-built results are legal)', () => {
        expect(isInputRequiredResult({ resultType: 'input_required', requestState: 's' })).toBe(true);
        expect(isInputRequiredResult({ resultType: 'complete' })).toBe(false);
        expect(isInputRequiredResult({ content: [] })).toBe(false);
        expect(isInputRequiredResult(null)).toBe(false);
    });

    test('per-kind constructors produce the embedded request shapes', () => {
        expect(inputRequired.elicitUrl({ message: 'go', url: 'https://example.com/auth' })).toEqual({
            method: 'elicitation/create',
            params: { mode: 'url', message: 'go', url: 'https://example.com/auth' }
        });
        expect(inputRequired.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 5 })).toEqual({
            method: 'sampling/createMessage',
            params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 5 }
        });
        expect(inputRequired.listRoots()).toEqual({ method: 'roots/list' });
    });
});

describe('acceptedContent()', () => {
    test('returns the accepted form content for the key', () => {
        const responses = { confirm: { action: 'accept', content: { confirm: true } } };
        expect(acceptedContent<{ confirm: boolean }>(responses, 'confirm')).toEqual({ confirm: true });
    });

    test('returns undefined for missing keys, declined/cancelled responses, and other kinds', () => {
        expect(acceptedContent(undefined, 'confirm')).toBeUndefined();
        expect(acceptedContent({}, 'confirm')).toBeUndefined();
        expect(acceptedContent({ confirm: { action: 'decline' } }, 'confirm')).toBeUndefined();
        expect(acceptedContent({ confirm: { action: 'cancel' } }, 'confirm')).toBeUndefined();
        expect(acceptedContent({ confirm: { action: 'accept' } }, 'confirm')).toBeUndefined();
        expect(acceptedContent({ roots: { roots: [] } }, 'roots')).toBeUndefined();
    });
});

describe('withInputRequired()', () => {
    const inner = z.object({ content: z.array(z.unknown()) });

    test('passes input-required values through untouched', async () => {
        const wrapped = withInputRequired(inner);
        const value = { resultType: 'input_required', requestState: 'blob' };
        const outcome = await validateStandardSchema(wrapped, value);
        expect(outcome).toEqual({ success: true, data: value });
    });

    test('validates complete results against the wrapped schema', async () => {
        const wrapped = withInputRequired(inner);
        const ok = await validateStandardSchema(wrapped, { content: [] });
        expect(ok.success).toBe(true);
        const bad = await validateStandardSchema(wrapped, { nope: true });
        expect(bad.success).toBe(false);
    });
});
