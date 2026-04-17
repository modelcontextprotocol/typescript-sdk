import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import type { StandardSchemaV1 } from '../../src/util/standardSchema.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected assertTaskCapability(): void {}
    protected assertTaskHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

async function makePair() {
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const a = new TestProtocol();
    const b = new TestProtocol();
    await a.connect(t1);
    await b.connect(t2);
    return { a, b };
}

describe('setRequestHandler — three-arg paramsSchema form', () => {
    it('round-trips a custom request with validated params', async () => {
        const { a, b } = await makePair();
        b.setRequestHandler('acme/echo', z.object({ msg: z.string() }), params => ({ reply: params.msg.toUpperCase() }));
        const result = await a.request({ method: 'acme/echo', params: { msg: 'hi' } }, z.object({ reply: z.string() }));
        expect(result).toEqual({ reply: 'HI' });
    });

    it('rejects invalid params with InvalidParams', async () => {
        const { a, b } = await makePair();
        b.setRequestHandler('acme/echo', z.object({ msg: z.string() }), p => ({ reply: p.msg }));
        await expect(a.request({ method: 'acme/echo', params: { msg: 42 } }, z.object({ reply: z.string() }))).rejects.toThrow(
            /Invalid params for acme\/echo/
        );
    });

    it('normalizes absent params to {}', async () => {
        const { a, b } = await makePair();
        let seen: unknown;
        b.setRequestHandler('acme/noop', z.object({}).strict(), p => {
            seen = p;
            return {};
        });
        await a.request({ method: 'acme/noop' }, z.object({}));
        expect(seen).toEqual({});
    });

    it('strips _meta before validating against paramsSchema', async () => {
        const { a, b } = await makePair();
        let seen: unknown;
        b.setRequestHandler('acme/noop', z.object({}).strict(), p => {
            seen = p;
            return {};
        });
        await a.request({ method: 'acme/noop', params: { _meta: { trace: 'x' } } }, z.object({}));
        expect(seen).toEqual({});
    });
});

describe('setNotificationHandler — three-arg paramsSchema form', () => {
    it('receives a custom notification', async () => {
        const { a, b } = await makePair();
        const received: unknown[] = [];
        b.setNotificationHandler('acme/tick', z.object({ n: z.number() }), p => {
            received.push(p);
        });
        await a.notification({ method: 'acme/tick', params: { n: 1 } });
        await a.notification({ method: 'acme/tick', params: { n: 2 } });
        await new Promise(r => setTimeout(r, 0));
        expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    });
});

describe('non-Zod StandardSchemaV1', () => {
    function makeStandardSchema<T>(check: (v: unknown) => v is T): StandardSchemaV1<T> {
        return {
            '~standard': {
                version: 1 as const,
                vendor: 'test',
                types: undefined as unknown as { input: T; output: T },
                validate: (v: unknown) => (check(v) ? { value: v } : { issues: [{ message: 'invalid', path: [] }] })
            }
        };
    }

    it('accepts a hand-rolled StandardSchemaV1 in 3-arg setRequestHandler', async () => {
        const { a, b } = await makePair();
        type Params = { n: number };
        const Params = makeStandardSchema<Params>((v): v is Params => typeof (v as Params)?.n === 'number');
        b.setRequestHandler('acme/double', Params, (p: Params) => ({ doubled: p.n * 2 }));
        const r = await a.request({ method: 'acme/double', params: { n: 21 } }, z.object({ doubled: z.number() }));
        expect(r.doubled).toBe(42);
    });
});
