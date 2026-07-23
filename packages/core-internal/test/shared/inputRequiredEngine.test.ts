/**
 * The multi-round-trip auto-fulfilment engine wiring (the layer between the
 * funnel hook and the driver loop): the per-retry-leg request-options
 * whitelist, the input-responses partition, and the synthesized embedded
 * dispatch context.
 */
import { describe, expect, test } from 'vitest';

import { buildRetryLegRequestOptions, partitionInputResponses, synthesizeInputRequestContext } from '../../src/shared/inputRequiredEngine';

describe('per-retry-leg request options whitelist', () => {
    test('only the whitelisted fields carry over — resumption tokens and the related-request id never do', () => {
        const controller = new AbortController();
        const onprogress = (): void => undefined;
        const onresumptiontoken = (): void => undefined;
        const built = buildRetryLegRequestOptions(
            {
                signal: controller.signal,
                onprogress,
                resetTimeoutOnProgress: true,
                timeout: 9_999,
                maxTotalTimeout: 99_999,
                relatedRequestId: 'outer',
                resumptionToken: 'tok-123',
                onresumptiontoken
            },
            { timeout: 5_000, maxTotalTimeout: 60_000 }
        );
        expect(built).toEqual({
            signal: controller.signal,
            onprogress,
            resetTimeoutOnProgress: true,
            timeout: 5_000,
            maxTotalTimeout: 60_000,
            allowInputRequired: true
        });
        // The originating call's transport-send options are scoped to the
        // originating wire leg only.
        expect('resumptionToken' in built).toBe(false);
        expect('onresumptiontoken' in built).toBe(false);
        expect('relatedRequestId' in built).toBe(false);
    });

    test('absent caller options yield only the manual primitive opt-in', () => {
        expect(buildRetryLegRequestOptions(undefined, {})).toEqual({ allowInputRequired: true });
    });

    test('per-request headers (SEP-2243 Mcp-Param-*) carry to retry legs — arguments are unchanged on retry', () => {
        const headers = { 'Mcp-Param-Region': 'us-west1' };
        const built = buildRetryLegRequestOptions({ headers }, {});
        expect(built).toEqual({ headers, allowInputRequired: true });
    });
});

describe('inputResponses partition', () => {
    test('bare entries are accepted; wrapped {method, result} entries and non-objects are dropped by key', () => {
        const { accepted, droppedKeys } = partitionInputResponses({
            confirm: { action: 'accept', content: { ok: true } },
            wrapped: { method: 'elicitation/create', result: { action: 'accept' } },
            bad: 7
        });
        expect(accepted).toEqual({ confirm: { action: 'accept', content: { ok: true } } });
        expect(droppedKeys.sort()).toEqual(['bad', 'wrapped']);
    });
});

describe('synthesized embedded dispatch context', () => {
    test('id is the inputRequests key, the supplied signal chains through, and related send/notify are unavailable', () => {
        const controller = new AbortController();
        const ctx = synthesizeInputRequestContext('confirm', 'elicitation/create', { _meta: { x: 1 } }, controller.signal, 'sess-1');
        expect(ctx.mcpReq.id).toBe('confirm');
        expect(ctx.mcpReq.method).toBe('elicitation/create');
        expect(ctx.mcpReq.signal).toBe(controller.signal);
        expect(ctx.sessionId).toBe('sess-1');
        expect(() => ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 0, progress: 1 } })).toThrowError(
            /not available while fulfilling an embedded input request/
        );
    });
});
