import { describe, expect, expectTypeOf, test } from 'vitest';
import { z } from 'zod/v4';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors.js';
import type { DispatchOutput } from '../../src/shared/dispatcher.js';
import { Dispatcher } from '../../src/shared/dispatcher.js';
import type { JSONRPCErrorResponse, JSONRPCRequest, JSONRPCResultResponse, Result } from '../../src/types/index.js';
import { ProtocolError, ProtocolErrorCode } from '../../src/types/index.js';

const req = (method: string, params?: Record<string, unknown>, id = 1): JSONRPCRequest => ({ jsonrpc: '2.0', id, method, params });

async function collect(gen: AsyncIterable<DispatchOutput>): Promise<DispatchOutput[]> {
    const out: DispatchOutput[] = [];
    for await (const o of gen) out.push(o);
    return out;
}

describe('Dispatcher', () => {
    test('dispatch yields a single response for a registered handler', async () => {
        const d = new Dispatcher();
        d.setRequestHandler('ping', async () => ({}));
        const out = await collect(d.dispatch(req('ping')));
        expect(out).toHaveLength(1);
        expect(out[0]!.kind).toBe('response');
        expect((out[0]!.message as JSONRPCResultResponse).result).toEqual({});
    });

    test('dispatch yields MethodNotFound for an unregistered method', async () => {
        const d = new Dispatcher();
        const out = await collect(d.dispatch(req('tools/list')));
        expect(out).toHaveLength(1);
        const msg = out[0]!.message as JSONRPCErrorResponse;
        expect(msg.error.code).toBe(ProtocolErrorCode.MethodNotFound);
    });

    test('handler throw is wrapped as InternalError', async () => {
        const d = new Dispatcher();
        d.setRawRequestHandler('boom', async () => {
            throw new Error('kaboom');
        });
        const out = await collect(d.dispatch(req('boom')));
        const msg = out[0]!.message as JSONRPCErrorResponse;
        expect(msg.error.code).toBe(ProtocolErrorCode.InternalError);
        expect(msg.error.message).toBe('kaboom');
    });

    test('handler throwing ProtocolError preserves code and data', async () => {
        const d = new Dispatcher();
        d.setRawRequestHandler('boom', async () => {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad', { hint: 'x' });
        });
        const out = await collect(d.dispatch(req('boom')));
        const msg = out[0]!.message as JSONRPCErrorResponse;
        expect(msg.error.code).toBe(ProtocolErrorCode.InvalidParams);
        expect(msg.error.data).toEqual({ hint: 'x' });
    });

    test('ctx.mcpReq.notify yields notifications before the final response', async () => {
        const d = new Dispatcher();
        d.setRawRequestHandler('work', async (_r, ctx) => {
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 1, progress: 0.5 } });
            await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: 'hi' } });
            return { ok: true } as Result;
        });
        const out = await collect(d.dispatch(req('work')));
        expect(out.map(o => o.kind)).toEqual(['notification', 'notification', 'response']);
        const first = out[0]!;
        expect(first.kind === 'notification' && (first.message.params as { progress: number }).progress).toBe(0.5);
        expect((out[2]!.message as JSONRPCResultResponse).result).toEqual({ ok: true });
    });

    test('notifications interleave with async handler work', async () => {
        const d = new Dispatcher();
        d.setRawRequestHandler('work', async (_r, ctx) => {
            await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: '1' } });
            await new Promise(r => setTimeout(r, 1));
            await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: '2' } });
            return {} as Result;
        });
        const seen: string[] = [];
        for await (const o of d.dispatch(req('work'))) {
            seen.push(o.kind === 'notification' ? `n:${(o.message.params as { data: string }).data}` : 'response');
        }
        expect(seen).toEqual(['n:1', 'n:2', 'response']);
    });

    test('ctx.mcpReq.send with no env.send throws SdkError(NotConnected)', async () => {
        const d = new Dispatcher();
        let caught: unknown;
        d.setRawRequestHandler('elicit', async (_r, ctx) => {
            try {
                await ctx.mcpReq.send({ method: 'elicitation/create', params: {} });
            } catch (e) {
                caught = e;
                throw e;
            }
            return {} as Result;
        });
        const out = await collect(d.dispatch(req('elicit')));
        expect(caught).toBeInstanceOf(SdkError);
        expect((caught as SdkError).code).toBe(SdkErrorCode.NotConnected);
        const msg = out[0]!.message as JSONRPCErrorResponse;
        expect(msg.error.message).toMatch(/No outbound channel/);
    });

    test('ctx.mcpReq.send delegates to env.send and validates with the supplied result schema', async () => {
        const d = new Dispatcher();
        let sent: unknown;
        d.setRawRequestHandler('ask', async (_r, ctx) => {
            const r = await ctx.mcpReq.send({ method: 'acme/ping' }, z.object({ pong: z.boolean() }));
            return { got: r } as Result;
        });
        const out = await collect(
            d.dispatch(req('ask'), {
                send: async r => {
                    sent = r;
                    return { pong: true } as Result;
                }
            })
        );
        expect(sent).toEqual({ method: 'acme/ping' });
        expect((out[0]!.message as JSONRPCResultResponse).result).toEqual({ got: { pong: true } });
    });

    test('env.signal abort yields a cancelled error response', async () => {
        const d = new Dispatcher();
        const ac = new AbortController();
        d.setRawRequestHandler('slow', async (_r, ctx) => {
            if (ctx.mcpReq.signal.aborted) return {} as Result;
            await new Promise<void>(resolve => ctx.mcpReq.signal.addEventListener('abort', () => resolve(), { once: true }));
            return {} as Result;
        });
        const gen = d.dispatch(req('slow'), { signal: ac.signal });
        const p = collect(gen);
        await Promise.resolve();
        ac.abort('stop');
        const out = await p;
        const msg = out[out.length - 1]!.message as JSONRPCErrorResponse;
        expect(msg.error.message).toBe('Request cancelled');
    });

    test('env values surface on context', async () => {
        const d = new Dispatcher();
        let seen: { sid: unknown; auth: unknown; ext: unknown } | undefined;
        d.setRawRequestHandler('echo', async (_r, ctx) => {
            seen = { sid: ctx.sessionId, auth: ctx.http?.authInfo, ext: ctx.ext };
            return {} as Result;
        });
        await collect(
            d.dispatch(req('echo'), { sessionId: 's1', authInfo: { token: 't', clientId: 'c', scopes: [] }, ext: { mark: 'x' } })
        );
        expect(seen?.sid).toBe('s1');
        expect((seen?.auth as { token: string }).token).toBe('t');
        expect((seen?.ext as { mark: string }).mark).toBe('x');
    });

    test('dispatchNotification routes to handler and ignores unknown', async () => {
        const d = new Dispatcher();
        let got: unknown;
        d.setNotificationHandler('notifications/initialized', n => {
            got = n.method;
        });
        await d.dispatchNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(got).toBe('notifications/initialized');
        await expect(d.dispatchNotification({ jsonrpc: '2.0', method: 'unknown/thing' })).resolves.toBeUndefined();
    });

    test('fallbackRequestHandler is used when no specific handler matches', async () => {
        const d = new Dispatcher();
        d.fallbackRequestHandler = async r => ({ echoed: r.method }) as Result;
        const out = await collect(d.dispatch(req('whatever/method')));
        expect((out[0]!.message as JSONRPCResultResponse).result).toEqual({ echoed: 'whatever/method' });
    });

    test('assertCanSetRequestHandler throws on collision', () => {
        const d = new Dispatcher();
        d.setRequestHandler('ping', async () => ({}));
        expect(() => d.assertCanSetRequestHandler('ping')).toThrow(/already exists/);
    });

    test('setRequestHandler parses request via schema', async () => {
        const d = new Dispatcher();
        let parsed: unknown;
        d.setRequestHandler('ping', r => {
            parsed = r;
            return {};
        });
        await collect(d.dispatch(req('ping')));
        expect(parsed).toMatchObject({ method: 'ping' });
    });

    test('dispatchToResponse returns the terminal response', async () => {
        const d = new Dispatcher();
        d.setRawRequestHandler('x', async (_r, ctx) => {
            await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: 'n' } });
            return { v: 1 } as Result;
        });
        const r = (await d.dispatchToResponse(req('x'))) as JSONRPCResultResponse;
        expect(r.result).toEqual({ v: 1 });
    });

    test('options.buildContext enriches the context the handler receives', async () => {
        type ExtCtx = import('../../src/shared/protocol.js').BaseContext & { role: string };
        const d = new Dispatcher<ExtCtx>({ buildContext: (base, _env) => ({ ...base, role: 'server' }) });
        let role: string | undefined;
        d.setRawRequestHandler('echo', async (_r, ctx) => {
            role = ctx.role;
            return {} as Result;
        });
        await collect(d.dispatch(req('echo')));
        expect(role).toBe('server');
    });

    test('options.wrapHandler is applied to registered handlers', async () => {
        const calls: string[] = [];
        const d = new Dispatcher({
            wrapHandler: (method, h) => async (r, ctx) => {
                calls.push(method);
                return h(r, ctx);
            }
        });
        d.setRequestHandler('ping', async () => ({}));
        await collect(d.dispatch(req('ping')));
        expect(calls).toEqual(['ping']);
    });
});

