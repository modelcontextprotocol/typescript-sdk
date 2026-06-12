/**
 * Raw-first result discrimination: the client funnel inspects the raw
 * `resultType` member BEFORE any schema validation.
 *
 * The hazard this closes: tolerant result schemas (defaults filling absent
 * members, loose passthrough) would otherwise mask a non-complete result —
 * e.g. an `input_required` body parsing as a successful empty tool result.
 * The raw check runs first, so:
 *
 *  - `input_required` (or any non-`complete` kind) → typed local error
 *    carrying the discriminated kind; never a hollow success; no retry.
 *  - non-string `resultType` → typed invalid-result error (checked raw,
 *    before any schema could coerce or tolerate it).
 *  - `'complete'` → the discriminator is consumed (stripped) and the result
 *    parses as the public shape.
 *  - absent → untouched (2025-era behavior, byte-identical).
 */
import { describe, expect, test } from 'vitest';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors.js';
import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';
import type { JSONRPCRequest } from '../../src/types/index.js';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

/** Wire a protocol whose peer answers every request with the given raw result body. */
async function wireWithRawResult(rawResult: unknown): Promise<TestProtocol> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    serverTx.onmessage = message => {
        const request = message as JSONRPCRequest;
        void serverTx.send({ jsonrpc: '2.0', id: request.id, result: rawResult } as Parameters<typeof serverTx.send>[0]);
    };
    await serverTx.start();
    const protocol = new TestProtocol();
    await protocol.connect(clientTx);
    return protocol;
}

describe('raw-first resultType discrimination in the request funnel', () => {
    test('an input_required body surfaces the discriminated kind, never an empty-content success', async () => {
        // The exact masking hazard: tools/call's result schema defaults
        // content to [] — without the raw-first check this body would
        // resolve as { content: [] }.
        const protocol = await wireWithRawResult({
            resultType: 'input_required',
            inputRequests: { 'elicit-1': { method: 'elicitation/create', params: { mode: 'form', message: 'Name?' } } },
            requestState: 'opaque'
        });

        const outcome = await protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } }).then(
            result => ({ resolved: result as unknown }),
            error => ({ rejected: error as unknown })
        );

        expect('resolved' in outcome, 'must not resolve as a success').toBe(false);
        const rejection = (outcome as { rejected: unknown }).rejected;
        expect(rejection).toBeInstanceOf(SdkError);
        const typed = rejection as SdkError;
        expect(typed.code).toBe(SdkErrorCode.UnsupportedResultType);
        expect(typed.data).toMatchObject({ resultType: 'input_required', method: 'tools/call' });

        await protocol.close();
    });

    test('an unrecognized resultType kind is invalid — surfaced, no retry', async () => {
        const protocol = await wireWithRawResult({ resultType: 'mystery-kind', content: [] });

        const rejection = await protocol
            .request({ method: 'tools/call', params: { name: 'echo', arguments: {} } })
            .catch((error: unknown) => error);
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.UnsupportedResultType);
        expect((rejection as SdkError).data).toMatchObject({ resultType: 'mystery-kind' });

        await protocol.close();
    });

    test('a non-string resultType can never surface as a success (rejected at message classification)', async () => {
        // A response whose resultType is not a string fails the JSON-RPC
        // envelope classification (the wire schema types the member), so it
        // is reported out-of-band and never reaches the result funnel — and
        // can therefore never be masked into a success. The funnel keeps a
        // defensive raw-type check for the day classification loosens.
        const protocol = await wireWithRawResult({ resultType: 42, content: [] });
        const outOfBand: Error[] = [];
        protocol.onerror = error => void outOfBand.push(error);

        let settled: unknown;
        const pending = protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } }).then(
            result => {
                settled = { resolved: result };
            },
            error => {
                settled = { rejected: error };
            }
        );

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(settled, 'must not resolve as a success').toBeUndefined();
        expect(outOfBand.length).toBeGreaterThan(0);
        expect(String(outOfBand[0]?.message)).toContain('Unknown message type');

        // Teardown settles the in-flight request (connection closed).
        await protocol.close();
        await pending;
        expect(settled).toHaveProperty('rejected');
    });

    test("resultType 'complete' is consumed: the result resolves without the wire member", async () => {
        const protocol = await wireWithRawResult({
            resultType: 'complete',
            content: [{ type: 'text', text: 'done' }]
        });

        const result = await protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } });
        expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
        expect('resultType' in result).toBe(false);

        await protocol.close();
    });

    test("resultType 'complete' on a strict empty result still parses (stripped before validation)", async () => {
        const protocol = await wireWithRawResult({ resultType: 'complete' });

        // EmptyResultSchema is strict; the discriminator is consumed before
        // validation, so the 2026-era ack parses as the public empty result.
        const result = await protocol.request({ method: 'ping' });
        expect(result).toEqual({});

        await protocol.close();
    });

    test('absent resultType is untouched 2025-era behavior', async () => {
        const protocol = await wireWithRawResult({ content: [{ type: 'text', text: 'plain' }], extra: 'kept' });

        const result = await protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } });
        expect(result.content).toEqual([{ type: 'text', text: 'plain' }]);
        expect((result as Record<string, unknown>).extra).toBe('kept');

        await protocol.close();
    });
});
