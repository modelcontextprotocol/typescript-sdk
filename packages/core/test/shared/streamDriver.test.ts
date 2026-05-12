import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors.js';
import { Dispatcher } from '../../src/shared/dispatcher.js';
import { RAW_RESULT_SCHEMA, StreamDriver } from '../../src/shared/streamDriver.js';
import type { JSONRPCMessage, JSONRPCRequest, Result } from '../../src/types/index.js';
import { ProtocolError, ProtocolErrorCode } from '../../src/types/index.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';

async function tick(): Promise<void> {
    await new Promise(r => setTimeout(r, 0));
}

function pair(): {
    near: StreamDriver;
    farPipe: InMemoryTransport;
    farSent: JSONRPCMessage[];
    dispatcher: Dispatcher;
} {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const dispatcher = new Dispatcher();
    const near = new StreamDriver(dispatcher, a);
    const farSent: JSONRPCMessage[] = [];
    b.onmessage = m => farSent.push(m);
    return { near, farPipe: b, farSent, dispatcher };
}

describe('StreamDriver — outbound request/response correlation', () => {
    test('request() resolves when matching response arrives', async () => {
        const { near, farPipe, farSent } = pair();
        await near.start();
        await farPipe.start();

        const p = near.request({ method: 'ping' }, z.object({}));
        await tick();
        const sent = farSent[0] as JSONRPCRequest;
        expect(sent.method).toBe('ping');
        await farPipe.send({ jsonrpc: '2.0', id: sent.id, result: {} });
        await expect(p).resolves.toEqual({});
    });

    test('request() rejects with ProtocolError on JSON-RPC error response', async () => {
        const { near, farPipe, farSent } = pair();
        await near.start();
        await farPipe.start();

        const p = near.request({ method: 'ping' }, z.object({}));
        await tick();
        const sent = farSent[0] as JSONRPCRequest;
        await farPipe.send({ jsonrpc: '2.0', id: sent.id, error: { code: ProtocolErrorCode.InvalidParams, message: 'bad' } });
        await expect(p).rejects.toBeInstanceOf(ProtocolError);
    });

    test('request() times out and sends notifications/cancelled', async () => {
        const { near, farPipe, farSent } = pair();
        await near.start();
        await farPipe.start();

        const p = near.request({ method: 'ping' }, z.object({}), { timeout: 10 });
        await expect(p).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout });
        await tick();
        expect(farSent.some(m => 'method' in m && m.method === 'notifications/cancelled')).toBe(true);
    });

    test('caller signal abort rejects and sends notifications/cancelled', async () => {
        const { near, farPipe, farSent } = pair();
        await near.start();
        await farPipe.start();

        const ac = new AbortController();
        const p = near.request({ method: 'ping' }, z.object({}), { signal: ac.signal });
        await tick();
        ac.abort('stop');
        await expect(p).rejects.toBeInstanceOf(SdkError);
        await tick();
        expect(farSent.some(m => 'method' in m && m.method === 'notifications/cancelled')).toBe(true);
    });

    test('progress notification invokes onprogress and resetTimeoutOnProgress extends the timeout', async () => {
        const { near, farPipe, farSent } = pair();
        await near.start();
        await farPipe.start();

        const onprogress = vi.fn();
        const p = near.request({ method: 'ping' }, z.object({}), { onprogress, timeout: 50, resetTimeoutOnProgress: true });
        await tick();
        const sent = farSent[0] as JSONRPCRequest;
        const token = (sent.params as { _meta: { progressToken: number } })._meta.progressToken;
        await farPipe.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 0.5 } });
        await tick();
        expect(onprogress).toHaveBeenCalledWith({ progress: 0.5 });
        await farPipe.send({ jsonrpc: '2.0', id: sent.id, result: {} });
        await expect(p).resolves.toEqual({});
    });

    test('close rejects in-flight requests with ConnectionClosed', async () => {
        const { near, farPipe } = pair();
        await near.start();
        await farPipe.start();

        const p = near.request({ method: 'ping' }, z.object({}));
        await tick();
        await near.close();
        await expect(p).rejects.toMatchObject({ code: SdkErrorCode.ConnectionClosed });
    });
});

