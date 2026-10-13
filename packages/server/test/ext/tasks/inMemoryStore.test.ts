/**
 * `InMemoryTaskStore`: the store semantics a persistent implementation must
 * reproduce — durable create, partial input answers, first answer wins,
 * cancel aborts a pending input wait, terminal writes are ignored, TTL purge,
 * principal fail-closed.
 */
import { describe, expect, it } from 'vitest';

import { InMemoryTaskStore } from '../../../src/ext/tasks/index';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

describe('InMemoryTaskStore', () => {
    it('creates durably and records context for the execution to pick up', async () => {
        const store = new InMemoryTaskStore({ createTaskId: () => 'fixed' });
        const task = await store.create({ ttlMs: null, pollIntervalMs: 50, context: { tool: 'greet' } });
        expect(task).toMatchObject({ taskId: 'fixed', status: 'working', ttlMs: null, pollIntervalMs: 50 });
        expect(await store.get('fixed')).toMatchObject({ status: 'working' });
        expect(store.context('fixed')).toEqual({ tool: 'greet' });
        store.close();
    });

    it('accumulates partial input answers; the first answer to a key wins; unknown keys are ignored', async () => {
        const store = new InMemoryTaskStore();
        const { taskId } = await store.create({ ttlMs: null });
        const handle = store.handle(taskId);
        const answers = handle.requireInput({
            a: {
                method: 'elicitation/create',
                params: { message: 'q', mode: 'form', requestedSchema: { type: 'object', properties: {} } }
            },
            b: { method: 'elicitation/create', params: { message: 'q', mode: 'form', requestedSchema: { type: 'object', properties: {} } } }
        });
        await tick();
        expect(await store.get(taskId)).toMatchObject({ status: 'input_required', inputRequests: { a: {}, b: {} } });
        expect(await store.update(taskId, { a: { action: 'accept' }, zzz: { action: 'accept' } })).toBe(true);
        expect(await store.get(taskId)).toMatchObject({ status: 'input_required', inputRequests: { b: {} } });
        await store.update(taskId, { a: { action: 'decline' }, b: { action: 'cancel' } });
        expect(await answers).toEqual({ a: { action: 'accept' }, b: { action: 'cancel' } });
        expect((await store.get(taskId))?.status).toBe('working');
        store.close();
    });

    it('cancel rejects a pending input wait, aborts the signal, and later writes are ignored', async () => {
        const store = new InMemoryTaskStore();
        const { taskId } = await store.create({ ttlMs: null });
        const handle = store.handle(taskId);
        const waiting = handle.requireInput({
            a: { method: 'elicitation/create', params: { message: 'q', mode: 'form', requestedSchema: { type: 'object', properties: {} } } }
        });
        expect(await store.cancel(taskId)).toBe(true);
        await expect(waiting).rejects.toThrow('cancelled');
        expect(handle.signal.aborted).toBe(true);
        await handle.complete({ content: [] });
        await handle.status('late');
        expect(await store.get(taskId)).toMatchObject({ status: 'cancelled' });
        expect((await store.get(taskId))?.statusMessage).toBeUndefined();
        expect(await store.cancel(taskId)).toBe(true);
        expect(await store.cancel('missing')).toBe(false);
        store.close();
    });

    it('purges at the TTL deadline and fails closed on a foreign principal', async () => {
        const store = new InMemoryTaskStore();
        const { taskId } = await store.create({ ttlMs: 10, principal: 'alice' });
        expect(await store.get(taskId)).toBeUndefined();
        expect(await store.get(taskId, { principal: 'bob' })).toBeUndefined();
        expect((await store.get(taskId, { principal: 'alice' }))?.taskId).toBe(taskId);
        expect(await store.update(taskId, {}, { principal: 'bob' })).toBe(false);
        await tick(30);
        expect(await store.get(taskId, { principal: 'alice' })).toBeUndefined();
        expect(() => store.handle(taskId)).toThrow('not found');
        store.close();
    });

    it('rejects invalid ttlMs and pollIntervalMs', async () => {
        const store = new InMemoryTaskStore();
        await expect(store.create({ ttlMs: -1 })).rejects.toBeInstanceOf(RangeError);
        await expect(store.create({ ttlMs: null, pollIntervalMs: 1.5 })).rejects.toBeInstanceOf(RangeError);
        store.close();
    });
});
