import type { JSONRPCMessage } from '../../src/types/index.js';
import { JSONRPC_VERSION } from '../../src/types/index.js';
import { META_KEYS } from '../../src/shared/stateless.js';
import { StreamDriver } from '../../src/shared/streamDriver.js';

async function collect(it: AsyncIterable<JSONRPCMessage>): Promise<JSONRPCMessage[]> {
    const out: JSONRPCMessage[] = [];
    for await (const m of it) out.push(m);
    return out;
}

describe('StreamDriver', () => {
    it('sendAndReceive yields the response and ends', async () => {
        const sent: JSONRPCMessage[] = [];
        const d = new StreamDriver(async m => {
            sent.push(m);
        });
        const it = d.sendAndReceive({ method: 'tools/list', params: {} });
        const id = (sent[0] as { id: number }).id;
        d.onMessage({ jsonrpc: JSONRPC_VERSION, id, result: { tools: [] } });
        const got = await collect(it);
        expect(got).toEqual([{ jsonrpc: JSONRPC_VERSION, id, result: { tools: [] } }]);
    });

    it('routes notifications by _meta.subscriptionId then the response', async () => {
        const sent: JSONRPCMessage[] = [];
        const d = new StreamDriver(async m => {
            sent.push(m);
        });
        const it = d.sendAndReceive({ method: 'tools/call', params: { name: 'x' } });
        const id = (sent[0] as { id: number }).id;
        // Server stamps `_meta.subscriptionId = String(request.id)` on all
        // notifications it emits for this request.
        d.onMessage({
            jsonrpc: JSONRPC_VERSION,
            method: 'notifications/progress',
            params: { progress: 1, _meta: { [META_KEYS.subscriptionId]: String(id) } }
        });
        d.onMessage({ jsonrpc: JSONRPC_VERSION, id, result: { content: [] } });
        const got = await collect(it);
        expect(got).toHaveLength(2);
        expect(got[0]).toMatchObject({ method: 'notifications/progress' });
        expect(got[1]).toMatchObject({ result: { content: [] } });
    });

    it('routes the listen ack and subsequent events to the listen iterator', async () => {
        const sent: JSONRPCMessage[] = [];
        const d = new StreamDriver(async m => {
            sent.push(m);
        });
        const it = d.sendAndReceive({ method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true } } });
        const id = (sent[0] as { id: number }).id;
        const sid = String(id);
        d.onMessage({
            jsonrpc: JSONRPC_VERSION,
            method: 'notifications/subscriptions/acknowledged',
            params: { notifications: { toolsListChanged: true }, _meta: { [META_KEYS.subscriptionId]: sid } }
        });
        d.onMessage({
            jsonrpc: JSONRPC_VERSION,
            method: 'notifications/tools/list_changed',
            params: { _meta: { [META_KEYS.subscriptionId]: sid } }
        });
        const iter = it[Symbol.asyncIterator]();
        const first = await iter.next();
        const second = await iter.next();
        expect(first.value).toMatchObject({ method: 'notifications/subscriptions/acknowledged' });
        expect(second.value).toMatchObject({ method: 'notifications/tools/list_changed' });
        await iter.return?.();
    });

    it('isolates concurrent requests by id', async () => {
        const sent: JSONRPCMessage[] = [];
        const d = new StreamDriver(async m => {
            sent.push(m);
        });
        const a = d.sendAndReceive({ method: 'tools/list', params: {} });
        const b = d.sendAndReceive({ method: 'prompts/list', params: {} });
        const idA = (sent[0] as { id: number }).id;
        const idB = (sent[1] as { id: number }).id;
        expect(idA).not.toBe(idB);
        d.onMessage({ jsonrpc: JSONRPC_VERSION, id: idB, result: { prompts: [] } });
        d.onMessage({ jsonrpc: JSONRPC_VERSION, id: idA, result: { tools: [] } });
        await expect(collect(a)).resolves.toEqual([{ jsonrpc: JSONRPC_VERSION, id: idA, result: { tools: [] } }]);
        await expect(collect(b)).resolves.toEqual([{ jsonrpc: JSONRPC_VERSION, id: idB, result: { prompts: [] } }]);
    });

    it('early break sends notifications/cancelled and clears the pending entry', async () => {
        const sent: JSONRPCMessage[] = [];
        const d = new StreamDriver(async m => {
            sent.push(m);
        });
        const it = d.sendAndReceive({ method: 'tools/call', params: { name: 'x' } });
        const id = (sent[0] as { id: number }).id;
        const iter = it[Symbol.asyncIterator]();
        await iter.return?.();
        expect(sent.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { requestId: id } });
        expect(d.onMessage({ jsonrpc: JSONRPC_VERSION, id, result: {} })).toBe(false);
    });

    it('surfaces send failure to the iterator instead of hanging', async () => {
        const d = new StreamDriver(async () => {
            throw new Error('write failed');
        });
        const it = d.sendAndReceive({ method: 'tools/list', params: {} });
        const got = await collect(it);
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ error: { message: expect.stringContaining('write failed') } });
    });

    it('onMessage returns false for unknown id and unknown subscriptionId', () => {
        const d = new StreamDriver(async () => {});
        expect(d.onMessage({ jsonrpc: JSONRPC_VERSION, id: 999, result: {} })).toBe(false);
        expect(
            d.onMessage({
                jsonrpc: JSONRPC_VERSION,
                method: 'notifications/x',
                params: { _meta: { [META_KEYS.subscriptionId]: 'nope' } }
            })
        ).toBe(false);
    });

    it('close() ends every pending iterator', async () => {
        const d = new StreamDriver(async () => {});
        const a = d.sendAndReceive({ method: 'tools/list', params: {} });
        const b = d.sendAndReceive({ method: 'prompts/list', params: {} });
        d.close();
        await expect(collect(a)).resolves.toEqual([]);
        await expect(collect(b)).resolves.toEqual([]);
    });

    it('return() after natural end is a no-op (no second cancelled)', async () => {
        const sent: JSONRPCMessage[] = [];
        const d = new StreamDriver(async m => {
            sent.push(m);
        });
        const it = d.sendAndReceive({ method: 'tools/list', params: {} });
        const id = (sent[0] as { id: number }).id;
        d.onMessage({ jsonrpc: JSONRPC_VERSION, id, result: {} });
        await collect(it);
        const iter = it[Symbol.asyncIterator]();
        await iter.return?.();
        expect(sent.filter(m => 'method' in m && m.method === 'notifications/cancelled')).toHaveLength(0);
    });
});
