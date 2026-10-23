import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '../../../src/client/index.js';
import { StreamableHTTPClientTransport } from '../../../src/client/streamableHttp.js';
import type { QueuedMessage } from '../../../src/experimental/tasks/interfaces.js';
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from '../../../src/experimental/tasks/stores/in-memory.js';
import { InMemoryTransport } from '../../../src/inMemory.js';
import { McpServer } from '../../../src/server/mcp.js';
import { StreamableHTTPServerTransport } from '../../../src/server/streamableHttp.js';
import type { TaskRequestOptions } from '../../../src/shared/protocol.js';
import {
    CallToolResultSchema,
    CreateTaskResultSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    ErrorCode,
    ListResourcesResultSchema,
    ListToolsResultSchema,
    PingRequestSchema,
    RELATED_TASK_META_KEY
} from '../../../src/types.js';
import { listenOnRandomPort } from '../../helpers/http.js';
import { waitForTaskStatus } from '../../helpers/tasks.js';

const request = { method: 'tools/call', params: { name: 'test-tool' } };

describe('InMemoryTaskStore session scoping', () => {
    let store: InMemoryTaskStore;

    beforeEach(() => {
        store = new InMemoryTaskStore();
    });

    afterEach(() => {
        store.cleanup();
    });

    it('returns a task to the session that created it', async () => {
        const task = await store.createTask({}, 1, request, 'session-a');

        expect((await store.getTask(task.taskId, 'session-a'))?.taskId).toBe(task.taskId);
    });

    it('treats a task as not found for a different session', async () => {
        const task = await store.createTask({}, 1, request, 'session-a');

        expect(await store.getTask(task.taskId, 'session-b')).toBeNull();
        await expect(store.updateTaskStatus(task.taskId, 'cancelled', undefined, 'session-b')).rejects.toThrow('not found');
        await expect(store.storeTaskResult(task.taskId, 'completed', { content: [] }, 'session-b')).rejects.toThrow('not found');
        expect((await store.getTask(task.taskId, 'session-a'))?.status).toBe('working');

        await store.storeTaskResult(task.taskId, 'completed', { content: [] }, 'session-a');
        await expect(store.getTaskResult(task.taskId, 'session-b')).rejects.toThrow('not found');
        expect(await store.getTaskResult(task.taskId, 'session-a')).toEqual({ content: [] });
    });

    it('lists the tasks of the calling session and the tasks created without a sessionId', async () => {
        const a1 = await store.createTask({}, 1, request, 'session-a');
        const a2 = await store.createTask({}, 2, request, 'session-a');
        const b1 = await store.createTask({}, 3, request, 'session-b');
        const shared = await store.createTask({}, 4, request);

        expect((await store.listTasks(undefined, 'session-a')).tasks.map(t => t.taskId)).toEqual([a1.taskId, a2.taskId, shared.taskId]);
        expect((await store.listTasks(undefined, 'session-b')).tasks.map(t => t.taskId)).toEqual([b1.taskId, shared.taskId]);
        expect((await store.listTasks()).tasks).toHaveLength(4);
    });

    it('paginates within the calling session', async () => {
        for (let i = 0; i < 12; i++) {
            await store.createTask({}, i, request, 'session-a');
            await store.createTask({}, 100 + i, request, 'session-b');
        }

        const page1 = await store.listTasks(undefined, 'session-a');
        expect(page1.tasks).toHaveLength(10);
        const page2 = await store.listTasks(page1.nextCursor, 'session-a');
        expect(page2.tasks).toHaveLength(2);
        expect(page2.nextCursor).toBeUndefined();

        await expect(store.listTasks(page1.nextCursor, 'session-b')).rejects.toThrow('Invalid cursor');
    });

    it('does not restrict calls that pass no sessionId', async () => {
        const task = await store.createTask({}, 1, request, 'session-a');

        expect((await store.getTask(task.taskId))?.taskId).toBe(task.taskId);
        await store.storeTaskResult(task.taskId, 'completed', { content: [] });
        expect(await store.getTaskResult(task.taskId)).toEqual({ content: [] });
    });

    it('returns and lists a task created without a sessionId for any session', async () => {
        const task = await store.createTask({}, 1, request);

        expect((await store.getTask(task.taskId, 'session-a'))?.taskId).toBe(task.taskId);
        expect((await store.listTasks(undefined, 'session-a')).tasks.map(t => t.taskId)).toEqual([task.taskId]);
    });
});