describe('StreamDriver — inbound dispatch', () => {
    test('inbound request is dispatched and response sent on the pipe', async () => {
        const { near, farPipe, farSent, dispatcher } = pair();
        dispatcher.setRequestHandler('ping', async () => ({}));
        await near.start();
        await farPipe.start();

        await farPipe.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
        await tick();
        const resp = farSent.find(m => 'id' in m && m.id === 7 && 'result' in m);
        expect(resp).toBeDefined();
    });

    test('inbound notification is routed to dispatchNotification', async () => {
        const { near, farPipe, dispatcher } = pair();
        let seen = false;
        dispatcher.setNotificationHandler('notifications/initialized', () => {
            seen = true;
        });
        await near.start();
        await farPipe.start();

        await farPipe.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await tick();
        expect(seen).toBe(true);
    });

    test('notifications/cancelled aborts the matching in-flight handler', async () => {
        const { near, farPipe, dispatcher } = pair();
        let aborted = false;
        dispatcher.setRawRequestHandler('slow', async (_r, ctx) => {
            await new Promise<void>(resolve =>
                ctx.mcpReq.signal.addEventListener('abort', () => {
                    aborted = true;
                    resolve();
                })
            );
            return {} as Result;
        });
        await near.start();
        await farPipe.start();

        await farPipe.send({ jsonrpc: '2.0', id: 9, method: 'slow' });
        await tick();
        await farPipe.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9, reason: 'x' } });
        await tick();
        expect(aborted).toBe(true);
    });

    test('handler ctx.mcpReq.send routes through driver.request with relatedRequestId', async () => {
        const { near, farPipe, farSent, dispatcher } = pair();
        dispatcher.setRawRequestHandler('outer', async (_r, ctx) => {
            const r = await ctx.mcpReq.send({ method: 'ping' });
            return { inner: r } as Result;
        });
        await near.start();
        await farPipe.start();

        await farPipe.send({ jsonrpc: '2.0', id: 1, method: 'outer' });
        await tick();
        const innerReq = farSent.find(m => 'method' in m && m.method === 'ping') as JSONRPCRequest;
        expect(innerReq).toBeDefined();
        await farPipe.send({ jsonrpc: '2.0', id: innerReq.id, result: {} });
        await tick();
        const outerResp = farSent.find(m => 'id' in m && m.id === 1 && 'result' in m);
        expect(outerResp).toMatchObject({ result: { inner: {} } });
    });
});

describe('StreamDriver — debounced notifications', () => {
    test('notifications in debouncedNotificationMethods coalesce within a tick', async () => {
        const [a, b] = InMemoryTransport.createLinkedPair();
        const driver = new StreamDriver(new Dispatcher(), a, { debouncedNotificationMethods: ['notifications/tools/list_changed'] });
        const farSent: JSONRPCMessage[] = [];
        b.onmessage = m => farSent.push(m);
        await driver.start();
        await b.start();

        void driver.notification({ method: 'notifications/tools/list_changed' });
        void driver.notification({ method: 'notifications/tools/list_changed' });
        void driver.notification({ method: 'notifications/tools/list_changed' });
        await tick();
        await tick();
        const sent = farSent.filter(m => 'method' in m && m.method === 'notifications/tools/list_changed');
        expect(sent).toHaveLength(1);
    });
});

describe('RAW_RESULT_SCHEMA', () => {
    test('passes any value through unchanged', async () => {
        const v = await RAW_RESULT_SCHEMA['~standard'].validate({ anything: 1 });
        expect('value' in v && v.value).toEqual({ anything: 1 });
    });
});
