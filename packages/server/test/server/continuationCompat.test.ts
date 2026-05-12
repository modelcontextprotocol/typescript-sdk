import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IncompleteResult, JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, RequestEnv } from '@modelcontextprotocol/core';

import { ContinuationCompat } from '../../src/server/continuationCompat.js';
import type { ShttpCallbacks } from '../../src/server/shttpHandler.js';
import { shttpHandler } from '../../src/server/shttpHandler.js';

const ACCEPT_BOTH = 'application/json, text/event-stream';

function post(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: ACCEPT_BOTH, ...headers },
        body: JSON.stringify(body)
    });
}

async function readSSE(res: Response): Promise<JSONRPCMessage[]> {
    const text = await res.text();
    const out: JSONRPCMessage[] = [];
    for (const block of text.split('\n\n')) {
        const dataLine = block.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const payload = dataLine.slice('data: '.length);
        if (payload.trim() === '') continue;
        out.push(JSON.parse(payload));
    }
    return out;
}

function asIncomplete(msg: JSONRPCMessage): Required<IncompleteResult> {
    expect(msg).toMatchObject({ result: { resultType: 'incomplete' } });
    const r = (msg as JSONRPCMessage & { result?: unknown }).result;
    return r as Required<IncompleteResult>;
}

/**
 * Handler that calls `env.send` mid-dispatch and returns a result that includes the
 * answered content. Tracks how many times the body executed so the test can assert
 * the handler runs once across the suspend/resume.
 */
function suspendingServer(): { cb: ShttpCallbacks; bodyRuns: () => number } {
    let runs = 0;
    const cb: ShttpCallbacks = {
        async *onrequest(req: JSONRPCRequest, env?: RequestEnv): AsyncIterable<JSONRPCMessage> {
            runs++;
            const ask = (env?.send ??
                (async () => {
                    throw new Error('env.send not provided');
                })) as NonNullable<RequestEnv['send']>;
            const answer = await ask(
                { method: 'elicitation/create', params: { mode: 'form', message: 'units?', requestedSchema: { type: 'object' } } },
                undefined
            );
            yield {
                jsonrpc: '2.0',
                id: req.id,
                result: { content: [{ type: 'text', text: `got:${JSON.stringify(answer)}` }] }
            };
        }
    };
    return { cb, bodyRuns: () => runs };
}

