import { describe, expect, test } from 'vitest';

import type { JSONRPCResultResponse } from '../../../src/types/index.js';
import type { BaseContext } from '../../../src/shared/protocol.js';
import type { DispatchOutput } from '../../../src/shared/dispatcher.js';
import { Dispatcher } from '../../../src/shared/dispatcher.js';
import { taskContext, tasksPlugin } from '../../../src/experimental/tasks/plugin.js';
import { InMemoryTaskStore } from '../../../src/experimental/tasks/stores/inMemory.js';

async function collect(gen: AsyncIterable<DispatchOutput>): Promise<DispatchOutput[]> {
    const out: DispatchOutput[] = [];
    for await (const m of gen) out.push(m);
    return out;
}

function asResult(m: DispatchOutput): JSONRPCResultResponse['result'] {
    if (m.kind !== 'response' || !('result' in m.message)) throw new Error(`expected result, got ${JSON.stringify(m)}`);
    return m.message.result;
}

function isErr(m: DispatchOutput): boolean {
    return m.kind === 'response' && 'error' in m.message;
}

describe('tasksPlugin', () => {
    test('registers tasks/* handlers and injects ctx.ext.task', async () => {
        const store = new InMemoryTaskStore();
        const d = new Dispatcher<BaseContext>({ buildContext: c => c });
        d.use(tasksPlugin({ store }));

        let observedTaskCtx: ReturnType<typeof taskContext>;
        d.setRequestHandler('tools/call', async (_params, ctx) => {
            observedTaskCtx = taskContext(ctx);
            return { content: [{ type: 'text', text: 'ok' }] };
        });

        const out = await collect(d.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {} } }));
        expect(asResult(out.at(-1)!)).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
        expect(observedTaskCtx).toBeDefined();
        expect(observedTaskCtx?.store).toBeDefined();
    });

    test('tasks/get returns not-found error for unknown id', async () => {
        const store = new InMemoryTaskStore();
        const d = new Dispatcher<BaseContext>({ buildContext: c => c });
        d.use(tasksPlugin({ store }));

        const out = await collect(d.dispatch({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 'nope' } }));
        const last = out.at(-1)!;
        expect(isErr(last)).toBe(true);
    });

    test('handler creates task; tasks/get retrieves it; tasks/result blocked until terminal', async () => {
        const store = new InMemoryTaskStore();
        const d = new Dispatcher<BaseContext>({ buildContext: c => c });
        d.use(tasksPlugin({ store }));

        let createdId = '';
        d.setRequestHandler('tools/call', async (_params, ctx) => {
            const tc = taskContext(ctx)!;
            const t = await tc.store.createTask({ ttl: 60_000 });
            createdId = t.taskId;
            return { resultType: 'task', task: t };
        });

        const callOut = await collect(d.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {} } }));
        expect(asResult(callOut.at(-1)!)).toMatchObject({ resultType: 'task' });
        expect(createdId).not.toBe('');

        const getOut = await collect(d.dispatch({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: createdId } }));
        expect(asResult(getOut.at(-1)!)).toMatchObject({ taskId: createdId });

        const resBlocked = await collect(d.dispatch({ jsonrpc: '2.0', id: 3, method: 'tasks/result', params: { taskId: createdId } }));
        expect(isErr(resBlocked.at(-1)!)).toBe(true);

        await store.storeTaskResult(createdId, 'completed', { content: [{ type: 'text', text: 'done' }] });
        const resOut = await collect(d.dispatch({ jsonrpc: '2.0', id: 4, method: 'tasks/result', params: { taskId: createdId } }));
        expect(asResult(resOut.at(-1)!)).toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    });

    test('non-tasks methods unaffected when plugin not registered', async () => {
        const d = new Dispatcher<BaseContext>({ buildContext: c => c });
        d.setRequestHandler('ping', async () => ({}));
        const out = await collect(d.dispatch({ jsonrpc: '2.0', id: 1, method: 'ping' }));
        expect(asResult(out.at(-1)!)).toEqual({});
    });
});
