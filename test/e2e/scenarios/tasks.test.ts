/**
 * Self-contained test bodies for experimental task-augmented tool calls
 * (`tasks:` requirements): a tool whose asynchronous work fails after the
 * server has already returned a CreateTaskResult must store that failure in
 * the task store with status `failed`, and a later `tasks/result` request for
 * the task must return the stored error result.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTaskStore, isSpecType, McpServer, RELATED_TASK_META_KEY, specTypeSchemas } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { tapWire, wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

verifies('tasks:result:failed-task-stored-result', async ({ transport }: TestArgs) => {
    const taskStore = new InMemoryTaskStore();
    try {
        // The deployment work this tool kicks off always fails, so the handler's failure path runs.
        const pushReleaseImage = async (version: string): Promise<void> => {
            throw new Error(`Deploy of ${version} failed: image registry unreachable`);
        };

        const makeServer = () => {
            const s = new McpServer(
                { name: 's', version: '0' },
                { capabilities: { tasks: { requests: { tools: { call: {} } }, taskStore } } }
            );
            s.experimental.tasks.registerToolTask(
                'deploy-release',
                {
                    description: 'Deploys a release image to the production fleet',
                    inputSchema: z.object({ version: z.string() })
                },
                {
                    async createTask({ version }, ctx) {
                        const task = await ctx.task.store.createTask({ ttl: 60_000, pollInterval: 50 });
                        const work = (async () => {
                            // Let the CreateTaskResult response go out before the work fails.
                            await new Promise(resolve => setTimeout(resolve, 10));
                            try {
                                await pushReleaseImage(version);
                                await ctx.task.store.storeTaskResult(task.taskId, 'completed', {
                                    content: [{ type: 'text', text: `Deployed ${version}` }]
                                });
                            } catch (error) {
                                const text = error instanceof Error ? error.message : String(error);
                                await ctx.task.store.storeTaskResult(task.taskId, 'failed', {
                                    content: [{ type: 'text', text }],
                                    isError: true
                                });
                            }
                        })();
                        // A status notification emitted after teardown must not surface as an unhandled rejection.
                        work.catch(() => {});
                        return { task };
                    },
                    async getTask(_args, ctx) {
                        return await ctx.task.store.getTask(ctx.task.id);
                    },
                    async getTaskResult(_args, ctx) {
                        const stored = await ctx.task.store.getTaskResult(ctx.task.id);
                        const validated = specTypeSchemas.CallToolResult['~standard'].validate(stored);
                        if (validated.issues) {
                            throw new Error('stored task result is not a valid CallToolResult');
                        }
                        return validated.value;
                    }
                }
            );
            return s;
        };
        const client = new Client({ name: 'c', version: '0' }, { capabilities: { tasks: {} } });

        await using _ = await wire(transport, makeServer, client);
        const tap = tapWire(client);

        const createResult = await client.request({
            method: 'tools/call',
            params: { name: 'deploy-release', arguments: { version: '2.4.1' }, task: { ttl: 60_000 } }
        });
        if (!isSpecType.CreateTaskResult(createResult)) {
            throw new Error('expected the task-augmented tools/call to return a CreateTaskResult');
        }
        const taskId = createResult.task.taskId;

        // The failure must be recorded in the task store with terminal status 'failed', observable via tasks/get.
        await vi.waitFor(
            async () => {
                const polled = await client.experimental.tasks.getTask(taskId);
                expect(polled.status).toBe('failed');
            },
            { timeout: 5000 }
        );

        // A subsequent tasks/result request returns the stored error result rather than losing it.
        const stored = await client.experimental.tasks.getTaskResult(taskId);
        expect(stored.isError).toBe(true);
        expect(stored.content).toEqual([{ type: 'text', text: 'Deploy of 2.4.1 failed: image registry unreachable' }]);
        expect(stored._meta?.[RELATED_TASK_META_KEY]).toEqual({ taskId });

        const tasksResultRequests = tap.sent.filter(m => 'method' in m && m.method === 'tasks/result');
        expect(tasksResultRequests).toHaveLength(1);
    } finally {
        taskStore.cleanup();
    }
});
