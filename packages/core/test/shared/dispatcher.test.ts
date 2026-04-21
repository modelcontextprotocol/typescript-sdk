import { describe, expect, test } from 'vitest';
import { z } from 'zod/v4';

import { SdkError } from '../../src/errors/sdkErrors.js';
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
        expect((out[0]!.message as any).params.progress).toBe(0.5);
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
            seen.push(o.kind === 'notification' ? `n:${(o.message.params as any).data}` : 'response');
        }
        expect(seen).toEqual(['n:1', 'n:2', 'response']);
    });

    test('ctx.mcpReq.send throws by default with no env.send', async () => {
        const d = new Dispatcher();
        let caught: unknown;
        d.setRawRequestHandler('elicit', async (_r, ctx) => {
            try {
                await ctx.mcpReq.send({ method: 'elicitation/create', params: {} });
            } catch (e) {
                caught = e;
            }
            return {} as Result;
        });
        await collect(d.dispatch(req('elicit')));
        expect(caught).toBeInstanceOf(SdkError);
        expect((caught as Error).message).toMatch(/no peer channel/);
    });

    test('ctx.mcpReq.send delegates to env.send when provided', async () => {
        const d = new Dispatcher();
        let sent: unknown;
        d.setRawRequestHandler('ask', async (_r, ctx) => {
            const r = await ctx.mcpReq.send({ method: 'ping' });
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
        expect(sent).toEqual({ method: 'ping' });
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
        let seen: any;
        d.setRawRequestHandler('echo', async (_r, ctx) => {
            seen = { sessionId: ctx.sessionId, auth: ctx.http?.authInfo };
            return {} as Result;
        });
        await collect(d.dispatch(req('echo'), { sessionId: 's1', authInfo: { token: 't', clientId: 'c', scopes: [] } }));
        expect(seen.sessionId).toBe('s1');
        expect(seen.auth.token).toBe('t');
    });

    test('dispatchNotification routes to handler and ignores unknown', async () => {
        const d = new Dispatcher();
        let got: unknown;
        d.setNotificationHandler('notifications/initialized', n => {
            got = n.method;
        });
        await d.dispatchNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(got).toBe('notifications/initialized');
        await expect(d.dispatchNotification({ jsonrpc: '2.0', method: 'unknown/thing' } as any)).resolves.toBeUndefined();
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
});

describe('Dispatcher.setRequestHandler 3-arg (custom method + paramsSchema)', () => {
    test('parses params, strips _meta, types handler arg', async () => {
        const d = new Dispatcher();
        const schema = z.object({ q: z.string(), limit: z.number().optional() });
        d.setRequestHandler('acme/search', schema, async params => {
            return { hits: [params.q], limit: params.limit ?? 10 } as Result;
        });
        const r = (await d.dispatchToResponse(req('acme/search', { q: 'foo', _meta: { progressToken: 1 } }))) as JSONRPCResultResponse;
        expect(r.result).toEqual({ hits: ['foo'], limit: 10 });
    });

    test('schema validation failure becomes InvalidParams error response', async () => {
        const d = new Dispatcher();
        d.setRequestHandler('acme/search', z.object({ q: z.string() }), async () => ({}) as Result);
        const r = (await d.dispatchToResponse(req('acme/search', { q: 123 }))) as JSONRPCErrorResponse;
        expect(r.error.code).toBe(ProtocolErrorCode.InvalidParams);
        expect(r.error.message).toMatch(/Invalid params for acme\/search/);
    });
});

describe('Dispatcher.dispatchRaw (envelope-agnostic)', () => {
    test('yields result without JSON-RPC envelope', async () => {
        const d = new Dispatcher();
        d.setRawRequestHandler('greet', async r => ({ hello: (r.params as { name: string }).name }) as Result);
        const out = [];
        for await (const o of d.dispatchRaw('greet', { name: 'proto' })) out.push(o);
        expect(out).toEqual([{ kind: 'result', result: { hello: 'proto' } }]);
    });

    test('yields error without envelope', async () => {
        const d = new Dispatcher();
        d.setRawRequestHandler('boom', async () => {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad');
        });
        const out = [];
        for await (const o of d.dispatchRaw('boom', {})) out.push(o);
        expect(out).toEqual([{ kind: 'error', code: ProtocolErrorCode.InvalidParams, message: 'bad' }]);
    });

    test('yields notifications then result', async () => {
        const d = new Dispatcher();
        d.setRawRequestHandler('work', async (_r, ctx) => {
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 't', progress: 1 } });
            return { done: true } as Result;
        });
        const out = [];
        for await (const o of d.dispatchRaw('work', {})) out.push(o);
        expect(out[0]).toMatchObject({ kind: 'notification', method: 'notifications/progress' });
        expect(out[1]).toEqual({ kind: 'result', result: { done: true } });
    });
});
