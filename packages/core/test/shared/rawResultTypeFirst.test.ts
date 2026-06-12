/**
 * Raw-first result discrimination (V-1) — relocated to its structural home:
 * step 1 of the era codec's `decodeResult`, BEFORE any schema validation
 * (Q1 increment 2; previously a funnel insertion in `_requestWithSchema`).
 *
 * The postures are ERA-SCOPED (Q1-SD3):
 *
 *  2026 era (the connection negotiated '2026-07-28'):
 *  - `resultType` is REQUIRED. Absent → typed error NAMING the spec
 *    violation (the absent⇒complete bridge is scoped to earlier-revision
 *    servers and deliberately NOT extended to modern traffic).
 *  - `input_required` → discriminated driver payload, surfaced as a typed
 *    local error until the multi-round-trip driver (M4.1) consumes it.
 *  - unknown kinds → invalid, no retry. Non-string → invalid.
 *  - `'complete'` → wire-exact parse (resultType present) then lift.
 *
 *  2025 era (any legacy version / unbound instance):
 *  - `resultType` is FOREIGN vocabulary → strip-on-lift (tolerate-and-drop,
 *    whatever its value); validation then judges the actual content. This is
 *    a deliberate behavior migration from the era-blind funnel arm (ledgered;
 *    changeset: codec-split-wire-break).
 *
 * Either way, the V-1 invariant holds: a non-complete body can NEVER be
 * masked into a hollow success by a tolerant result schema.
 */
import { describe, expect, test } from 'vitest';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors.js';
import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import type { JSONRPCRequest } from '../../src/types/index.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';
import { bindWireVersion } from '../../src/wire/codec.js';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

/** Wire a protocol whose peer answers every request with the given raw result body. */
async function wireWithRawResult(rawResult: unknown, era?: '2026-07-28'): Promise<TestProtocol> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    serverTx.onmessage = message => {
        const request = message as JSONRPCRequest;
        void serverTx.send({ jsonrpc: '2.0', id: request.id, result: rawResult } as Parameters<typeof serverTx.send>[0]);
    };
    await serverTx.start();
    const protocol = new TestProtocol();
    await protocol.connect(clientTx);
    if (era) bindWireVersion(protocol, era);
    return protocol;
}

const INPUT_REQUIRED_BODY = {
    resultType: 'input_required',
    inputRequests: { 'elicit-1': { method: 'elicitation/create', params: { mode: 'form', message: 'Name?' } } },
    requestState: 'opaque'
};

async function settle(protocol: TestProtocol): Promise<{ resolved: unknown } | { rejected: unknown }> {
    return protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } }).then(
        result => ({ resolved: result as unknown }),
        error => ({ rejected: error as unknown })
    );
}

describe('raw-first resultType discrimination — 2026 era (codec decode step 1)', () => {
    test('an input_required body surfaces the discriminated kind, never an empty-content success', async () => {
        const protocol = await wireWithRawResult(INPUT_REQUIRED_BODY, '2026-07-28');
        const outcome = await settle(protocol);

        expect('resolved' in outcome, 'must not resolve as a success').toBe(false);
        const rejection = (outcome as { rejected: unknown }).rejected;
        expect(rejection).toBeInstanceOf(SdkError);
        const typed = rejection as SdkError;
        expect(typed.code).toBe(SdkErrorCode.UnsupportedResultType);
        expect(typed.data).toMatchObject({ resultType: 'input_required', method: 'tools/call' });

        await protocol.close();
    });

    test('an unrecognized resultType kind is invalid — surfaced, no retry', async () => {
        const protocol = await wireWithRawResult({ resultType: 'mystery-kind', content: [] }, '2026-07-28');
        const outcome = await settle(protocol);

        expect('rejected' in outcome).toBe(true);
        const rejection = (outcome as { rejected: unknown }).rejected as SdkError;
        expect(rejection).toBeInstanceOf(SdkError);
        expect(rejection.code).toBe(SdkErrorCode.UnsupportedResultType);
        expect(rejection.data).toMatchObject({ resultType: 'mystery-kind' });

        await protocol.close();
    });

    test('ABSENT resultType is a spec violation on the modern leg — typed error naming it (Q1-SD3 i)', async () => {
        // The absent⇒complete bridge is scoped to earlier-revision servers;
        // a 2026-negotiated peer that omits the REQUIRED member is broken.
        const protocol = await wireWithRawResult({ content: [{ type: 'text', text: 'looks fine' }] }, '2026-07-28');
        const outcome = await settle(protocol);

        expect('rejected' in outcome).toBe(true);
        const rejection = (outcome as { rejected: unknown }).rejected as SdkError;
        expect(rejection).toBeInstanceOf(SdkError);
        expect(rejection.code).toBe(SdkErrorCode.InvalidResult);
        expect(rejection.message).toContain('missing required resultType');
        expect(rejection.data).toMatchObject({ method: 'tools/call', violation: 'missing-resultType' });

        await protocol.close();
    });

    test('a non-string resultType can never surface as a success', async () => {
        const protocol = await wireWithRawResult({ resultType: 42, content: [] }, '2026-07-28');
        const outcome = await settle(protocol);

        expect('rejected' in outcome).toBe(true);
        const rejection = (outcome as { rejected: unknown }).rejected as SdkError;
        expect(rejection).toBeInstanceOf(SdkError);
        expect(rejection.code).toBe(SdkErrorCode.InvalidResult);
        expect(rejection.data).toMatchObject({ resultType: 42 });

        await protocol.close();
    });

    test("resultType 'complete' is consumed: the result resolves without the wire member", async () => {
        const protocol = await wireWithRawResult({ resultType: 'complete', content: [{ type: 'text', text: 'done' }] }, '2026-07-28');

        const result = await protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } });
        expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
        expect('resultType' in result).toBe(false);

        await protocol.close();
    });
});

