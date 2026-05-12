import { GetTaskResultSchema, ListTasksResultSchema, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryTaskEnvironment } from '../../helpers/mcp.js';

// Exercises tasksPlugin's `tasks/list` and `tasks/get` handlers via raw `client.request()`.
// Setup uses createInMemoryTaskEnvironment (server.use(tasksPlugin({store}))).
describe('Task Listing with Pagination (tasksPlugin)', () => {
    let client: Awaited<ReturnType<typeof createInMemoryTaskEnvironment>>['client'];
    let server: Awaited<ReturnType<typeof createInMemoryTaskEnvironment>>['server'];
    let taskStore: Awaited<ReturnType<typeof createInMemoryTaskEnvironment>>['taskStore'];

    const listTasks = (cursor?: string) =>
        client.request({ method: 'tasks/list', params: cursor === undefined ? {} : { cursor } }, ListTasksResultSchema);
    const getTask = (taskId: string) => client.request({ method: 'tasks/get', params: { taskId } }, GetTaskResultSchema);

    beforeEach(async () => {
        const env = await createInMemoryTaskEnvironment();
        client = env.client;
        server = env.server;
        taskStore = env.taskStore;
    });

    afterEach(async () => {
        taskStore.cleanup();
        await client.close();
        await server.close();
    });

    it('should return empty list when no tasks exist', async () => {
        const result = await listTasks();

        expect(result.tasks).toEqual([]);
        expect(result.nextCursor).toBeUndefined();
    });

    it('should return all tasks when less than page size', async () => {
        for (let i = 0; i < 3; i++) {
            await taskStore.createTask({}, i, { method: 'tools/call', params: { name: 'test-tool' } });
        }

        const result = await listTasks();
        expect(result.tasks).toHaveLength(3);
        expect(result.nextCursor).toBeUndefined();
    });

    it('should paginate when more than page size', async () => {
        for (let i = 0; i < 15; i++) {
            await taskStore.createTask({}, i, { method: 'tools/call', params: { name: 'test-tool' } });
        }

        const page1 = await listTasks();
        expect(page1.tasks).toHaveLength(10);
        expect(page1.nextCursor).toBeDefined();

        const page2 = await listTasks(page1.nextCursor);
        expect(page2.tasks).toHaveLength(5);
        expect(page2.nextCursor).toBeUndefined();
    });

    it('should treat cursor as opaque token', async () => {
        for (let i = 0; i < 5; i++) {
            await taskStore.createTask({}, i, { method: 'tools/call', params: { name: 'test-tool' } });
        }

        const allTasks = taskStore.getAllTasks();
        const validCursor = allTasks[2]!.taskId;

        const result = await listTasks(validCursor);
        expect(result.tasks).toHaveLength(2);
    });

    it('should return error code -32602 for invalid cursor', async () => {
        await taskStore.createTask({}, 1, { method: 'tools/call', params: { name: 'test-tool' } });

        await expect(listTasks('invalid-cursor')).rejects.toSatisfy((error: ProtocolError) => {
            expect(error).toBeInstanceOf(ProtocolError);
            expect(error.code).toBe(ProtocolErrorCode.InvalidParams);
            expect(error.message).toContain('Invalid cursor');
            return true;
        });
    });

    it('should ensure tasks accessible via tasks/get are also accessible via tasks/list', async () => {
        const task = await taskStore.createTask({}, 1, { method: 'tools/call', params: { name: 'test-tool' } });

        const getResult = await getTask(task.taskId);
        expect(getResult.taskId).toBe(task.taskId);

        const listResult = await listTasks();
        expect(listResult.tasks).toHaveLength(1);
        expect(listResult.tasks[0]!.taskId).toBe(task.taskId);
    });

    it('should not include related-task metadata in list response', async () => {
        await taskStore.createTask({}, 1, { method: 'tools/call', params: { name: 'test-tool' } });

        const result = await listTasks();

        expect(result._meta).toBeDefined();
        expect(result._meta?.['io.modelcontextprotocol/related-task']).toBeUndefined();
    });
});
