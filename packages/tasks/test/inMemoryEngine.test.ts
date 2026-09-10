/**
 * The in-memory engine against a scripted executor: journal semantics that a
 * durable engine must reproduce (replay hits, generation fencing, offers,
 * elicit timeouts, TTL purge, principal binding).
 */
import { describe, expect, it } from 'vitest';

import type { RunOutcome, StepJournal, TaskExecutor, TaskInvocation } from '../src/index';
import { DuplicateStepError, InMemoryTaskEngine, StaleLeaseError } from '../src/index';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/** An executor whose behaviour is a script over the journal. */
const scripted = (script: (invocation: TaskInvocation, journal: StepJournal) => Promise<RunOutcome>): TaskExecutor => ({
    runTask: script
});

const params = { taskName: 't', input: { a: 1 }, ttlMs: null, pollIntervalMs: 100 };

describe('InMemoryTaskEngine', () => {
    it('creates durably: get succeeds before the first run has happened', async () => {
        const engine = new InMemoryTaskEngine();
        engine.attach(scripted(async () => ({ outcome: 'completed', result: { content: [] } })));
        const task = await engine.create(params);
        expect(await engine.get(task.taskId)).toMatchObject({ status: 'working', taskId: task.taskId });
        await tick(5);
        expect(await engine.get(task.taskId)).toMatchObject({ status: 'completed', result: { content: [] } });
        engine.close();
    });

    it('replays completed steps and resumes after a sleep on a new attempt', async () => {
        const engine = new InMemoryTaskEngine();
        const seen: Array<[number, string]> = [];
        engine.attach(
            scripted(async (invocation, journal) => {
                const first = await journal.beginStep('one');
                seen.push([invocation.attempt, first.state]);
                if (first.state === 'run') await journal.completeStep('one', 42);
                const sleep = await journal.recordSleep('nap', Date.now() + 5);
                if (sleep.state === 'pending') return { outcome: 'suspended' };
                seen.push([invocation.attempt, `sleep:${sleep.latest}`]);
                return {
                    outcome: 'completed',
                    result: { content: [{ type: 'text', text: String(first.state === 'completed' && first.value) }] }
                };
            })
        );
        const task = await engine.create(params);
        await tick(30);
        expect(seen).toEqual([
            [1, 'run'],
            [2, 'completed'],
            [2, 'sleep:true']
        ]);
        expect(await engine.get(task.taskId)).toMatchObject({ status: 'completed', result: { content: [{ type: 'text', text: '42' }] } });
        engine.close();
    });

    it('fences a superseded attempt with StaleLeaseError', async () => {
        const engine = new InMemoryTaskEngine();
        let stale: StepJournal | undefined;
        engine.attach(
            scripted(async (invocation, journal) => {
                if (invocation.attempt === 1) {
                    stale = journal;
                    await journal.recordSleep('nap', Date.now() + 1);
                    return { outcome: 'suspended' };
                }
                return { outcome: 'completed', result: { content: [] } };
            })
        );
        await engine.create(params);
        await tick(20);
        await expect(stale?.beginStep('late')).rejects.toBeInstanceOf(StaleLeaseError);
        engine.close();
    });

    it('holds input_required until tasks/update answers the blocking request', async () => {
        const engine = new InMemoryTaskEngine();
        engine.attach(
            scripted(async (_invocation, journal) => {
                const state = await journal.recordElicit('q', { method: 'elicitation/create', params: {} });
                if (state.state !== 'answered') return { outcome: 'suspended' };
                return { outcome: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(state.response) }] } };
            })
        );
        const task = await engine.create(params);
        await tick(5);
        expect(await engine.get(task.taskId)).toMatchObject({
            status: 'input_required',
            inputRequests: { q: { method: 'elicitation/create', params: {} } }
        });
        expect(await engine.update(task.taskId, { ignored: { action: 'accept' } })).toBe(true);
        await tick(5);
        expect((await engine.get(task.taskId))?.status).toBe('input_required');
        await engine.update(task.taskId, { q: { action: 'decline' } });
        await tick(5);
        expect(await engine.get(task.taskId)).toMatchObject({
            status: 'completed',
            result: { content: [{ type: 'text', text: '{"action":"decline"}' }] }
        });
        engine.close();
    });

    it('resolves a timed elicit as timed_out at its deadline', async () => {
        const engine = new InMemoryTaskEngine();
        const outcomes: string[] = [];
        engine.attach(
            scripted(async (_invocation, journal) => {
                const state = await journal.recordElicit('q', {}, Date.now() + 5);
                outcomes.push(state.state);
                if (state.state === 'pending') return { outcome: 'suspended' };
                return { outcome: 'completed', result: { content: [] } };
            })
        );
        const task = await engine.create(params);
        await tick(30);
        expect(outcomes).toEqual(['pending', 'timed_out']);
        expect((await engine.get(task.taskId))?.status).toBe('completed');
        engine.close();
    });

    it('offers never block; an answer cuts a pending sleep and checkInput consumes once', async () => {
        const engine = new InMemoryTaskEngine();
        const checks: string[] = [];
        engine.attach(
            scripted(async (_invocation, journal) => {
                await journal.recordOffer('side', { method: 'elicitation/create' });
                await expect(journal.recordElicit('side', {})).rejects.toBeInstanceOf(DuplicateStepError);
                const sleep = await journal.recordSleep('long', Date.now() + 60_000);
                if (sleep.state === 'pending') return { outcome: 'suspended' };
                const first = await journal.checkInput('check-1', 'side');
                const second = await journal.checkInput('check-2', 'side');
                checks.push(first.state, second.state);
                return { outcome: 'completed', result: { content: [] } };
            })
        );
        const task = await engine.create(params);
        await tick(5);
        expect(await engine.get(task.taskId)).toMatchObject({ status: 'working' });
        await engine.update(task.taskId, { side: { action: 'accept' } });
        await tick(10);
        expect(checks).toEqual(['answered', 'unanswered']);
        expect((await engine.get(task.taskId))?.status).toBe('completed');
        engine.close();
    });

    it('cancels: immediately when idle, at the next beginStep when running', async () => {
        const engine = new InMemoryTaskEngine();
        let release: (() => void) | undefined;
        engine.attach(
            scripted(async (_invocation, journal) => {
                await new Promise<void>(resolve => {
                    release = resolve;
                });
                const step = await journal.beginStep('after-cancel');
                if (step.state === 'cancelled') return { outcome: 'suspended' };
                return { outcome: 'completed', result: { content: [] } };
            })
        );
        const task = await engine.create(params);
        await tick(5);
        expect(await engine.cancel(task.taskId)).toBe(true);
        expect((await engine.get(task.taskId))?.status).toBe('working');
        release?.();
        await tick(5);
        expect((await engine.get(task.taskId))?.status).toBe('cancelled');
        expect(await engine.cancel(task.taskId)).toBe(true);
        expect(await engine.cancel('missing')).toBe(false);
        engine.close();
    });

    it('purges at the TTL deadline and fails closed on a foreign principal', async () => {
        const engine = new InMemoryTaskEngine();
        engine.attach(scripted(async () => ({ outcome: 'completed', result: { content: [] } })));
        const task = await engine.create({ ...params, ttlMs: 10, principal: 'alice' });
        expect(await engine.get(task.taskId)).toBeUndefined();
        expect(await engine.get(task.taskId, { principal: 'bob' })).toBeUndefined();
        expect((await engine.get(task.taskId, { principal: 'alice' }))?.taskId).toBe(task.taskId);
        await tick(30);
        expect(await engine.get(task.taskId, { principal: 'alice' })).toBeUndefined();
        engine.close();
    });

    it('fails the task when no executor is attached', async () => {
        const engine = new InMemoryTaskEngine();
        const task = await engine.create(params);
        await tick(5);
        expect(await engine.get(task.taskId)).toMatchObject({ status: 'failed', error: { code: -32_603 } });
        engine.close();
    });
});
