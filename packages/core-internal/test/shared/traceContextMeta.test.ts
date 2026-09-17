import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { Protocol } from '../../src/shared/protocol';
import type { BaseContext } from '../../src/exports/public/index';
import { BAGGAGE_META_KEY, TRACEPARENT_META_KEY, TRACESTATE_META_KEY } from '../../src/exports/public/index';
import { InMemoryTransport } from '../../src/util/inMemory';

class TestProtocol extends Protocol<BaseContext> {
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
}

async function pair(): Promise<[TestProtocol, TestProtocol]> {
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const a = new TestProtocol();
    const b = new TestProtocol();
    await a.connect(t1);
    await b.connect(t2);
    return [a, b];
}

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACESTATE = 'vendor1=opaqueValue1,vendor2=opaqueValue2';
const BAGGAGE = 'userId=alice,serverRegion=us-east-1';

describe('SEP-414 trace context `_meta` passthrough', () => {
    it('exposes reserved unprefixed key names', () => {
        // SEP-414 reserves these exact unprefixed keys as an exception to the
        // `_meta` prefix rule; a drifted constant would break interop.
        expect(TRACEPARENT_META_KEY).toBe('traceparent');
        expect(TRACESTATE_META_KEY).toBe('tracestate');
        expect(BAGGAGE_META_KEY).toBe('baggage');
    });

    it('passes request `_meta` trace context through to the server-side handler untouched', async () => {
        const [a, b] = await pair();
        let seenMeta: Record<string, unknown> | undefined;
        b.setRequestHandler('acme/traced', { params: z.object({ v: z.string() }) }, async (params, ctx) => {
            seenMeta = ctx.mcpReq._meta;
            return { echoed: params.v };
        });

        await a.request(
            {
                method: 'acme/traced',
                params: {
                    v: 'x',
                    _meta: {
                        [TRACEPARENT_META_KEY]: TRACEPARENT,
                        [TRACESTATE_META_KEY]: TRACESTATE,
                        [BAGGAGE_META_KEY]: BAGGAGE
                    }
                }
            },
            z.object({ echoed: z.string() })
        );

        expect(seenMeta).toMatchObject({
            [TRACEPARENT_META_KEY]: TRACEPARENT,
            [TRACESTATE_META_KEY]: TRACESTATE,
            [BAGGAGE_META_KEY]: BAGGAGE
        });
    });

    it('passes response `_meta` trace context back to the requester untouched', async () => {
        const [a, b] = await pair();
        b.setRequestHandler('acme/traced', { params: z.object({}) }, async (_params, ctx) => ({
            ok: true,
            _meta: {
                // Echo the inbound trace context onto the response envelope.
                ...ctx.mcpReq._meta
            }
        }));

        const result = await a.request(
            {
                method: 'acme/traced',
                params: {
                    _meta: {
                        [TRACEPARENT_META_KEY]: TRACEPARENT,
                        [TRACESTATE_META_KEY]: TRACESTATE,
                        [BAGGAGE_META_KEY]: BAGGAGE
                    }
                }
            },
            z.object({ ok: z.boolean(), _meta: z.record(z.string(), z.unknown()).optional() })
        );

        expect(result.ok).toBe(true);
        expect(result._meta).toMatchObject({
            [TRACEPARENT_META_KEY]: TRACEPARENT,
            [TRACESTATE_META_KEY]: TRACESTATE,
            [BAGGAGE_META_KEY]: BAGGAGE
        });
    });

    it('passes notification `_meta` trace context through to the handler', async () => {
        const [a, b] = await pair();
        let seenMeta: unknown;
        b.setNotificationHandler('acme/tracedEvent', { params: z.object({ stage: z.string() }) }, (_params, notification) => {
            seenMeta = notification.params?._meta;
        });

        await a.notification({
            method: 'acme/tracedEvent',
            params: {
                stage: 'fetch',
                _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT, [BAGGAGE_META_KEY]: BAGGAGE }
            }
        });
        await new Promise(r => setTimeout(r, 0));

        expect(seenMeta).toEqual({ [TRACEPARENT_META_KEY]: TRACEPARENT, [BAGGAGE_META_KEY]: BAGGAGE });
    });
});