describe('raw-first resultType handling — 2025 era (strip-on-lift, Q1-SD3 ii)', () => {
    test('a foreign input_required body is stripped, then validation judges the content — never a silent success', async () => {
        // BEHAVIOR MIGRATION (ledgered): pre-split, the era-blind funnel arm
        // rejected this with UnsupportedResultType on every leg. On the 2025
        // era resultType carries no meaning — the ruled posture strips the
        // foreign key and lets validation decide. The body has no content,
        // so it fails the (default-free) tools/call result schema LOUDLY —
        // the V-1 invariant (never a hollow success) holds.
        const protocol = await wireWithRawResult(INPUT_REQUIRED_BODY);
        const outcome = await settle(protocol);

        expect('resolved' in outcome, 'must not resolve as a success').toBe(false);
        const rejection = (outcome as { rejected: unknown }).rejected as SdkError;
        expect(rejection).toBeInstanceOf(SdkError);
        expect(rejection.code).toBe(SdkErrorCode.InvalidResult);

        await protocol.close();
    });

    test('a foreign non-string resultType is stripped; an otherwise-valid result resolves without it', async () => {
        const protocol = await wireWithRawResult({ resultType: 42, content: [{ type: 'text', text: 'ok' }] });

        const result = await protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } });
        expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
        expect('resultType' in result).toBe(false);

        await protocol.close();
    });

    test("resultType 'complete' on a strict empty result still parses (stripped before validation)", async () => {
        const protocol = await wireWithRawResult({ resultType: 'complete' });

        const result = await protocol.request({ method: 'ping' });
        expect(result).toEqual({});

        await protocol.close();
    });

    test('absent resultType is untouched 2025-era behavior (siblings kept)', async () => {
        const protocol = await wireWithRawResult({ content: [{ type: 'text', text: 'plain' }], extraSibling: 'kept' });

        const result = await protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } });
        expect(result.content).toEqual([{ type: 'text', text: 'plain' }]);
        expect((result as Record<string, unknown>).extraSibling).toBe('kept');

        await protocol.close();
    });
});

describe('decode step 2 — the wire-exact schema lookup is own-key only', () => {
    test("a prototype-chain method name (e.g. 'constructor') skips the wire-exact parse instead of throwing", async () => {
        const { rev2026Codec } = await import('../../src/wire/rev2026-07-28/codec.js');
        // A bare object-prototype hit would surface Function (not a schema)
        // and throw a TypeError out of the decode hop. The lookup must treat
        // non-own keys exactly like unknown methods: no wire-exact parse,
        // straight to the lift.
        const decoded = rev2026Codec.decodeResult('constructor', { resultType: 'complete', anything: 'kept' });
        expect(decoded.kind).toBe('complete');
        if (decoded.kind === 'complete') {
            expect((decoded.result as Record<string, unknown>).anything).toBe('kept');
            expect('resultType' in decoded.result).toBe(false);
        }
    });
});
