/**
 * `TasksClientExtension` against a scripted 2026-07-28 server: the
 * capability rides every request, `callTool` splits task handles from plain
 * results, and `waitFor` polls at the task's interval until terminal,
 * reporting `input_required` on the way.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { CLIENT_CAPABILITIES_META_KEY, InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../../src/client/client';
import { TASKS_EXTENSION_ID, TasksClientExtension } from '../../../src/ext/tasks/index';

const MODERN = '2026-07-28';
const NOW = '2026-09-17T10:00:00.000Z';

type Snapshot = Record<string, unknown>;

/** A scripted server: a task whose `tasks/get` answers walk through `script`, one per poll. */
async function scriptedServer(script: Snapshot[]) {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const written: JSONRPCMessage[] = [];
    let polls = 0;
    serverTx.onmessage = message => {
        written.push(message);
        const request = message as { id?: number | string; method?: string; params?: { name?: string; taskId?: string } };
        if (request.id === undefined) return;
        const reply = (result: Snapshot) => void serverTx.send({ jsonrpc: '2.0', id: request.id as number, result });
        switch (request.method) {
            case 'server/discover': {
                reply({ resultType: 'complete', supportedVersions: [MODERN], capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } });
                break;
            }
            case 'tools/call': {
                reply(
                    request.params?.name === 'slow'
                        ? {
                              resultType: 'task',
                              taskId: 't-1',
                              status: 'working',
                              createdAt: NOW,
                              lastUpdatedAt: NOW,
                              ttlMs: null,
                              pollIntervalMs: 5
                          }
                        : { resultType: 'complete', content: [{ type: 'text', text: 'fast' }] }
                );
                break;
            }
            case 'tasks/get': {
                const snapshot = script[Math.min(polls, script.length - 1)] ?? {};
                polls += 1;
                reply({
                    resultType: 'complete',
                    taskId: 't-1',
                    createdAt: NOW,
                    lastUpdatedAt: NOW,
                    ttlMs: null,
                    pollIntervalMs: 5,
                    ...snapshot
                });
                break;
            }
            case 'tasks/update':
            case 'tasks/cancel': {
                reply({ resultType: 'complete' });
                break;
            }
            default: {
                reply({ resultType: 'complete' });
            }
        }
    };
    await serverTx.start();
    const tasks = new TasksClientExtension();
    const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' }, extensions: [tasks] });
    await client.connect(clientTx);
    return { client, tasks, written, pollCount: () => polls };
}

const methodsWritten = (written: JSONRPCMessage[]) => written.map(message => (message as { method?: string }).method).filter(Boolean);

describe('TasksClientExtension', () => {
    it('is bound to one client and refuses use before install', async () => {
        const tasks = new TasksClientExtension();
        await expect(tasks.get('t-1')).rejects.toThrow(/not installed/);
        new Client({ name: 'a', version: '1' }, { extensions: [tasks] });
        expect(() => new Client({ name: 'b', version: '1' }, { extensions: [tasks] })).toThrow(/already installed/);
    });

    it('declares the extension on every request and splits task handles from plain results', async () => {
        const { client, tasks, written } = await scriptedServer([]);
        const plain = await tasks.callTool({ name: 'fast', arguments: {} });
        expect(plain).toEqual({ kind: 'result', result: { content: [{ type: 'text', text: 'fast' }] } });
        const slow = await tasks.callTool({ name: 'slow', arguments: {} });
        expect(slow.kind === 'task' && slow.task).toMatchObject({
            resultType: 'task',
            taskId: 't-1',
            status: 'working',
            pollIntervalMs: 5
        });
        const call = written.find(message => (message as { method?: string }).method === 'tools/call') as {
            params: { _meta: Record<string, unknown> };
        };
        expect(call.params._meta[CLIENT_CAPABILITIES_META_KEY]).toEqual({ extensions: { [TASKS_EXTENSION_ID]: {} } });
        await client.close();
    });

    it('waitFor polls at the task interval, reports input_required, and resolves on the terminal snapshot', async () => {
        const { client, tasks, pollCount } = await scriptedServer([
            { status: 'working', statusMessage: 'starting' },
            {
                status: 'input_required',
                inputRequests: {
                    q: {
                        method: 'elicitation/create',
                        params: { message: '?', mode: 'form', requestedSchema: { type: 'object', properties: {} } }
                    }
                }
            },
            { status: 'completed', result: { content: [{ type: 'text', text: 'done' }] } }
        ]);
        const seen: string[] = [];
        const done = await tasks.waitFor('t-1', {
            onUpdate: task => {
                seen.push(task.status);
                if (task.status === 'input_required') void tasks.update('t-1', { q: { action: 'accept' } });
            }
        });
        expect(seen).toEqual(['working', 'input_required', 'completed']);
        expect(done).toMatchObject({ status: 'completed', result: { content: [{ type: 'text', text: 'done' }] } });
        expect(pollCount()).toBe(3);
        await client.close();
    });

    it('waitFor stops on abort without touching the task; cancel is an explicit call', async () => {
        const { client, tasks, written } = await scriptedServer([{ status: 'working' }]);
        const controller = new AbortController();
        const waiting = tasks.waitFor('t-1', { signal: controller.signal, pollIntervalMs: 1000 });
        await new Promise(resolve => setTimeout(resolve, 10));
        controller.abort(new Error('stop polling'));
        await expect(waiting).rejects.toThrow('stop polling');
        expect(methodsWritten(written)).not.toContain('tasks/cancel');
        await tasks.cancel('t-1');
        expect(methodsWritten(written)).toContain('tasks/cancel');
        await client.close();
    });
});
