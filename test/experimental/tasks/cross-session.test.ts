import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { InMemoryTransport } from '../../../src/inMemory.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '../../../src/experimental/tasks/stores/in-memory.js';
import { QueuedMessage } from '../../../src/experimental/tasks/interfaces.js';
import { CallToolResultSchema, ErrorCode, McpError, Request } from '../../../src/types.js';

const TASKS_CAPABILITY = {
    tasks: {
        list: {},
        cancel: {},
        requests: {
            tools: {
                call: {}
            }
        }
    }
};

const TOOL_CALL_REQUEST: Request = {
    method: 'tools/call',
    params: { name: 'test-tool' }
};

interface Session {
    client: Client;
    server: Server;
}

/**
 * Connects a client/server pair over an in-memory transport, with the server
 * sharing the given task store and message queue. The sessionId mimics what an
 * HTTP transport would expose (or a sessionless transport when undefined).
 */
async function connectSession(
    taskStore: InMemoryTaskStore,
    taskMessageQueue: InMemoryTaskMessageQueue,
    sessionId?: string
): Promise<Session> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = sessionId;

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: TASKS_CAPABILITY });
    const server = new Server(
        { name: 'test-server', version: '1.0.0' },
        {
            capabilities: TASKS_CAPABILITY,
            taskStore,
            taskMessageQueue
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    return { client, server };
}

async function expectTaskNotFound(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toSatisfy((error: McpError) => {
        expect(error).toBeInstanceOf(McpError);
        expect(error.code).toBe(ErrorCode.InvalidParams);
        expect(error.message).toContain('Task not found');
        return true;
    });
}

describe('cross-session task isolation (protocol level)', () => {
    let taskStore: InMemoryTaskStore;
    let taskMessageQueue: InMemoryTaskMessageQueue;
    let sessionA: Session;
    let sessionB: Session;

    beforeEach(async () => {
        taskStore = new InMemoryTaskStore();
        taskMessageQueue = new InMemoryTaskMessageQueue();
        sessionA = await connectSession(taskStore, taskMessageQueue, 'session-a');
        sessionB = await connectSession(taskStore, taskMessageQueue, 'session-b');
    });

    afterEach(async () => {
        taskStore.cleanup();
        await sessionA.client.close();
        await sessionA.server.close();
        await sessionB.client.close();
        await sessionB.server.close();
    });

    it('rejects tasks/get for a task owned by another session', async () => {
        const task = await taskStore.createTask({}, 1, TOOL_CALL_REQUEST, 'session-a');

        await expectTaskNotFound(sessionB.client.experimental.tasks.getTask(task.taskId));

        // The owning session can still read the task
        const owned = await sessionA.client.experimental.tasks.getTask(task.taskId);
        expect(owned.taskId).toBe(task.taskId);
    });

    it('rejects tasks/cancel for a task owned by another session and does not cancel it', async () => {
        const task = await taskStore.createTask({}, 1, TOOL_CALL_REQUEST, 'session-a');

        await expectTaskNotFound(sessionB.client.experimental.tasks.cancelTask(task.taskId));

        const owned = await taskStore.getTask(task.taskId, 'session-a');
        expect(owned?.status).toBe('working');
    });

    it('limits tasks/list to the requesting session', async () => {
        await taskStore.createTask({}, 1, TOOL_CALL_REQUEST, 'session-a');
        await taskStore.createTask({}, 2, TOOL_CALL_REQUEST, 'session-a');
        await taskStore.createTask({}, 3, TOOL_CALL_REQUEST, 'session-b');

        const listA = await sessionA.client.experimental.tasks.listTasks();
        expect(listA.tasks).toHaveLength(2);

        const listB = await sessionB.client.experimental.tasks.listTasks();
        expect(listB.tasks).toHaveLength(1);
    });

    it('rejects tasks/result for a task owned by another session without draining its message queue', async () => {
        const task = await taskStore.createTask({}, 1, TOOL_CALL_REQUEST, 'session-a');

        const queuedNotification: QueuedMessage = {
            type: 'notification',
            message: {
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'for session-a only' }
            },
            timestamp: Date.now()
        };
        await taskMessageQueue.enqueue(task.taskId, queuedNotification, 'session-a');

        await expectTaskNotFound(sessionB.client.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema));

        // The queued message must still be there for the owning session
        const remaining = await taskMessageQueue.dequeue(task.taskId, 'session-a');
        expect(remaining).toEqual(queuedNotification);
    });

    it('delivers tasks/result to the owning session', async () => {
        const task = await taskStore.createTask({}, 1, TOOL_CALL_REQUEST, 'session-a');
        await taskStore.storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: 'done' }] }, 'session-a');

        const result = await sessionA.client.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema);
        expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    });
});

