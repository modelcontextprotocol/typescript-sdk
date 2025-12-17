import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ErrorCode, McpError } from '../../../src/types.js';
import { createInMemoryTaskEnvironment } from '../../helpers/mcp.js';

describe('Task Listing with Pagination', () => {
    let client: Awaited<ReturnType<typeof createInMemoryTaskEnvironment>>['client'];
    let server: Awaited<ReturnType<typeof createInMemoryTaskEnvironment>>['server'];
    let taskStore: Awaited<ReturnType<typeof createInMemoryTaskEnvironment>>['taskStore'];

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
        const result = await client.experimental.tasks.listTasks();

        expect(result.tasks).toEqual([]);
        expect(result.nextCursor).toBeUndefined();
    });

    it('should return all tasks when less than page size', async () => {
        // Create 3 tasks
        for (let i = 0; i < 3; i++) {
            await taskStore.createTask({}, i, {
                method: 'tools/call',
                params: { name: 'test-tool' }
            });
        }

        const result = await client.experimental.tasks.listTasks();

        expect(result.tasks).toHaveLength(3);
        expect(result.nextCursor).toBeUndefined();
    });

    it('should paginate when more than page size exists', async () => {
        // Create 15 tasks (page size is 10 in InMemoryTaskStore)
        for (let i = 0; i < 15; i++) {
            await taskStore.createTask({}, i, {
                method: 'tools/call',
                params: { name: 'test-tool' }
            });
        }

        // Get first page
        const page1 = await client.experimental.tasks.listTasks();
        expect(page1.tasks).toHaveLength(10);
        expect(page1.nextCursor).toBeDefined();

        // Get second page using cursor
        const page2 = await client.experimental.tasks.listTasks(page1.nextCursor);
        expect(page2.tasks).toHaveLength(5);
        expect(page2.nextCursor).toBeUndefined();
    });

    it('should treat cursor as opaque token', async () => {
        // Create 5 tasks
        for (let i = 0; i < 5; i++) {
            await taskStore.createTask({}, i, {
                method: 'tools/call',
                params: { name: 'test-tool' }
            });
        }

        // Get all tasks to get a valid cursor
        const allTasks = taskStore.getAllTasks();
        const validCursor = allTasks[2].taskId;

        // Use the cursor - should work even though we don't know its internal structure
        const result = await client.experimental.tasks.listTasks(validCursor);
        expect(result.tasks).toHaveLength(2);
    });

    it('should return error code -32602 for invalid cursor', async () => {
        await taskStore.createTask({}, 1, {
            method: 'tools/call',
            params: { name: 'test-tool' }
        });

        // Try to use an invalid cursor - should return -32602 (Invalid params) per MCP spec
        await expect(client.experimental.tasks.listTasks('invalid-cursor')).rejects.toSatisfy((error: McpError) => {
            expect(error).toBeInstanceOf(McpError);
            expect(error.code).toBe(ErrorCode.InvalidParams);
            expect(error.message).toContain('Invalid cursor');
            return true;
        });
    });

    it('should ensure tasks accessible via tasks/get are also accessible via tasks/list', async () => {
        // Create a task
        const task = await taskStore.createTask({}, 1, {
            method: 'tools/call',
            params: { name: 'test-tool' }
        });

        // Verify it's accessible via tasks/get
        const getResult = await client.experimental.tasks.getTask(task.taskId);
        expect(getResult.taskId).toBe(task.taskId);

        // Verify it's also accessible via tasks/list
        const listResult = await client.experimental.tasks.listTasks();
        expect(listResult.tasks).toHaveLength(1);
        expect(listResult.tasks[0].taskId).toBe(task.taskId);
    });

    it('should not include related-task metadata in list response', async () => {
        // Create a task
        await taskStore.createTask({}, 1, {
            method: 'tools/call',
            params: { name: 'test-tool' }
        });

        const result = await client.experimental.tasks.listTasks();

        // The response should have _meta but not include related-task metadata
        expect(result._meta).toBeDefined();
        expect(result._meta?.['io.modelcontextprotocol/related-task']).toBeUndefined();
    });
});