describe('ContinuationCompat — suspend/resume via shttpHandler', () => {
    let continuations: ContinuationCompat;
    afterEach(() => {
        continuations?.close();
    });

    it('round 1 returns IncompleteResult; round 2 resumes and yields the final result without re-running the handler', async () => {
        continuations = new ContinuationCompat({ allowAnonymousSuspend: true });
        const { cb, bodyRuns } = suspendingServer();
        const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });

        const r1 = await handler(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'weather' } }));
        expect(r1.status).toBe(200);
        const m1 = (await r1.json()) as JSONRPCMessage;
        const inc = asIncomplete(m1);
        expect(Object.values(inc.inputRequests)).toHaveLength(1);
        const slot = Object.keys(inc.inputRequests)[0]!;
        expect(inc.inputRequests[slot]!.method).toBe('elicitation/create');
        expect(typeof inc.requestState).toBe('string');
        expect(continuations.size).toBe(1);
        expect(bodyRuns()).toBe(1);

        const r2 = await handler(
            post({
                jsonrpc: '2.0',
                id: 99,
                method: 'tools/call',
                params: {
                    name: 'weather',
                    requestState: inc.requestState,
                    inputResponses: { [slot]: { action: 'accept', content: { units: 'metric' } } }
                }
            })
        );
        const m2 = (await r2.json()) as JSONRPCMessage;
        expect(m2).toMatchObject({
            id: 99,
            result: { content: [{ type: 'text', text: expect.stringContaining('metric') }] }
        });
        expect(bodyRuns()).toBe(1);
        expect(continuations.size).toBe(0);
    });

    it('SSE mode: progress notifications before suspend reach round 1; final result reaches round 2', async () => {
        continuations = new ContinuationCompat({ allowAnonymousSuspend: true });
        let runs = 0;
        const cb: ShttpCallbacks = {
            async *onrequest(req: JSONRPCRequest, env?: RequestEnv): AsyncIterable<JSONRPCMessage> {
                runs++;
                yield { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 1 } };
                const r = await env!.send!({ method: 'elicitation/create', params: { mode: 'form', message: 'q?' } });
                yield { jsonrpc: '2.0', id: req.id, result: { ok: true, echoed: r } };
            }
        };
        const handler = shttpHandler(cb, { continuations });

        const r1 = await handler(post({ jsonrpc: '2.0', id: 1, method: 'x' }));
        const msgs1 = await readSSE(r1);
        expect(msgs1).toHaveLength(2);
        expect((msgs1[0] as JSONRPCNotification).method).toBe('notifications/progress');
        const inc = asIncomplete(msgs1[1]!);
        const slot = Object.keys(inc.inputRequests)[0]!;

        const r2 = await handler(
            post({
                jsonrpc: '2.0',
                id: 2,
                method: 'x',
                params: { requestState: inc.requestState, inputResponses: { [slot]: { v: 7 } } }
            })
        );
        const msgs2 = await readSSE(r2);
        expect(msgs2).toHaveLength(1);
        expect(msgs2[0]).toMatchObject({ id: 2, result: { ok: true, echoed: { v: 7 } } });
        expect(runs).toBe(1);
    });

    it('batches concurrent env.send calls into one IncompleteResult and resumes both', async () => {
        continuations = new ContinuationCompat({ allowAnonymousSuspend: true });
        const cb: ShttpCallbacks = {
            async *onrequest(req: JSONRPCRequest, env?: RequestEnv): AsyncIterable<JSONRPCMessage> {
                const [a, b] = await Promise.all([
                    env!.send!({ method: 'elicitation/create', params: { mode: 'form', message: 'a' } }),
                    env!.send!({ method: 'sampling/createMessage', params: { messages: [] } })
                ]);
                yield { jsonrpc: '2.0', id: req.id, result: { a, b } };
            }
        };
        const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });

        const r1 = await handler(post({ jsonrpc: '2.0', id: 1, method: 'x' }));
        const inc = asIncomplete((await r1.json()) as JSONRPCMessage);
        const keys = Object.keys(inc.inputRequests);
        expect(keys).toHaveLength(2);
        const methods = keys.map(k => inc.inputRequests[k]!.method).sort();
        expect(methods).toEqual(['elicitation/create', 'sampling/createMessage']);

        const r2 = await handler(
            post({
                jsonrpc: '2.0',
                id: 2,
                method: 'x',
                params: {
                    requestState: inc.requestState,
                    inputResponses: { [keys[0]!]: { tag: 'A' }, [keys[1]!]: { tag: 'B' } }
                }
            })
        );
        const m2 = (await r2.json()) as JSONRPCMessage;
        expect(m2).toMatchObject({ id: 2, result: { a: { tag: 'A' }, b: { tag: 'B' } } });
    });

    it('rejects resume from a different authenticated principal', async () => {
        continuations = new ContinuationCompat({ allowAnonymousSuspend: true });
        const { cb } = suspendingServer();
        const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });

        const auth = (token: string) => ({ authInfo: { token, clientId: 'c', scopes: [] } });

        const r1 = await handler(post({ jsonrpc: '2.0', id: 1, method: 'x' }), auth('alice-token'));
        const inc = asIncomplete((await r1.json()) as JSONRPCMessage);
        const slot = Object.keys(inc.inputRequests)[0]!;

        const evil = await handler(
            post({
                jsonrpc: '2.0',
                id: 2,
                method: 'x',
                params: { requestState: inc.requestState, inputResponses: { [slot]: { stolen: true } } }
            }),
            auth('mallory-token')
        );
        expect((await evil.json()) as JSONRPCMessage).toMatchObject({
            id: 2,
            error: { code: -32_600, message: expect.stringContaining('does not belong') }
        });
        expect(continuations.size).toBe(1);

        const ok = await handler(
            post({
                jsonrpc: '2.0',
                id: 3,
                method: 'x',
                params: { requestState: inc.requestState, inputResponses: { [slot]: { units: 'metric' } } }
            }),
            auth('alice-token')
        );
        expect((await ok.json()) as JSONRPCMessage).toMatchObject({ id: 3, result: {} });
        expect(continuations.size).toBe(0);
    });

    it('returns -32600 when requestState is unknown/expired', async () => {
        continuations = new ContinuationCompat({ allowAnonymousSuspend: true });
        const { cb } = suspendingServer();
        const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });
        const r = await handler(post({ jsonrpc: '2.0', id: 1, method: 'x', params: { requestState: 'nope', inputResponses: {} } }));
        const m = (await r.json()) as JSONRPCMessage;
        expect(m).toMatchObject({ id: 1, error: { code: -32_600 } });
    });

    it('inputResponses missing the requested slot rejects the parked env.send', async () => {
        continuations = new ContinuationCompat({ allowAnonymousSuspend: true });
        const cb: ShttpCallbacks = {
            async *onrequest(req: JSONRPCRequest, env?: RequestEnv): AsyncIterable<JSONRPCMessage> {
                try {
                    await env!.send!({ method: 'elicitation/create' });
                    yield { jsonrpc: '2.0', id: req.id, result: { reached: 'nope' } };
                } catch (error) {
                    yield {
                        jsonrpc: '2.0',
                        id: req.id,
                        result: { isError: true, content: [{ type: 'text', text: (error as Error).message }] }
                    };
                }
            }
        };
        const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });
        const r1 = await handler(post({ jsonrpc: '2.0', id: 1, method: 'x' }));
        const inc = asIncomplete((await r1.json()) as JSONRPCMessage);
        const slot = Object.keys(inc.inputRequests)[0]!;

        const r2 = await handler(
            post({
                jsonrpc: '2.0',
                id: 2,
                method: 'x',
                params: { requestState: inc.requestState, inputResponses: { wrongKey: {} } }
            })
        );
        const m2 = (await r2.json()) as JSONRPCMessage;
        expect(m2).toMatchObject({
            id: 2,
            result: { isError: true, content: [{ type: 'text', text: expect.stringContaining(`slot "${slot}"`) }] }
        });
    });

    it('rejects a second concurrent resume for the same requestState while the first is draining', async () => {
        continuations = new ContinuationCompat({ allowAnonymousSuspend: true });
        const cb: ShttpCallbacks = {
            async *onrequest(req: JSONRPCRequest, env?: RequestEnv): AsyncIterable<JSONRPCMessage> {
                const a = await env!.send!({ method: 'elicitation/create' });
                // Second suspension point so the first resume is still draining when the
                // duplicate arrives.
                const b = await env!.send!({ method: 'elicitation/create' });
                yield { jsonrpc: '2.0', id: req.id, result: { a, b } };
            }
        };
        const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });

        const r1 = await handler(post({ jsonrpc: '2.0', id: 1, method: 'x' }));
        const inc = asIncomplete((await r1.json()) as JSONRPCMessage);
        const slot = Object.keys(inc.inputRequests)[0]!;

        const resume = (id: number) =>
            handler(
                post({
                    jsonrpc: '2.0',
                    id,
                    method: 'x',
                    params: { requestState: inc.requestState, inputResponses: { [slot]: { v: id } } }
                })
            );

        const [first, dup] = await Promise.all([resume(10), resume(11)]);
        const mFirst = (await first.json()) as JSONRPCMessage;
        const mDup = (await dup.json()) as JSONRPCMessage;
        // First resume parks again at the second send (round 2's IncompleteResult).
        expect(mFirst).toMatchObject({ id: 10, result: { resultType: 'incomplete' } });
        // Concurrent duplicate is rejected, not silently merged or duplicated.
        expect(mDup).toMatchObject({ id: 11, error: { code: -32_600, message: expect.stringContaining('already in progress') } });
        expect(continuations.size).toBe(1);
    });

    describe('TTL eviction', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('expires a parked frame after ttlMs and rejects later resume', async () => {
            const expired: string[] = [];
            continuations = new ContinuationCompat({ ttlMs: 1000, onexpired: t => expired.push(t), allowAnonymousSuspend: true });
            const { cb } = suspendingServer();
            const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });

            const r1 = await handler(post({ jsonrpc: '2.0', id: 1, method: 'x' }));
            const inc = asIncomplete((await r1.json()) as JSONRPCMessage);
            expect(continuations.size).toBe(1);

            vi.advanceTimersByTime(1001);
            expect(continuations.size).toBe(0);
            expect(expired).toEqual([inc.requestState]);

            const r2 = await handler(
                post({
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'x',
                    params: { requestState: inc.requestState, inputResponses: { r0: {} } }
                })
            );
            const m2 = (await r2.json()) as JSONRPCMessage;
            expect(m2).toMatchObject({ id: 2, error: { code: -32_600 } });
        });
    });

    it('refuses to suspend without a principal by default', async () => {
        continuations = new ContinuationCompat();
        const { cb } = suspendingServer();
        const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });
        const r = await handler(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't' } }));
        expect(r.status).toBe(500);
        expect(continuations.size).toBe(0);
    });

    it('rejects new suspension when principal is at perPrincipalMax', async () => {
        continuations = new ContinuationCompat({ perPrincipalMax: 2 });
        const auth = (token: string) => ({ authInfo: { token, clientId: 'c', scopes: [] } });
        const { cb } = suspendingServer();
        const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });
        await handler(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't' } }), auth('alice'));
        await handler(post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't' } }), auth('alice'));
        const r3 = await handler(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 't' } }), auth('alice'));
        expect(r3.status).toBe(500);
        // bob is unaffected
        const rb = await handler(post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 't' } }), auth('bob'));
        expect(rb.status).toBe(200);
        expect(continuations.size).toBe(3);
    });

    it('handler that never calls env.send passes through unchanged', async () => {
        continuations = new ContinuationCompat({ allowAnonymousSuspend: true });
        const cb: ShttpCallbacks = {
            async *onrequest(req: JSONRPCRequest): AsyncIterable<JSONRPCMessage> {
                yield { jsonrpc: '2.0', id: req.id, result: { ok: true } };
            }
        };
        const handler = shttpHandler(cb, { continuations, enableJsonResponse: true });
        const r = await handler(post({ jsonrpc: '2.0', id: 5, method: 'ping' }));
        expect(await r.json()).toMatchObject({ id: 5, result: { ok: true } });
        expect(continuations.size).toBe(0);
    });
});
