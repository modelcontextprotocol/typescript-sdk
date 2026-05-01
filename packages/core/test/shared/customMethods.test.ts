import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { Protocol } from '../../src/shared/protocol.js';
import type { BaseContext, JSONRPCRequest, Result, StandardSchemaV1 } from '../../src/exports/public/index.js';
import { ProtocolError } from '../../src/types/index.js';
import { SdkErrorCode } from '../../src/errors/sdkErrors.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';

class TestProtocol extends Protocol<BaseContext> {
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected assertTaskCapability(): void {}
    protected assertTaskHandlerCapability(): void {}
}

async function pair(): Promise<[TestProtocol, TestProtocol]> {
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const a = new TestProtocol();
    const b = new TestProtocol();
    await a.connect(t1);
    await b.connect(t2);
    return [a, b];
}

describe('Protocol custom-method support', () => {
    describe('setRequestHandler 3-arg form', () => {
        const SearchParams = z.object({ query: z.string(), limit: z.number().int() });
        const SearchResult = z.object({ items: z.array(z.string()) });

        it('registers, validates params, and handler receives parsed params', async () => {
            const [a, b] = await pair();
            b.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, _ctx) => {
                expect(params.query).toBe('hello');
                expect(params.limit).toBe(5);
                return { items: [`result for ${params.query}`] };
            });

            const result = await a.request({ method: 'acme/search', params: { query: 'hello', limit: 5 } }, SearchResult);
            expect(result.items).toEqual(['result for hello']);
        });

        it('strips _meta from params before validation', async () => {
            const [a, b] = await pair();
            const Strict = z.strictObject({ x: z.number() });
            b.setRequestHandler('acme/strict', { params: Strict }, async params => {
                expect(params).toEqual({ x: 1 });
                return {};
            });

            const result = await a.request({ method: 'acme/strict', params: { x: 1, _meta: { progressToken: 't' } } }, z.object({}));
            expect(result).toEqual({});
        });

        it('rejects invalid params with ProtocolError(InvalidParams)', async () => {
            const [a, b] = await pair();
            b.setRequestHandler('acme/search', { params: SearchParams }, async () => ({}));

            await expect(a.request({ method: 'acme/search', params: { query: 'q', limit: 'oops' } }, z.object({}))).rejects.toThrow(
                ProtocolError
            );
        });

        it('types handler return from schemas.result', () => {
            const p = new TestProtocol();
            p.setRequestHandler('acme/typed', { params: z.object({}), result: SearchResult }, async () => {
                return { items: [] };
            });
            // @ts-expect-error wrong return shape when result schema supplied
            p.setRequestHandler('acme/typed', { params: z.object({}), result: SearchResult }, async () => ({}));
            // No result schema → handler may return any Result
            p.setRequestHandler('acme/loose', { params: z.object({}) }, async () => ({}) as Result);
        });

        it('throws TypeError when 2-arg form is used with a non-spec method', () => {
            const p = new TestProtocol();
            expect(() => p.setRequestHandler('acme/unknown' as never, () => ({}) as never)).toThrow(TypeError);
        });

        it('routes both 2-arg and 3-arg registration through _wrapHandler', () => {
            const seen: string[] = [];
            class SpyProtocol extends TestProtocol {
                protected override _wrapHandler(
                    method: string,
                    handler: (request: JSONRPCRequest, ctx: BaseContext) => Promise<Result>
                ): (request: JSONRPCRequest, ctx: BaseContext) => Promise<Result> {
                    seen.push(method);
                    return handler;
                }
            }
            const p = new SpyProtocol();
            p.setRequestHandler('tools/list', () => ({ tools: [] }));
            p.setRequestHandler('acme/custom', { params: z.object({}) }, () => ({}));
            expect(seen).toContain('tools/list');
            expect(seen).toContain('acme/custom');
        });
    });

    describe('setNotificationHandler 3-arg form', () => {
        it('registers, validates params, handler receives parsed params', async () => {
            const [a, b] = await pair();
            const Progress = z.object({ stage: z.string(), pct: z.number() });
            const seen: Array<z.infer<typeof Progress>> = [];
            b.setNotificationHandler('acme/searchProgress', { params: Progress }, params => {
                seen.push(params);
            });

            await a.notification({ method: 'acme/searchProgress', params: { stage: 'fetch', pct: 0.5 } });
            await new Promise(r => setTimeout(r, 0));
            expect(seen).toEqual([{ stage: 'fetch', pct: 0.5 }]);
        });

        it('passes the raw notification (with _meta) as the second handler argument', async () => {
            const [a, b] = await pair();
            const Strict = z.strictObject({ stage: z.string() });
            let seenMeta: unknown;
            b.setNotificationHandler('acme/searchProgress', { params: Strict }, (params, notification) => {
                expect(params).toEqual({ stage: 'fetch' });
                seenMeta = notification.params?._meta;
            });

            await a.notification({ method: 'acme/searchProgress', params: { stage: 'fetch', _meta: { traceId: 't1' } } });
            await new Promise(r => setTimeout(r, 0));
            expect(seenMeta).toEqual({ traceId: 't1' });
        });
    });

    describe('request() schema overload', () => {
        it('validates result against provided schema and types the return', async () => {
            const [a, b] = await pair();
            b.setRequestHandler('acme/echo', { params: z.object({ v: z.string() }) }, async params => ({ echoed: params.v }));

            const result = await a.request({ method: 'acme/echo', params: { v: 'x' } }, z.object({ echoed: z.string() }));
            expect(result.echoed).toBe('x');
        });

        it('throws TypeError when 1-arg form is used with a non-spec method', async () => {
            const [a] = await pair();
            expect(() => a.request({ method: 'acme/unknown' } as never)).toThrow(TypeError);
        });

        it('rejects with SdkError(InvalidResult) when the response fails the result schema', async () => {
            const [a, b] = await pair();
            b.setRequestHandler('acme/bad', { params: z.object({}) }, async () => ({ wrong: 123 }));

            await expect(a.request({ method: 'acme/bad', params: {} }, z.object({ echoed: z.string() }))).rejects.toMatchObject({
                code: SdkErrorCode.InvalidResult
            });
        });

        it('returns the result (and sends no cancellation) if the signal aborts during async result-schema validation', async () => {
            const [a, b] = await pair();
            b.setRequestHandler('acme/echo', { params: z.object({}) }, async () => ({ echoed: 'ok' }));

            const cancelled: unknown[] = [];
            b.setNotificationHandler('notifications/cancelled', n => {
                cancelled.push(n);
            });

            const ac = new AbortController();
            const AsyncEcho: StandardSchemaV1<unknown, { echoed: string }> = {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate: value =>
                        new Promise(r => {
                            ac.abort();
                            setTimeout(() => r({ value: value as { echoed: string } }), 0);
                        })
                }
            };

            const result = await a.request({ method: 'acme/echo', params: {} }, AsyncEcho, { signal: ac.signal });
            expect(result).toEqual({ echoed: 'ok' });
            await new Promise(r => setTimeout(r, 0));
            expect(cancelled).toHaveLength(0);
        });
    });

    describe('ctx.mcpReq.send schema overload', () => {
        it('sends a related custom-method request from within a handler', async () => {
            const [a, b] = await pair();
            const Pong = z.object({ pong: z.literal(true) });

            a.setRequestHandler('acme/pong', { params: z.object({}) }, async () => ({ pong: true as const }));
            b.setRequestHandler('acme/ping', { params: z.object({}) }, async (_params, ctx) => {
                const r = await ctx.mcpReq.send({ method: 'acme/pong', params: {} }, Pong);
                expect(r.pong).toBe(true);
                return { ok: true };
            });

            const result = await a.request({ method: 'acme/ping', params: {} }, z.object({ ok: z.boolean() }));
            expect(result.ok).toBe(true);
        });
    });
});