describe('Task session scoping over Streamable HTTP', () => {
    let httpServer: Server;
    let baseUrl: URL;
    let taskStore: InMemoryTaskStore;
    let taskMessageQueue: InMemoryTaskMessageQueue;
    let sessions: Map<string, { mcpServer: McpServer; transport: StreamableHTTPServerTransport }>;
    const openTransports: StreamableHTTPClientTransport[] = [];

    function createMcpServer(taskMessageQueue: InMemoryTaskMessageQueue): McpServer {
        const mcpServer = new McpServer(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: { tasks: { requests: { tools: { call: {} } }, list: {}, cancel: {} } },
                taskStore,
                taskMessageQueue
            }
        );

        mcpServer.experimental.tasks.registerToolTask(
            'slow-task',
            { description: 'Completes after a delay', inputSchema: { duration: z.number().default(50) } },
            {
                async createTask({ duration }, extra) {
                    const task = await extra.taskStore.createTask({ ttl: 60000, pollInterval: 50 });
                    setTimeout(() => {
                        extra.taskStore
                            .storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: 'done' }] })
                            .catch(() => {});
                    }, duration);
                    return { task };
                },
                async getTask(_args, extra) {
                    return await extra.taskStore.getTask(extra.taskId);
                },
                async getTaskResult(_args, extra) {
                    return (await extra.taskStore.getTaskResult(extra.taskId)) as { content: Array<{ type: 'text'; text: string }> };
                }
            }
        );

        mcpServer.experimental.tasks.registerToolTask(
            'input-task',
            { description: 'Asks the client for input', inputSchema: {} },
            {
                async createTask(_args, extra) {
                    const task = await extra.taskStore.createTask({ ttl: 60000, pollInterval: 50 });
                    (async () => {
                        const answer = await extra.sendRequest(
                            {
                                method: 'elicitation/create',
                                params: {
                                    mode: 'form',
                                    message: 'input for the first session',
                                    requestedSchema: { type: 'object', properties: { value: { type: 'string' } } }
                                }
                            },
                            ElicitResultSchema,
                            { relatedTask: { taskId: task.taskId } } as unknown as TaskRequestOptions
                        );
                        await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                            content: [{ type: 'text', text: String(answer.content?.value) }]
                        });
                    })().catch(() => {});
                    return { task };
                },
                async getTask(_args, extra) {
                    return await extra.taskStore.getTask(extra.taskId);
                },
                async getTaskResult(_args, extra) {
                    return (await extra.taskStore.getTaskResult(extra.taskId)) as { content: Array<{ type: 'text'; text: string }> };
                }
            }
        );

        return mcpServer;
    }

    beforeEach(async () => {
        taskStore = new InMemoryTaskStore();
        taskMessageQueue = new InMemoryTaskMessageQueue();
        sessions = new Map();

        // One server and transport per session, sharing one task store and queue.
        httpServer = createServer(async (req, res) => {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            const existing = sessionId ? sessions.get(sessionId) : undefined;
            if (existing) {
                await existing.transport.handleRequest(req, res);
                return;
            }
            const mcpServer = createMcpServer(taskMessageQueue);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: id => {
                    sessions.set(id, { mcpServer, transport });
                }
            });
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res);
        });
        baseUrl = await listenOnRandomPort(httpServer);
    });

    afterEach(async () => {
        for (const transport of openTransports.splice(0)) {
            await transport.close().catch(() => {});
        }
        for (const { mcpServer } of sessions.values()) {
            await mcpServer.close().catch(() => {});
        }
        taskStore.cleanup();
        httpServer.close();
    });

    async function connect(onElicit?: (message: string) => void): Promise<Client> {
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });
        client.setRequestHandler(ElicitRequestSchema, async elicit => {
            onElicit?.(elicit.params.message);
            return { action: 'accept' as const, content: { value: 'answer' } };
        });
        const transport = new StreamableHTTPClientTransport(baseUrl);
        openTransports.push(transport);
        await client.connect(transport);
        return client;
    }

    async function startTask(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
        const created = await client.request(
            { method: 'tools/call', params: { name, arguments: args, task: { ttl: 60000 } } },
            CreateTaskResultSchema
        );
        return created.task.taskId;
    }

    function relatedTo(taskId: string) {
        return { _meta: { [RELATED_TASK_META_KEY]: { taskId } } };
    }

    async function nextQueuedMessage(taskId: string): Promise<QueuedMessage> {
        return await vi.waitFor(async () => {
            const message = await taskMessageQueue.dequeue(taskId);
            expect(message).toBeDefined();
            return message!;
        });
    }

    it('lists only the tasks created in the same session', async () => {
        const first = await connect();
        const second = await connect();
        const firstTaskId = await startTask(first, 'slow-task');
        const secondTaskId = await startTask(second, 'slow-task');

        expect((await first.experimental.tasks.listTasks()).tasks.map(t => t.taskId)).toEqual([firstTaskId]);
        expect((await second.experimental.tasks.listTasks()).tasks.map(t => t.taskId)).toEqual([secondTaskId]);
    });

    it('answers tasks/get, tasks/result and tasks/cancel with not found for a task of another session', async () => {
        const first = await connect();
        const second = await connect();
        const taskId = await startTask(first, 'slow-task', { duration: 300 });

        await expect(second.experimental.tasks.getTask(taskId)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
        await expect(second.experimental.tasks.cancelTask(taskId)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
        await expect(second.request({ method: 'tasks/result', params: { taskId } }, CallToolResultSchema)).rejects.toMatchObject({
            code: ErrorCode.InvalidParams
        });

        expect((await first.experimental.tasks.getTask(taskId)).status).toBe('working');
        const result = await first.request({ method: 'tasks/result', params: { taskId } }, CallToolResultSchema);
        expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    });

    it('delivers queued requests of a task only to the session that created it', async () => {
        const firstMessages: string[] = [];
        const secondMessages: string[] = [];
        const first = await connect(message => firstMessages.push(message));
        const second = await connect(message => secondMessages.push(message));
        const taskId = await startTask(first, 'input-task');
        await waitForTaskStatus(id => taskStore.getTask(id), taskId, 'input_required');

        await expect(second.request({ method: 'tasks/result', params: { taskId } }, CallToolResultSchema)).rejects.toMatchObject({
            code: ErrorCode.InvalidParams
        });
        expect(secondMessages).toEqual([]);

        const result = await first.request({ method: 'tasks/result', params: { taskId } }, CallToolResultSchema);
        expect(firstMessages).toEqual(['input for the first session']);
        expect(result.content).toEqual([{ type: 'text', text: 'answer' }]);
    });

    it('queues the reply to a request related to a task only for the session that created the task', async () => {
        const first = await connect();
        const second = await connect();
        const taskId = await startTask(first, 'input-task');
        await waitForTaskStatus(id => taskStore.getTask(id), taskId, 'input_required');

        const notFound = { code: ErrorCode.InvalidParams, message: expect.stringContaining('Task not found') };
        await expect(
            second.request({ method: 'tools/list', params: relatedTo(taskId) }, ListToolsResultSchema, { timeout: 1000 })
        ).rejects.toMatchObject(notFound);
        await expect(
            second.request({ method: 'tools/list', params: relatedTo('no-such-task') }, ListToolsResultSchema, { timeout: 1000 })
        ).rejects.toMatchObject(notFound);
        expect((await taskMessageQueue.dequeueAll(taskId)).map(message => message.type)).toEqual(['request']);

        first.request({ method: 'tools/list', params: relatedTo(taskId) }, ListToolsResultSchema).catch(() => {});
        expect(await nextQueuedMessage(taskId)).toMatchObject({ type: 'response', message: { result: { tools: expect.any(Array) } } });
    });

    it('queues the reply for a method without a handler only for the session that created the related task', async () => {
        const first = await connect();
        const second = await connect();
        const taskId = await startTask(first, 'input-task');
        await waitForTaskStatus(id => taskStore.getTask(id), taskId, 'input_required');

        await expect(
            second.request({ method: 'resources/list', params: relatedTo(taskId) }, ListResourcesResultSchema, { timeout: 1000 })
        ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
        expect((await taskMessageQueue.dequeueAll(taskId)).map(message => message.type)).toEqual(['request']);

        first.request({ method: 'resources/list', params: relatedTo(taskId) }, ListResourcesResultSchema).catch(() => {});
        expect(await nextQueuedMessage(taskId)).toMatchObject({ type: 'error', message: { error: { code: ErrorCode.MethodNotFound } } });
    });

    it('passes the session id of the connection to the message queue when it reads, writes and clears the queue of a task', async () => {
        const enqueue = vi.spyOn(taskMessageQueue, 'enqueue');
        const dequeue = vi.spyOn(taskMessageQueue, 'dequeue');
        const dequeueAll = vi.spyOn(taskMessageQueue, 'dequeueAll');
        const first = await connect();
        const sessionId = first.transport?.sessionId;
        expect(sessionId).toBeDefined();

        const taskId = await startTask(first, 'input-task');
        await waitForTaskStatus(id => taskStore.getTask(id), taskId, 'input_required');
        await first.request({ method: 'tasks/result', params: { taskId } }, CallToolResultSchema);
        await first.experimental.tasks.cancelTask(await startTask(first, 'slow-task', { duration: 300 }));

        expect(enqueue.mock.calls.map(call => call[2])).toEqual([sessionId]);
        expect(new Set(dequeue.mock.calls.map(call => call[1]))).toEqual(new Set([sessionId]));
        expect(dequeueAll.mock.calls.map(call => call[1])).toEqual([sessionId, sessionId]);
    });
});

describe('Requests related to a task on a connection without a session', () => {
    it('queues the reply for the related task, whether or not the task store has the task', async () => {
        const taskStore = new InMemoryTaskStore();
        const taskMessageQueue = new InMemoryTaskMessageQueue();
        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { taskStore, taskMessageQueue });
        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        const task = await taskStore.createTask({}, 1, request);

        for (const taskId of [task.taskId, 'not-in-the-store']) {
            const _meta = { [RELATED_TASK_META_KEY]: { taskId } };
            client.request({ method: 'ping', params: { _meta } }, EmptyResultSchema).catch(() => {});
            await vi.waitFor(async () => expect(await taskMessageQueue.dequeue(taskId)).toMatchObject({ type: 'response' }));
        }

        await client.close();
        await server.close();
        taskStore.cleanup();
    });
});

