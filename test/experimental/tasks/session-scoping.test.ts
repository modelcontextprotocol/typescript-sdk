import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '../../../src/client/index.js';
import { StreamableHTTPClientTransport } from '../../../src/client/streamableHttp.js';
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from '../../../src/experimental/tasks/stores/in-memory.js';
import { McpServer } from '../../../src/server/mcp.js';
import { StreamableHTTPServerTransport } from '../../../src/server/streamableHttp.js';
import type { TaskRequestOptions } from '../../../src/shared/protocol.js';
import { CallToolResultSchema, CreateTaskResultSchema, ElicitRequestSchema, ElicitResultSchema, ErrorCode } from '../../../src/types.js';
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

    it('lists only the tasks of the calling session', async () => {
        const a1 = await store.createTask({}, 1, request, 'session-a');
        const a2 = await store.createTask({}, 2, request, 'session-a');
        const b1 = await store.createTask({}, 3, request, 'session-b');
        await store.createTask({}, 4, request);

        expect((await store.listTasks(undefined, 'session-a')).tasks.map(t => t.taskId)).toEqual([a1.taskId, a2.taskId]);
        expect((await store.listTasks(undefined, 'session-b')).tasks.map(t => t.taskId)).toEqual([b1.taskId]);
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

    it('returns a task created without a sessionId to any session that has its id', async () => {
        const task = await store.createTask({}, 1, request);

        expect((await store.getTask(task.taskId, 'session-a'))?.taskId).toBe(task.taskId);
        expect((await store.listTasks(undefined, 'session-a')).tasks).toEqual([]);
    });
});

describe('Task session scoping over Streamable HTTP', () => {
    let httpServer: Server;
    let baseUrl: URL;
    let taskStore: InMemoryTaskStore;
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
        const taskMessageQueue = new InMemoryTaskMessageQueue();
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
});