describe('Dispatcher.use middleware composition', () => {
    test('middleware composes outermost-first and can transform output', async () => {
        const d = new Dispatcher();
        const order: string[] = [];
        d.use(
            next =>
                async function* (r, e) {
                    order.push('a-in');
                    yield* next(r, e);
                    order.push('a-out');
                }
        );
        d.use(
            next =>
                async function* (r, e) {
                    order.push('b-in');
                    yield* next(r, e);
                    order.push('b-out');
                }
        );
        d.setRawRequestHandler('x', async () => ({}) as Result);
        await collect(d.dispatch(req('x')));
        expect(order).toEqual(['a-in', 'b-in', 'b-out', 'a-out']);
    });

    test('middleware can short-circuit by yielding a response without calling next', async () => {
        const d = new Dispatcher();
        d.use(
            () =>
                async function* (r) {
                    yield { kind: 'response', message: { jsonrpc: '2.0', id: r.id, result: { mw: true } } };
                }
        );
        d.setRawRequestHandler('x', async () => ({ handler: true }) as Result);
        const r = (await d.dispatchToResponse(req('x'))) as JSONRPCResultResponse;
        expect(r.result).toEqual({ mw: true });
    });
});

describe('Dispatcher.setRequestHandler 3-arg (custom method + {params, result})', () => {
    test('parses params, strips _meta, types handler arg', async () => {
        const d = new Dispatcher();
        const params = z.object({ q: z.string(), limit: z.number().optional() });
        d.setRequestHandler('acme/search', { params }, async p => {
            return { hits: [p.q], limit: p.limit ?? 10 } as Result;
        });
        const r = (await d.dispatchToResponse(req('acme/search', { q: 'foo', _meta: { progressToken: 1 } }))) as JSONRPCResultResponse;
        expect(r.result).toEqual({ hits: ['foo'], limit: 10 });
    });

    test('schema validation failure becomes InvalidParams error response', async () => {
        const d = new Dispatcher();
        d.setRequestHandler('acme/search', { params: z.object({ q: z.string() }) }, async () => ({}) as Result);
        const r = (await d.dispatchToResponse(req('acme/search', { q: 123 }))) as JSONRPCErrorResponse;
        expect(r.error.code).toBe(ProtocolErrorCode.InvalidParams);
        expect(r.error.message).toMatch(/Invalid params for acme\/search/);
    });

    test('result schema types the handler return value', () => {
        const d = new Dispatcher();
        const params = z.object({ q: z.string() });
        const result = z.object({ hits: z.array(z.string()) });
        d.setRequestHandler('acme/search', { params, result }, async p => {
            expectTypeOf(p.q).toBeString();
            return { hits: [p.q] };
        });
        // @ts-expect-error -- result schema enforces shape
        d.setRequestHandler('acme/search', { params, result }, async () => ({ wrong: 1 }));
    });

    test('arbitrary string method accepted via 3-arg overload with loose Result', () => {
        const d = new Dispatcher();
        d.setRequestHandler('x/custom', { params: z.object({}) }, async () => ({ anything: 1 }) as Result);
        d.setRequestHandler('tools/list', { params: z.object({}) }, async () => ({ tools: [] }));
    });

    test('3-arg setNotificationHandler validates params and dispatches', async () => {
        const d = new Dispatcher();
        let seen: number | undefined;
        d.setNotificationHandler('ui/ping', { params: z.object({ ts: z.number() }) }, p => {
            expectTypeOf(p.ts).toBeNumber();
            seen = p.ts;
        });
        await d.dispatchNotification({ jsonrpc: '2.0', method: 'ui/ping', params: { ts: 42 } });
        expect(seen).toBe(42);
    });

    test('2-arg form rejects non-spec methods at runtime', () => {
        const d = new Dispatcher();
        const setReq = d.setRequestHandler.bind(d) as (m: string, h: () => Promise<Result>) => void;
        const setNotif = d.setNotificationHandler.bind(d) as (m: string, h: () => void) => void;
        expect(() => setReq('acme/search', async () => ({}))).toThrow(/not a spec request method/);
        expect(() => setNotif('acme/ping', () => {})).toThrow(/not a spec notification method/);
    });
});
