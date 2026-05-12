import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, CreateTaskResult } from '@modelcontextprotocol/core';
import {
    CallToolResultSchema,
    CancelTaskResultSchema,
    GetTaskPayloadResultSchema,
    GetTaskResultSchema,
    pollTask,
    ProtocolError,
    ProtocolErrorCode,
    taskContext,
    tasksPlugin
} from '@modelcontextprotocol/core';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { InMemoryTaskStore, McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import * as z from 'zod/v4';

// Rewritten for SEP-2663 (server-directed model, tasksPlugin via use()).
//
// The 2025-11 suites that exercised the TaskMessageQueue / relatedTask queueing,
// callToolStream, and server-polls-client elicitation (Multiple Queued Messages,
// Continuous Message Delivery, Input Required Flow, callToolStream*) tested the
// interception machinery F3 removes. Under SEP-2663 the handler returns
// `{resultType:'task', task}` itself; there is no inbound/outbound rewriting and
// no message queue. Server-initiated elicitation during a task uses the
// backchannel (R4) or MRTR (S3/F4), not the task store. Those suites are deleted
// here, not skipped, because the mechanism does not exist anymore.

describe('Task Lifecycle (tasksPlugin)', () => {
    let httpServer: Server;
    let mcp: McpServer;
    let serverTransport: NodeStreamableHTTPServerTransport;
    let baseUrl: URL;
    let store: InMemoryTaskStore;

    beforeEach(async () => {
        store = new InMemoryTaskStore();
        mcp = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {}, tasks: { list: {}, cancel: {} } } });
        mcp.use(tasksPlugin({ store }));

        mcp.registerTool(
            'long-task',
            {
                title: 'Long Running Task',
                inputSchema: z.object({
                    duration: z.number().default(50),
                    shouldFail: z.boolean().default(false)
                })
            },
            async ({ duration, shouldFail }, ctx): Promise<CallToolResult | CreateTaskResult> => {
                const tc = taskContext(ctx)!;
                const task = await tc.store.createTask({ ttl: 60_000, pollInterval: 50 });
                void (async () => {
                    await new Promise(r => setTimeout(r, duration));
                    try {
                        await (shouldFail
                            ? tc.store.storeTaskResult(task.taskId, 'failed', {
                                  content: [{ type: 'text', text: 'Task failed as requested' }],
                                  isError: true
                              })
                            : tc.store.storeTaskResult(task.taskId, 'completed', {
                                  content: [{ type: 'text', text: `Completed after ${duration}ms` }]
                              }));
                    } catch {
                        // Task may have been cleaned up if test ended.
                    }
                })();
                return { resultType: 'task', task };
            }
        );

        serverTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        await mcp.connect(serverTransport);
        httpServer = createServer(async (req, res) => {
            await serverTransport.handleRequest(req, res);
        });
        baseUrl = await listenOnRandomPort(httpServer);
    });

    afterEach(async () => {
        store.cleanup();
        await mcp.close().catch(() => {});
        await serverTransport.close().catch(() => {});
        httpServer.close();
    });

    async function newClient(): Promise<Client> {
        const client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        return client;
    }

    const getTask = (c: Client, taskId: string) => c.request({ method: 'tasks/get', params: { taskId } }, GetTaskResultSchema);
    const getTaskResult = (c: Client, taskId: string) =>
        c.request({ method: 'tasks/result', params: { taskId } }, GetTaskPayloadResultSchema);
    const cancelTask = (c: Client, taskId: string) => c.request({ method: 'tasks/cancel', params: { taskId } }, CancelTaskResultSchema);

    describe('Task creation and completion', () => {
        it('returns {resultType:task} from a task-returning tool', async () => {
            const client = await newClient();
            const r = (await client.callTool({ name: 'long-task', arguments: { duration: 30 } })) as CreateTaskResult;
            expect(r.resultType).toBe('task');
            expect(r.task.taskId).toBeTruthy();
            expect(r.task.status).toBe('working');
            await client.close();
        });

        it('pollTask resolves with the stored result', async () => {
            const client = await newClient();
            const r = (await client.callTool({ name: 'long-task', arguments: { duration: 30 } })) as CreateTaskResult;
            const result = await pollTask(client, r.task.taskId, CallToolResultSchema, { maxTotalTimeout: 5000 });
            expect(result.content).toEqual([{ type: 'text', text: 'Completed after 30ms' }]);
            await client.close();
        });

        it('failed task surfaces the stored isError result', async () => {
            const client = await newClient();
            const r = (await client.callTool({
                name: 'long-task',
                arguments: { duration: 20, shouldFail: true }
            })) as CreateTaskResult;
            const result = await pollTask(client, r.task.taskId, CallToolResultSchema, { maxTotalTimeout: 5000 });
            expect(result.isError).toBe(true);
            expect(result.content).toEqual([{ type: 'text', text: 'Task failed as requested' }]);
            await client.close();
        });
    });

    describe('tasks/get and tasks/result', () => {
        it('tasks/get reflects status transitions', async () => {
            const client = await newClient();
            const r = (await client.callTool({ name: 'long-task', arguments: { duration: 80 } })) as CreateTaskResult;
            const t1 = await getTask(client, r.task.taskId);
            expect(['working', 'completed']).toContain(t1.status);
            await pollTask(client, r.task.taskId, CallToolResultSchema, { maxTotalTimeout: 5000 });
            const t2 = await getTask(client, r.task.taskId);
            expect(t2.status).toBe('completed');
            await client.close();
        });

        it('tasks/result rejects before terminal', async () => {
            const client = await newClient();
            const r = (await client.callTool({ name: 'long-task', arguments: { duration: 200 } })) as CreateTaskResult;
            await expect(getTaskResult(client, r.task.taskId)).rejects.toSatisfy(
                (e: ProtocolError) => e instanceof ProtocolError && e.code === ProtocolErrorCode.InvalidRequest
            );
            await client.close();
        });
    });

    describe('Task cancellation', () => {
        it('tasks/cancel transitions to cancelled and pollTask throws', async () => {
            const client = await newClient();
            const r = (await client.callTool({ name: 'long-task', arguments: { duration: 5000 } })) as CreateTaskResult;
            const cancelled = await cancelTask(client, r.task.taskId);
            expect(cancelled.status).toBe('cancelled');
            await expect(pollTask(client, r.task.taskId, CallToolResultSchema, { maxTotalTimeout: 2000 })).rejects.toThrow(/cancelled/);
            await client.close();
        });

        it('cancelling a terminal task is rejected', async () => {
            const client = await newClient();
            const r = (await client.callTool({ name: 'long-task', arguments: { duration: 20 } })) as CreateTaskResult;
            await pollTask(client, r.task.taskId, CallToolResultSchema, { maxTotalTimeout: 5000 });
            await expect(cancelTask(client, r.task.taskId)).rejects.toSatisfy(
                (e: ProtocolError) => e instanceof ProtocolError && e.code === ProtocolErrorCode.InvalidParams
            );
            await client.close();
        });
    });

    describe('Concurrent tasks', () => {
        it('multiple tasks complete independently', async () => {
            const client = await newClient();
            const created = await Promise.all(
                [20, 30, 40].map(d => client.callTool({ name: 'long-task', arguments: { duration: d } }) as Promise<CreateTaskResult>)
            );
            const results = await Promise.all(
                created.map(r => pollTask(client, r.task.taskId, CallToolResultSchema, { maxTotalTimeout: 5000 }))
            );
            expect(results.map(r => (r.content[0] as { text: string }).text)).toEqual([
                'Completed after 20ms',
                'Completed after 30ms',
                'Completed after 40ms'
            ]);
            await client.close();
        });
    });

    describe('Error handling', () => {
        it('tasks/get for unknown id is InvalidParams', async () => {
            const client = await newClient();
            await expect(getTask(client, 'nope')).rejects.toSatisfy(
                (e: ProtocolError) => e instanceof ProtocolError && e.code === ProtocolErrorCode.InvalidParams
            );
            await client.close();
        });
    });

    describe('Capabilities', () => {
        it('server with tasks capability declared advertises it; client tasks/* requests pass the gate', async () => {
            const client = await newClient();
            expect(client.getServerCapabilities()?.tasks).toBeTruthy();
            // tasks/get reaches the server (rejects on unknown id, not on capability)
            await expect(getTask(client, 'nonexistent')).rejects.toSatisfy(
                (e: unknown) => e instanceof ProtocolError && e.code === ProtocolErrorCode.InvalidParams
            );
            await client.close();
        });
    });
});

describe('Task capability gate (server without tasks)', () => {
    it('client tasks/* requests fail CapabilityNotSupported when server did not declare tasks', async () => {
        const mcp = new McpServer({ name: 'no-tasks', version: '1.0.0' }, { capabilities: { tools: {} } });
        const serverTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        await mcp.connect(serverTransport);
        const httpServer = createServer(async (req, res) => serverTransport.handleRequest(req, res));
        const baseUrl = await listenOnRandomPort(httpServer);

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { enforceStrictCapabilities: true });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));

        expect(client.getServerCapabilities()?.tasks).toBeUndefined();
        await expect(client.request({ method: 'tasks/get', params: { taskId: 'x' } }, GetTaskResultSchema)).rejects.toThrow(
            /does not support tasks/
        );

        await client.close();
        await mcp.close();
        httpServer.close();
    });
});
