import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { BaseContext, ProtocolSpec, SpecRequests } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';

class TestProtocol<SpecT extends ProtocolSpec = ProtocolSpec> extends Protocol<BaseContext, SpecT> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected assertTaskCapability(): void {}
    protected assertTaskHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

describe('ProtocolSpec typing', () => {
    type AppSpec = {
        requests: {
            'ui/open-link': { params: { url: string }; result: { opened: boolean } };
        };
        notifications: {
            'ui/size-changed': { params: { width: number; height: number } };
        };
    };

    type _Assert<T extends true> = T;
    type _Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    type _t1 = _Assert<_Eq<SpecRequests<AppSpec>, 'ui/open-link'>>;
    type _t2 = _Assert<_Eq<SpecRequests<ProtocolSpec>, never>>;
    void (undefined as unknown as [_t1, _t2]);

    it('typed-SpecT overload infers params/result; string fallback still works', async () => {
        const [t1, t2] = InMemoryTransport.createLinkedPair();
        const app = new TestProtocol<AppSpec>();
        const host = new TestProtocol<AppSpec>();
        await app.connect(t1);
        await host.connect(t2);

        host.setRequestHandler('ui/open-link', z.object({ url: z.string() }), p => {
            const _typed: string = p.url;
            void _typed;
            return { opened: true };
        });
        const r = await app.request({ method: 'ui/open-link', params: { url: 'https://x' } }, z.object({ opened: z.boolean() }));
        expect(r.opened).toBe(true);

        host.setRequestHandler('not/in-spec', z.object({ n: z.number() }), p => ({ doubled: p.n * 2 }));
        const r2 = await app.request({ method: 'not/in-spec', params: { n: 3 } }, z.object({ doubled: z.number() }));
        expect(r2.doubled).toBe(6);
    });

    it('typed-SpecT overload types handler from passed schema, not SpecT (regression)', () => {
        type Spec = { requests: { 'x/y': { params: { a: string; b: string }; result: { ok: boolean } } } };
        const p = new TestProtocol<Spec>();
        const Narrow = z.object({ a: z.string() });
        p.setRequestHandler('x/y', Narrow, params => {
            const _a: string = params.a;
            // @ts-expect-error -- params is InferOutput<Narrow>, has no 'b' even though Spec does
            const _b: string = params.b;
            void _a;
            void _b;
            return { ok: true };
        });
    });
});
