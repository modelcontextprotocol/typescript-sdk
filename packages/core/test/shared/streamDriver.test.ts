import { describe, expect, test, vi } from 'vitest';

import { Dispatcher } from '../../src/shared/dispatcher.js';
import { StreamDriver } from '../../src/shared/streamDriver.js';
import type { JSONRPCMessage, Progress, Result } from '../../src/types/index.js';
import { ResultSchema } from '../../src/types/index.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';

function linkedDrivers(opts: { server?: Dispatcher; client?: Dispatcher } = {}) {
    const [cPipe, sPipe] = InMemoryTransport.createLinkedPair();
    const serverDisp = opts.server ?? new Dispatcher();
    const clientDisp = opts.client ?? new Dispatcher();
    const server = new StreamDriver(serverDisp, sPipe);
    const client = new StreamDriver(clientDisp, cPipe);
    return { server, client, serverDisp, clientDisp, cPipe, sPipe };
}

describe('StreamDriver', () => {
    test('correlates outbound request with inbound response', async () => {
        const { server, client, serverDisp } = linkedDrivers();
        serverDisp.setRequestHandler('ping', async () => ({}));
        await server.start();
        await client.start();
        const r = await client.request({ method: 'ping' }, ResultSchema);
        expect(r).toEqual({});
    });

    test('request rejects on JSON-RPC error response', async () => {
        const { server, client } = linkedDrivers();
        await server.start();
        await client.start();
        await expect(client.request({ method: 'tools/list' }, ResultSchema)).rejects.toThrow();
    });

    test('request times out and sends cancellation', async () => {
        vi.useFakeTimers();
        const { server, client, sPipe } = linkedDrivers();
        await server.start();
        await client.start();
        const sent: JSONRPCMessage[] = [];
        const orig = sPipe.onmessage!;
        sPipe.onmessage = m => {
            sent.push(m);
            // swallow: never respond
        };
        void orig;
        const p = client.request({ method: 'ping' }, ResultSchema, { timeout: 50 });
        vi.advanceTimersByTime(60);
        await expect(p).rejects.toThrow(/timed out/);
        expect(sent.some(m => 'method' in m && m.method === 'notifications/cancelled')).toBe(true);
        vi.useRealTimers();
    });

    test('progress callback invoked and resets timeout when configured', async () => {
        vi.useFakeTimers();
        const { server, client, serverDisp } = linkedDrivers();
        let resolveHandler!: () => void;
        serverDisp.setRawRequestHandler('work', (_r, ctx) => {
            void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: ctx.mcpReq.id, progress: 0.5 } });
            return new Promise(r => {
                resolveHandler = () => r({} as Result);
            });
        });
        await server.start();
        await client.start();
        const seen: Progress[] = [];
        const p = client.request({ method: 'work' as any }, ResultSchema, {
            timeout: 100,
            resetTimeoutOnProgress: true,
            onprogress: pr => seen.push(pr)
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.progress).toBe(0.5);
        await vi.advanceTimersByTimeAsync(80);
        resolveHandler();
        await vi.advanceTimersByTimeAsync(0);
        await expect(p).resolves.toEqual({});
        vi.useRealTimers();
    });

    test('outbound abort signal cancels request', async () => {
        const { server, client, serverDisp } = linkedDrivers();
        serverDisp.setRawRequestHandler('slow', () => new Promise(() => {}));
        await server.start();
        await client.start();
        const ac = new AbortController();
        const p = client.request({ method: 'slow' as any }, ResultSchema, { signal: ac.signal, timeout: 10_000 });
        ac.abort('user');
        await expect(p).rejects.toThrow();
    });

    test('inbound notifications/cancelled aborts the handler', async () => {
        const { server, client, serverDisp } = linkedDrivers();
        let aborted = false;
        serverDisp.setRawRequestHandler('slow', (_r, ctx) => {
            return new Promise<Result>(resolve => {
                ctx.mcpReq.signal.addEventListener('abort', () => {
                    aborted = true;
                    resolve({} as Result);
                });
            });
        });
        await server.start();
        await client.start();
        const ac = new AbortController();
        const p = client.request({ method: 'slow' as any }, ResultSchema, { signal: ac.signal, timeout: 10_000 });
        await new Promise(r => setTimeout(r, 0));
        ac.abort('stop');
        await p.catch(() => {});
        await new Promise(r => setTimeout(r, 0));
        expect(aborted).toBe(true);
    });

    test('handler notify flows over pipe and arrives at client dispatcher', async () => {
        const { server, client, serverDisp, clientDisp } = linkedDrivers();
        const got: unknown[] = [];
        clientDisp.setNotificationHandler('notifications/message', n => {
            got.push(n.params);
        });
        serverDisp.setRawRequestHandler('work', async (_r, ctx) => {
            await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: 'hi' } });
            return {} as Result;
        });
        await server.start();
        await client.start();
        await client.request({ method: 'work' as any }, ResultSchema);
        expect(got).toEqual([{ level: 'info', data: 'hi' }]);
    });

    test('close rejects pending outbound requests', async () => {
        const { server, client, serverDisp } = linkedDrivers();
        serverDisp.setRawRequestHandler('slow', () => new Promise(() => {}));
        await server.start();
        await client.start();
        const p = client.request({ method: 'slow' as any }, ResultSchema, { timeout: 10_000 });
        await client.close();
        await expect(p).rejects.toThrow(/Connection closed/);
    });

    test('close aborts in-flight inbound handlers', async () => {
        const { server, client, serverDisp } = linkedDrivers();
        let abortedReason: unknown;
        serverDisp.setRawRequestHandler('slow', (_r, ctx) => {
            return new Promise<Result>(() => {
                ctx.mcpReq.signal.addEventListener('abort', () => {
                    abortedReason = ctx.mcpReq.signal.reason;
                });
            });
        });
        await server.start();
        await client.start();
        client.request({ method: 'slow' as any }, ResultSchema, { timeout: 10_000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 0));
        await server.close();
        expect(abortedReason).toBeDefined();
    });

    test('debounced notifications coalesce within a tick', async () => {
        const [cPipe, sPipe] = InMemoryTransport.createLinkedPair();
        const driver = new StreamDriver(new Dispatcher(), cPipe, {
            debouncedNotificationMethods: ['notifications/tools/list_changed']
        });
        const seen: JSONRPCMessage[] = [];
        sPipe.onmessage = m => seen.push(m);
        await sPipe.start();
        await driver.start();
        void driver.notification({ method: 'notifications/tools/list_changed' });
        void driver.notification({ method: 'notifications/tools/list_changed' });
        void driver.notification({ method: 'notifications/tools/list_changed' });
        await new Promise(r => setTimeout(r, 0));
        expect(seen.filter(m => 'method' in m && m.method === 'notifications/tools/list_changed')).toHaveLength(1);
    });

    test('ctx.mcpReq.send round-trips back through the same driver pair', async () => {
        const { server, client, serverDisp, clientDisp } = linkedDrivers();
        let pinged = false;
        clientDisp.setRequestHandler('ping', async () => {
            pinged = true;
            return {};
        });
        let elicited: unknown;
        serverDisp.setRawRequestHandler('ask', async (_r, ctx) => {
            elicited = await ctx.mcpReq.send({ method: 'ping' });
            return {} as Result;
        });
        await server.start();
        await client.start();
        await client.request({ method: 'ask' as any }, ResultSchema);
        expect(pinged).toBe(true);
        expect(elicited).toEqual({});
    });

    test('onerror fires for response with unknown id', async () => {
        const [cPipe, sPipe] = InMemoryTransport.createLinkedPair();
        const driver = new StreamDriver(new Dispatcher(), cPipe);
        const errs: Error[] = [];
        driver.onerror = e => errs.push(e);
        await driver.start();
        await sPipe.start();
        await sPipe.send({ jsonrpc: '2.0', id: 999, result: {} });
        expect(errs[0]?.message).toMatch(/unknown message ID/);
    });

    test('concurrent requests get distinct ids and resolve independently', async () => {
        const { server, client, serverDisp } = linkedDrivers();
        serverDisp.setRawRequestHandler('echo', async r => ({ id: r.id }) as Result);
        await server.start();
        await client.start();
        const [a, b, c] = await Promise.all([
            client.request({ method: 'echo' as any }, ResultSchema),
            client.request({ method: 'echo' as any }, ResultSchema),
            client.request({ method: 'echo' as any }, ResultSchema)
        ]);
        expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    });
});
