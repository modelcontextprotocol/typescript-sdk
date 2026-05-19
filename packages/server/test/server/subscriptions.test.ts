import type { JSONRPCMessage, ServerCapabilities, SubscriptionsListenRequest } from '@modelcontextprotocol/core';
import { JSONRPC_VERSION, META_KEYS } from '@modelcontextprotocol/core';

import { InMemorySubscriptions } from '../../src/server/subscriptions.js';

const caps: ServerCapabilities = {
    tools: { listChanged: true },
    prompts: { listChanged: true },
    resources: { listChanged: true, subscribe: true }
};

function listenReq(filter: SubscriptionsListenRequest['params']['notifications'], id = 1): SubscriptionsListenRequest & { id: number } {
    return {
        jsonrpc: JSONRPC_VERSION,
        id,
        method: 'subscriptions/listen',
        params: { notifications: filter }
    } as SubscriptionsListenRequest & { id: number };
}

/** Reads `n` messages without closing the stream (no `for await...break`). */
function reader(stream: AsyncIterable<JSONRPCMessage>): (n: number) => Promise<JSONRPCMessage[]> {
    const it = stream[Symbol.asyncIterator]();
    return async n => {
        const out: JSONRPCMessage[] = [];
        for (let i = 0; i < n; i++) {
            const r = await it.next();
            if (r.done) break;
            out.push(r.value);
        }
        return out;
    };
}

describe('InMemorySubscriptions', () => {
    it('first event is acknowledged with subscriptionId == request id (SEP-2575)', async () => {
        const subs = new InMemorySubscriptions();
        const { stream, close } = subs.handle(listenReq({ toolsListChanged: true }, 42), {}, caps);
        const [ack] = await reader(stream)(1);
        expect(ack).toMatchObject({ method: 'notifications/subscriptions/acknowledged' });
        const sid = (ack as { params: { _meta: Record<string, string> } }).params._meta[META_KEYS.subscriptionId];
        expect(sid).toBe('42');
        close();
    });

    it('ack reflects the intersection of requested and server capabilities', async () => {
        const subs = new InMemorySubscriptions();
        const { stream, close } = subs.handle(
            listenReq({ toolsListChanged: true, promptsListChanged: true }),
            {},
            { tools: { listChanged: true } }
        );
        const [ack] = await reader(stream)(1);
        expect((ack as unknown as { params: { notifications: unknown } }).params.notifications).toEqual({ toolsListChanged: true });
        close();
    });

    it('notify routes only to listeners whose filter matches', async () => {
        const subs = new InMemorySubscriptions();
        const a = subs.handle(listenReq({ toolsListChanged: true }), {}, caps);
        const b = subs.handle(listenReq({ promptsListChanged: true }), {}, caps);
        const readA = reader(a.stream);
        const readB = reader(b.stream);
        await readA(1);
        await readB(1);
        subs.notify({ type: 'toolsListChanged' });
        const [aMsg] = await readA(1);
        expect(aMsg).toMatchObject({ method: 'notifications/tools/list_changed' });
        subs.notify({ type: 'promptsListChanged' });
        const [bMsg] = await readB(1);
        expect(bMsg).toMatchObject({ method: 'notifications/prompts/list_changed' });
        a.close();
        b.close();
    });

    it('resourceSubscriptions are denied without an authorization hook (fail-closed)', async () => {
        const subs = new InMemorySubscriptions();
        const { stream, close } = subs.handle(listenReq({ resourceSubscriptions: ['file:///a'] }), {}, caps);
        const [ack] = await reader(stream)(1);
        expect((ack as unknown as { params: { notifications: unknown } }).params.notifications).toEqual({});
        close();
    });

    it('resourceSubscriptions are filtered through onAuthorizeResourceSubscription', async () => {
        const subs = new InMemorySubscriptions();
        const { stream, close } = subs.handle(
            listenReq({ resourceSubscriptions: ['file:///a', 'file:///b'] }),
            { onAuthorizeResourceSubscription: uri => uri === 'file:///a' },
            caps
        );
        const read = reader(stream);
        const [ack] = await read(1);
        expect((ack as unknown as { params: { notifications: unknown } }).params.notifications).toEqual({
            resourceSubscriptions: ['file:///a']
        });
        subs.notify({ type: 'resourceUpdated', uri: 'file:///b' });
        subs.notify({ type: 'resourceUpdated', uri: 'file:///a' });
        const [evt] = await read(1);
        expect(evt).toMatchObject({ method: 'notifications/resources/updated', params: { uri: 'file:///a' } });
        close();
    });

    it('threads ctx.authInfo to onAuthorizeResourceSubscription', async () => {
        const subs = new InMemorySubscriptions();
        let seen: unknown;
        const { close } = subs.handle(
            listenReq({ resourceSubscriptions: ['file:///a'] }),
            {
                authInfo: { token: 't', clientId: 'c', scopes: [] },
                onAuthorizeResourceSubscription: (_, c) => {
                    seen = c.authInfo;
                    return true;
                }
            },
            caps
        );
        expect(seen).toMatchObject({ token: 't' });
        close();
    });

    it('close ends the stream and is idempotent', async () => {
        const subs = new InMemorySubscriptions();
        const { stream, close } = subs.handle(listenReq({ toolsListChanged: true }), {}, caps);
        const read = reader(stream);
        await read(1);
        close();
        close();
        await expect(read(1)).resolves.toEqual([]);
    });

    it('close drops the registration so notify after close is a no-op', async () => {
        const subs = new InMemorySubscriptions();
        const { stream, close } = subs.handle(listenReq({ toolsListChanged: true }), {}, caps);
        await reader(stream)(1);
        close();
        expect(() => subs.notify({ type: 'toolsListChanged' })).not.toThrow();
    });

    it('iterator return() ends the stream (early break)', async () => {
        const subs = new InMemorySubscriptions();
        const { stream } = subs.handle(listenReq({ toolsListChanged: true }), {}, caps);
        for await (const _ of stream) {
            break;
        }
        const it = stream[Symbol.asyncIterator]();
        await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
    });

    it('queues events delivered before next() is called', async () => {
        const subs = new InMemorySubscriptions();
        const { stream, close } = subs.handle(listenReq({ toolsListChanged: true }), {}, caps);
        subs.notify({ type: 'toolsListChanged' });
        subs.notify({ type: 'toolsListChanged' });
        const got = await reader(stream)(3);
        expect(got.map(m => (m as { method: string }).method)).toEqual([
            'notifications/subscriptions/acknowledged',
            'notifications/tools/list_changed',
            'notifications/tools/list_changed'
        ]);
        close();
    });

    it('concurrent listeners with the same JSON-RPC id each receive events (internal map keyed by UUID)', async () => {
        const subs = new InMemorySubscriptions();
        // Two clients on a shared backend may both choose id=1. Both should
        // receive events; the wire subscriptionId is "1" for each (per their
        // own request) and the internal map key is collision-safe.
        const a = subs.handle(listenReq({ toolsListChanged: true }, 1), {}, caps);
        const b = subs.handle(listenReq({ toolsListChanged: true }, 1), {}, caps);
        const readA = reader(a.stream);
        const readB = reader(b.stream);
        await readA(1);
        await readB(1);
        subs.notify({ type: 'toolsListChanged' });
        const [evtA] = await readA(1);
        const [evtB] = await readB(1);
        expect(evtA).toMatchObject({ method: 'notifications/tools/list_changed' });
        expect(evtB).toMatchObject({ method: 'notifications/tools/list_changed' });
        a.close();
        b.close();
    });
});
