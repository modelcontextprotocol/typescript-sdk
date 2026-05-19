import { describe, expect, it } from 'vitest';

import { Dispatcher, errorResponse, type Middleware, okResponse } from '../../src/shared/dispatcher.js';
import { ProtocolErrorCode } from '../../src/types/enums.js';
import { ProtocolError } from '../../src/types/errors.js';
import type { JSONRPCRequest, Result } from '../../src/types/index.js';

type Ctx = { tag: string };

function req(method: string, id = 1): JSONRPCRequest {
    return { jsonrpc: '2.0', id, method };
}

// Test helper: register a raw handler directly (bypasses schema-wrap).
// Dispatcher's public registration is setRequestHandler (schema-wrapped); these
// unit tests target dispatch/middleware mechanics, not the schema layer.
function setRaw<C>(d: Dispatcher<C>, method: string, handler: (r: JSONRPCRequest, ctx: C) => Promise<Result>): void {
    (d as unknown as { _handlers: Map<string, typeof handler> })._handlers.set(method, handler);
}

describe('Dispatcher', () => {
    it('dispatches to a registered handler and wraps the result', async () => {
        const d = new Dispatcher<Ctx>();
        setRaw(d, 'foo', async (r, ctx) => ({ value: `${ctx.tag}:${r.method}` }));
        const res = await d.dispatch(req('foo'), { tag: 't' });
        expect(res).toEqual(okResponse(1, { value: 't:foo' }));
    });

    it('returns MethodNotFound when no handler matches', async () => {
        const d = new Dispatcher<Ctx>();
        const res = await d.dispatch(req('nope'), { tag: 't' });
        expect(res).toEqual(errorResponse(1, ProtocolErrorCode.MethodNotFound, 'Method not found'));
    });

    it('falls back to fallbackHandler when set', async () => {
        const d = new Dispatcher<Ctx>();
        d.fallbackHandler = async r => ({ fallback: r.method });
        const res = await d.dispatch(req('nope'), { tag: 't' });
        expect(res).toEqual(okResponse(1, { fallback: 'nope' }));
    });

    it('assertCanSetRequestHandler reflects registration only (not fallback)', () => {
        const d = new Dispatcher<Ctx>();
        d.fallbackHandler = async () => ({});
        expect(() => d.assertCanSetRequestHandler('foo')).not.toThrow();
        setRaw(d, 'foo', async () => ({}));
        expect(() => d.assertCanSetRequestHandler('foo')).toThrow();
        d.removeRequestHandler('foo');
        expect(() => d.assertCanSetRequestHandler('foo')).not.toThrow();
    });

    it('fallbackHandler bypasses middleware (preserves Protocol._onrequest behavior)', async () => {
        const d = new Dispatcher<Ctx>();
        let mwRan = false;
        d.use(async (_r, _c, next) => {
            mwRan = true;
            return next();
        });
        d.fallbackHandler = async r => ({ fallback: r.method });
        const res = await d.dispatch(req('nope'), { tag: 't' });
        expect(res).toEqual(okResponse(1, { fallback: 'nope' }));
        expect(mwRan).toBe(false);
    });

    it('surfaces ProtocolError code/message/data', async () => {
        const d = new Dispatcher<Ctx>();
        setRaw(d, 'foo', async () => {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad', { detail: 1 });
        });
        const res = await d.dispatch(req('foo'), { tag: 't' });
        expect(res).toEqual(errorResponse(1, ProtocolErrorCode.InvalidParams, 'bad', { detail: 1 }));
    });

    it('preserves thrown error message and numeric code (matches Protocol._onrequest behavior)', async () => {
        const d = new Dispatcher<Ctx>();
        setRaw(d, 'foo', async () => {
            throw new Error('handler error message');
        });
        const res = await d.dispatch(req('foo'), { tag: 't' });
        expect(res).toEqual(errorResponse(1, ProtocolErrorCode.InternalError, 'handler error message'));

        setRaw(d, 'coded', async () => {
            throw Object.assign(new Error('coded message'), { code: -31999, data: { x: 1 } });
        });
        const res2 = await d.dispatch(req('coded'), { tag: 't' });
        expect(res2).toEqual(errorResponse(1, -31999, 'coded message', { x: 1 }));
    });

    it('runs middleware in registration order around the handler', async () => {
        const d = new Dispatcher<Ctx>();
        const order: string[] = [];
        const mk =
            (name: string): Middleware<Ctx> =>
            async (_r, _c, next) => {
                order.push(`${name}:pre`);
                const result = await next();
                order.push(`${name}:post`);
                return result;
            };
        d.use(mk('a'));
        d.use(mk('b'));
        setRaw(d, 'foo', async () => {
            order.push('handler');
            return {};
        });
        await d.dispatch(req('foo'), { tag: 't' });
        expect(order).toEqual(['a:pre', 'b:pre', 'handler', 'b:post', 'a:post']);
    });

    it('lets middleware short-circuit without calling next', async () => {
        const d = new Dispatcher<Ctx>();
        let handlerRan = false;
        d.use(async () => ({ short: true }));
        setRaw(d, 'foo', async () => {
            handlerRan = true;
            return {};
        });
        const res = await d.dispatch(req('foo'), { tag: 't' });
        expect(res).toEqual(okResponse(1, { short: true }));
        expect(handlerRan).toBe(false);
    });

    it('lets middleware transform a thrown error into a result', async () => {
        const d = new Dispatcher<Ctx>();
        d.use(async (_r, _c, next) => {
            try {
                return await next();
            } catch {
                return { recovered: true };
            }
        });
        setRaw(d, 'foo', async () => {
            throw new Error('boom');
        });
        const res = await d.dispatch(req('foo'), { tag: 't' });
        expect(res).toEqual(okResponse(1, { recovered: true }));
    });

    it('does not run middleware when no handler matches', async () => {
        const d = new Dispatcher<Ctx>();
        let ran = false;
        d.use(async (_r, _c, next) => {
            ran = true;
            return next();
        });
        await d.dispatch(req('nope'), { tag: 't' });
        expect(ran).toBe(false);
    });

    it('supports concurrent dispatch on a shared instance', async () => {
        const d = new Dispatcher<Ctx>();
        setRaw(d, 'foo', async (_r, ctx) => {
            await new Promise(r => setTimeout(r, 5));
            return { tag: ctx.tag };
        });
        const results = await Promise.all([
            d.dispatch(req('foo', 1), { tag: 'a' }),
            d.dispatch(req('foo', 2), { tag: 'b' }),
            d.dispatch(req('foo', 3), { tag: 'c' })
        ]);
        expect(results.map(r => 'result' in r && (r.result as Result & { tag: string }).tag)).toEqual(['a', 'b', 'c']);
    });
});
