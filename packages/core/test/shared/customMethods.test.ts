import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';

// Minimal concrete Protocol for tests; capability checks are no-ops.
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

const EchoRequest = z.object({ method: z.literal('acme/echo'), params: z.object({ msg: z.string() }) });
const TickNotification = z.object({ method: z.literal('acme/tick'), params: z.object({ n: z.number() }) });

describe('setRequestHandler — Zod-schema form', () => {
    it('round-trips a custom request via Zod schema', async () => {
        const { a, b } = await makePair();
        b.setRequestHandler(EchoRequest, req => ({ reply: req.params.msg.toUpperCase() }));
        const result = await a.request({ method: 'acme/echo', params: { msg: 'hi' } }, z.object({ reply: z.string() }));
        expect(result).toEqual({ reply: 'HI' });
    });

    it('rejects invalid params via the Zod schema', async () => {
        const { a, b } = await makePair();
        b.setRequestHandler(EchoRequest, req => ({ reply: req.params.msg }));
        await expect(a.request({ method: 'acme/echo', params: { msg: 42 } }, z.object({ reply: z.string() }))).rejects.toThrow();
    });

    it('removeRequestHandler works for any method string', async () => {
        const { a, b } = await makePair();
        b.setRequestHandler(EchoRequest, req => ({ reply: req.params.msg }));
        await expect(a.request({ method: 'acme/echo', params: { msg: 'x' } }, z.object({ reply: z.string() }))).resolves.toEqual({
            reply: 'x'
        });
        b.removeRequestHandler('acme/echo');
        await expect(a.request({ method: 'acme/echo', params: { msg: 'x' } }, z.object({ reply: z.string() }))).rejects.toThrow(
            /Method not found/
        );
    });

    it('two-arg spec-method form still works', async () => {
        const { a, b } = await makePair();
        let pinged = false;
        b.setRequestHandler('ping', () => {
            pinged = true;
            return {};
        });
        await a.request({ method: 'ping' });
        expect(pinged).toBe(true);
    });
});

describe('setNotificationHandler — Zod-schema form', () => {
    it('receives a custom notification via Zod schema', async () => {
        const { a, b } = await makePair();
        const received: unknown[] = [];
        b.setNotificationHandler(TickNotification, n => {
            received.push(n.params);
        });
        await a.notification({ method: 'acme/tick', params: { n: 1 } });
        await a.notification({ method: 'acme/tick', params: { n: 2 } });
        await new Promise(r => setTimeout(r, 0));
        expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('two-arg spec-method form still works', async () => {
        const { a, b } = await makePair();
        let got = false;
        b.setNotificationHandler('notifications/initialized', () => {
            got = true;
        });
        await a.notification({ method: 'notifications/initialized' });
        await new Promise(r => setTimeout(r, 0));
        expect(got).toBe(true);
    });
});

describe('request() — explicit result schema overload', () => {
    it('uses the supplied result schema for a non-spec method', async () => {
        const { a, b } = await makePair();
        b.setRequestHandler(EchoRequest, req => ({ reply: req.params.msg }));
        const r = await a.request({ method: 'acme/echo', params: { msg: 'ok' } }, z.object({ reply: z.string() }));
        expect(r.reply).toBe('ok');
    });

    it('spec method without schema uses method-keyed return type', async () => {
        const { a, b } = await makePair();
        b.setRequestHandler('ping', () => ({}));
        const r = await a.request({ method: 'ping' });
        expect(r).toEqual({});
    });
});

describe('ctx.mcpReq.send() — explicit result schema overload', () => {
    it('forwards to a related request and validates result via the supplied schema', async () => {
        const { a, b } = await makePair();
        a.setRequestHandler(EchoRequest, req => ({ reply: req.params.msg }));
        let captured: unknown;
        b.setRequestHandler(z.object({ method: z.literal('acme/outer') }), async (_req, ctx) => {
            captured = await ctx.mcpReq.send({ method: 'acme/echo', params: { msg: 'via-send' } }, z.object({ reply: z.string() }));
            return {};
        });
        await a.request({ method: 'acme/outer' }, z.object({}));
        expect(captured).toEqual({ reply: 'via-send' });
    });

    it('spec-method form (no schema) uses method-keyed return', async () => {
        const { a, b } = await makePair();
        a.setRequestHandler('ping', () => ({}));
        let pingResult: unknown;
        b.setRequestHandler(z.object({ method: z.literal('acme/outer') }), async (_req, ctx) => {
            pingResult = await ctx.mcpReq.send({ method: 'ping' });
            return {};
        });
        await a.request({ method: 'acme/outer' }, z.object({}));
        expect(pingResult).toEqual({});
    });
});

describe('notification() mock-assignability', () => {
    it('single-signature notification() is assignable from a simple mock (compile-time check)', () => {
        const p = new TestProtocol();
        p.notification = async (_n: { method: string }) => {};
        expect(typeof p.notification).toBe('function');
    });
});