describe('sessionless task isolation (protocol level)', () => {
    let taskStore: InMemoryTaskStore;
    let taskMessageQueue: InMemoryTaskMessageQueue;
    let sessionless: Session;
    let sessioned: Session;

    beforeEach(async () => {
        taskStore = new InMemoryTaskStore();
        taskMessageQueue = new InMemoryTaskMessageQueue();
        sessionless = await connectSession(taskStore, taskMessageQueue);
        sessioned = await connectSession(taskStore, taskMessageQueue, 'session-a');
    });

    afterEach(async () => {
        taskStore.cleanup();
        await sessionless.client.close();
        await sessionless.server.close();
        await sessioned.client.close();
        await sessioned.server.close();
    });

    it('keeps sessionless tasks accessible over a sessionless transport', async () => {
        const task = await taskStore.createTask({}, 1, TOOL_CALL_REQUEST);

        const owned = await sessionless.client.experimental.tasks.getTask(task.taskId);
        expect(owned.taskId).toBe(task.taskId);

        const listed = await sessionless.client.experimental.tasks.listTasks();
        expect(listed.tasks).toHaveLength(1);
    });

    it('hides sessionless tasks from sessioned callers', async () => {
        const task = await taskStore.createTask({}, 1, TOOL_CALL_REQUEST);

        await expectTaskNotFound(sessioned.client.experimental.tasks.getTask(task.taskId));
        expect((await sessioned.client.experimental.tasks.listTasks()).tasks).toHaveLength(0);
    });

    it('hides sessioned tasks from sessionless transports (fail closed)', async () => {
        // The gate fails closed: a request path that does not carry a session
        // id can never reach session-scoped tasks.
        const task = await taskStore.createTask({}, 1, TOOL_CALL_REQUEST, 'session-a');

        await expectTaskNotFound(sessionless.client.experimental.tasks.getTask(task.taskId));
        await expectTaskNotFound(sessionless.client.experimental.tasks.cancelTask(task.taskId));
        expect((await sessionless.client.experimental.tasks.listTasks()).tasks).toHaveLength(0);
    });

    it('rejects sessionless tasks/result for a sessioned task without draining its message queue', async () => {
        const task = await taskStore.createTask({}, 1, TOOL_CALL_REQUEST, 'session-a');

        const queuedNotification: QueuedMessage = {
            type: 'notification',
            message: {
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'for session-a only' }
            },
            timestamp: Date.now()
        };
        await taskMessageQueue.enqueue(task.taskId, queuedNotification, 'session-a');

        await expectTaskNotFound(sessionless.client.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema));

        // The queued message must still be there for the owning session
        const remaining = await taskMessageQueue.dequeue(task.taskId, 'session-a');
        expect(remaining).toEqual(queuedNotification);
    });

    it('lists only sessionless tasks for sessionless transports', async () => {
        await taskStore.createTask({}, 1, TOOL_CALL_REQUEST, 'session-a');
        const sessionlessTask = await taskStore.createTask({}, 2, TOOL_CALL_REQUEST);

        const listed = await sessionless.client.experimental.tasks.listTasks();
        expect(listed.tasks).toHaveLength(1);
        expect(listed.tasks[0].taskId).toBe(sessionlessTask.taskId);
    });
});