describe('Task requests on a connection with a session', () => {
    const sessionId = 'session-a';
    let taskStore: InMemoryTaskStore;
    let taskMessageQueue: InMemoryTaskMessageQueue;
    let server: McpServer;
    let client: Client;
    let serverTransport: InMemoryTransport;

    beforeEach(async () => {
        taskStore = new InMemoryTaskStore();
        taskMessageQueue = new InMemoryTaskMessageQueue();
        server = new McpServer({ name: 'test-server', version: '1.0.0' }, { taskStore, taskMessageQueue });
        client = new Client({ name: 'test-client', version: '1.0.0' });
        const [clientTransport, linkedTransport] = InMemoryTransport.createLinkedPair();
        serverTransport = linkedTransport;
        serverTransport.sessionId = sessionId;
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    });

    afterEach(async () => {
        vi.useRealTimers();
        await client.close();
        await server.close();
        taskStore.cleanup();
    });

    it('does not start the handler of a request that was cancelled while its related task was looked up', async () => {
        const handler = vi.fn(async () => ({}));
        server.server.setRequestHandler(PingRequestSchema, handler);
        const task = await taskStore.createTask({}, 1, request, sessionId);
        const enqueue = vi.spyOn(taskMessageQueue, 'enqueue');
        const send = vi.spyOn(serverTransport, 'send');

        // The first getTask call, the lookup of the related task, stays pending until finishLookup() is called.
        let finishLookup!: () => void;
        const lookupGate = new Promise<void>(resolve => {
            finishLookup = resolve;
        });
        const getTask = taskStore.getTask.bind(taskStore);
        const lookup = vi.spyOn(taskStore, 'getTask').mockImplementationOnce(async (taskId, session) => {
            await lookupGate;
            return await getTask(taskId, session);
        });

        const controller = new AbortController();
        const _meta = { [RELATED_TASK_META_KEY]: { taskId: task.taskId } };
        const pending = client.request({ method: 'ping', params: { _meta } }, EmptyResultSchema, { signal: controller.signal });
        await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith(task.taskId, sessionId));
        controller.abort();
        await expect(pending).rejects.toBeDefined();

        finishLookup();
        await lookup.mock.results[0].value;
        // Let the rest of the request chain run before checking that nothing happened.
        await new Promise(resolve => setImmediate(resolve));

        expect(handler).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    it('passes the session id of the request to the task store while tasks/result waits for the task', async () => {
        vi.useFakeTimers();
        const task = await taskStore.createTask({ pollInterval: 50 }, 1, request, sessionId);
        const getTask = vi.spyOn(taskStore, 'getTask');

        const result = client.request({ method: 'tasks/result', params: { taskId: task.taskId } }, CallToolResultSchema);
        await vi.advanceTimersByTimeAsync(50);
        await taskStore.storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: 'done' }] }, sessionId);
        await vi.advanceTimersByTimeAsync(50);

        expect((await result).content).toEqual([{ type: 'text', text: 'done' }]);
        expect(new Set(getTask.mock.calls.map(call => call[1]))).toEqual(new Set([sessionId]));
    });
});
