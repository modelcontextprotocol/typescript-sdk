import type { CallToolResult, ContentBlock, JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates an McpServer with task streaming capabilities and connects it
 * to an InMemoryTransport pair. Returns the server, transport, and task store.
 */
async function createStreamingServer(options?: { streamPartial?: boolean; clientStreamingCapability?: boolean }) {
    const { streamPartial = true, clientStreamingCapability = true } = options ?? {};

    const taskStore = new InMemoryTaskStore();
    const mcpServer = new McpServer(
        { name: 'test-server', version: '1.0.0' },
        {
            capabilities: {
                tasks: {
                    requests: { tools: { call: {} } },
                    list: {},
                    cancel: {},
                    taskStore,
                    taskMessageQueue: new InMemoryTaskMessageQueue()
                }
            }
        }
    );

    // Register a tool with streamPartial to declare the capability
    mcpServer.experimental.tasks.registerToolTask(
        'streaming-tool',
        {
            description: 'A tool that streams partial results',
            inputSchema: z.object({ prompt: z.string() }),
            execution: { taskSupport: 'required', streamPartial }
        },
        {
            async createTask(_args, ctx) {
                const task = await ctx.task.store.createTask({ ttl: 60_000 });
                return { task };
            },
            async getTask(_args, ctx) {
                const task = await ctx.task.store.getTask(ctx.task.id);
                if (!task) throw new Error(`Task ${ctx.task.id} not found`);
                return task;
            },
            async getTaskResult(_args, ctx) {
                return (await ctx.task.store.getTaskResult(ctx.task.id)) as CallToolResult;
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await clientTransport.start();

    // Collect messages from the server
    const messages: JSONRPCMessage[] = [];
    clientTransport.onmessage = msg => messages.push(msg);

    // Perform initialize handshake
    const clientTasksCapability = clientStreamingCapability ? { streaming: { partial: {} } } : {};

    await clientTransport.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {
                tasks: clientTasksCapability
            },
            clientInfo: { name: 'test-client', version: '1.0.0' }
        }
    } as JSONRPCMessage);

    // Wait for initialize response
    await vi.waitFor(() => expect(messages.some(m => 'id' in m && m.id === 1)).toBe(true));

    // Send initialized notification
    await clientTransport.send({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    } as JSONRPCMessage);

    return { mcpServer, clientTransport, serverTransport, taskStore, messages };
}

/**
 * Creates a task via tools/call and returns the taskId.
 */
async function createTaskViaToolCall(
    clientTransport: InMemoryTransport,
    messages: JSONRPCMessage[],
    toolName: string = 'streaming-tool',
    requestId: number = 2
): Promise<string> {
    await clientTransport.send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
            name: toolName,
            arguments: { prompt: 'test' },
            task: { ttl: 60_000 }
        }
    } as JSONRPCMessage);

    await vi.waitFor(() => expect(messages.some(m => 'id' in m && m.id === requestId)).toBe(true));

    const response = messages.find(m => 'id' in m && m.id === requestId) as {
        result?: { task?: { taskId?: string } };
    };
    const taskId = response?.result?.task?.taskId;
    if (!taskId) throw new Error('Failed to create task');
    return taskId;
}

// ---------------------------------------------------------------------------
// 8.1 — Server method tests (Requirements 13.1–13.5)
// ---------------------------------------------------------------------------

describe('sendTaskPartial', () => {
    it('sends a JSON-RPC notification with method notifications/tasks/partial and correct params', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        // Clear messages to isolate the partial notification
        messages.length = 0;

        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'hello' }], 0);

        await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));

        const notification = messages.find(m => 'method' in m && m.method === 'notifications/tasks/partial') as
            | { method: string; params: { taskId: string; content: unknown[]; seq: number } }
            | undefined;

        expect(notification).toBeDefined();
        expect(notification!.params.taskId).toBe(taskId);
        expect(notification!.params.content).toEqual([{ type: 'text', text: 'hello' }]);
        expect(notification!.params.seq).toBe(0);

        await mcpServer.close();
    });

    it('rejects empty content arrays with an error', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [], 0)).rejects.toThrow('Invalid TaskPartialNotificationParams');

        await mcpServer.close();
    });

    it('rejects negative seq values with an error', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'hello' }], -1)).rejects.toThrow(
            'Invalid TaskPartialNotificationParams'
        );

        await mcpServer.close();
    });

    it('rejects non-integer seq values with an error', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'hello' }], 1.5)).rejects.toThrow(
            'Invalid TaskPartialNotificationParams'
        );

        await mcpServer.close();
    });

    it('rejects empty taskId via Zod validation', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer();
        await createTaskViaToolCall(clientTransport, messages);

        await expect(mcpServer.experimental.tasks.sendTaskPartial('', [{ type: 'text', text: 'hello' }], 0)).rejects.toThrow(
            'Invalid TaskPartialNotificationParams'
        );

        await mcpServer.close();
    });

    it('throws when called for a task in terminal status (completed)', async () => {
        const { mcpServer, messages, clientTransport, taskStore } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        await taskStore.updateTaskStatus(taskId, 'completed');

        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'hello' }], 0)).rejects.toThrow(
            /terminal status/
        );

        await mcpServer.close();
    });

    it('throws when called for a task in terminal status (failed)', async () => {
        const { mcpServer, messages, clientTransport, taskStore } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        await taskStore.updateTaskStatus(taskId, 'failed');

        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'hello' }], 0)).rejects.toThrow(
            /terminal status/
        );

        await mcpServer.close();
    });

    it('throws when called for a task in terminal status (cancelled)', async () => {
        const { mcpServer, messages, clientTransport, taskStore } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        await taskStore.updateTaskStatus(taskId, 'cancelled');

        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'hello' }], 0)).rejects.toThrow(
            /terminal status/
        );

        await mcpServer.close();
    });

    it('throws when server has not declared tasks.streaming.partial capability', async () => {
        const taskStore = new InMemoryTaskStore();
        const mcpServer = new McpServer(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {
                    tasks: {
                        requests: { tools: { call: {} } },
                        list: {},
                        taskStore,
                        taskMessageQueue: new InMemoryTaskMessageQueue()
                    }
                }
            }
        );

        // Register a tool WITHOUT streamPartial (no streaming capability declared)
        mcpServer.experimental.tasks.registerToolTask(
            'non-streaming-tool',
            {
                description: 'A tool without streaming',
                inputSchema: z.object({ prompt: z.string() }),
                execution: { taskSupport: 'required' }
            },
            {
                async createTask(_args, ctx) {
                    const task = await ctx.task.store.createTask({ ttl: 60_000 });
                    return { task };
                },
                async getTask(_args, ctx) {
                    const task = await ctx.task.store.getTask(ctx.task.id);
                    if (!task) throw new Error(`Task ${ctx.task.id} not found`);
                    return task;
                },
                async getTaskResult(_args, ctx) {
                    return (await ctx.task.store.getTaskResult(ctx.task.id)) as CallToolResult;
                }
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        await clientTransport.start();

        const messages: JSONRPCMessage[] = [];
        clientTransport.onmessage = msg => messages.push(msg);

        // Initialize with client streaming capability
        await clientTransport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: { tasks: { streaming: { partial: {} } } },
                clientInfo: { name: 'test-client', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await vi.waitFor(() => expect(messages.some(m => 'id' in m && m.id === 1)).toBe(true));
        await clientTransport.send({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
        } as JSONRPCMessage);

        // Create a task via the non-streaming tool
        const taskId = await createTaskViaToolCall(clientTransport, messages, 'non-streaming-tool');

        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'hello' }], 0)).rejects.toThrow(
            /tasks\.streaming\.partial capability/
        );

        await mcpServer.close();
    });

    it('is a no-op when client lacks tasks.streaming.partial capability', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer({
            clientStreamingCapability: false
        });
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        // Clear messages
        messages.length = 0;

        // Should not throw, but also should not send a notification
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'hello' }], 0);

        // Give a moment for any async message delivery
        await new Promise(resolve => setTimeout(resolve, 50));

        const partialNotifications = messages.filter(m => 'method' in m && m.method === 'notifications/tasks/partial');
        expect(partialNotifications).toHaveLength(0);

        await mcpServer.close();
    });

    it('allows sending partials for tasks in working status', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        // Should not throw — task is in 'working' status by default
        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'chunk' }], 0)).resolves.toBeUndefined();

        await mcpServer.close();
    });

    it('allows sending partials for tasks in input_required status', async () => {
        const { mcpServer, messages, clientTransport, taskStore } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        // Move task to input_required (non-terminal)
        await taskStore.updateTaskStatus(taskId, 'input_required');

        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'chunk' }], 0)).resolves.toBeUndefined();

        await mcpServer.close();
    });
});

// ---------------------------------------------------------------------------
// createPartialEmitter tests (Requirements 13.6, 13.7)
// ---------------------------------------------------------------------------

describe('createPartialEmitter', () => {
    it('returns a function that sends partials with auto-incrementing seq starting at 0', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        messages.length = 0;

        const emitPartial = mcpServer.experimental.tasks.createPartialEmitter(taskId);

        await emitPartial([{ type: 'text', text: 'chunk-0' }]);
        await emitPartial([{ type: 'text', text: 'chunk-1' }]);
        await emitPartial([{ type: 'text', text: 'chunk-2' }]);

        await vi.waitFor(() => {
            const partials = messages.filter(m => 'method' in m && m.method === 'notifications/tasks/partial');
            expect(partials).toHaveLength(3);
        });

        const partials = messages
            .filter(m => 'method' in m && m.method === 'notifications/tasks/partial')
            .map(m => (m as unknown as { params: { seq: number; content: unknown[] } }).params);

        expect(partials[0]!.seq).toBe(0);
        expect(partials[1]!.seq).toBe(1);
        expect(partials[2]!.seq).toBe(2);

        expect(partials[0]!.content).toEqual([{ type: 'text', text: 'chunk-0' }]);
        expect(partials[1]!.content).toEqual([{ type: 'text', text: 'chunk-1' }]);
        expect(partials[2]!.content).toEqual([{ type: 'text', text: 'chunk-2' }]);

        await mcpServer.close();
    });

    it('each emitter has its own independent seq counter', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer();

        // Create two tasks
        const taskId1 = await createTaskViaToolCall(clientTransport, messages, 'streaming-tool', 2);
        const taskId2 = await createTaskViaToolCall(clientTransport, messages, 'streaming-tool', 3);

        messages.length = 0;

        const emitter1 = mcpServer.experimental.tasks.createPartialEmitter(taskId1);
        const emitter2 = mcpServer.experimental.tasks.createPartialEmitter(taskId2);

        await emitter1([{ type: 'text', text: 'a' }]);
        await emitter2([{ type: 'text', text: 'b' }]);
        await emitter1([{ type: 'text', text: 'c' }]);

        await vi.waitFor(() => {
            const partials = messages.filter(m => 'method' in m && m.method === 'notifications/tasks/partial');
            expect(partials).toHaveLength(3);
        });

        const partials = messages
            .filter(m => 'method' in m && m.method === 'notifications/tasks/partial')
            .map(m => (m as unknown as { params: { taskId: string; seq: number } }).params);

        // emitter1 should have seq 0, 1
        const emitter1Partials = partials.filter(p => p.taskId === taskId1);
        expect(emitter1Partials.map(p => p.seq)).toEqual([0, 1]);

        // emitter2 should have seq 0
        const emitter2Partials = partials.filter(p => p.taskId === taskId2);
        expect(emitter2Partials.map(p => p.seq)).toEqual([0]);

        await mcpServer.close();
    });
});

// ---------------------------------------------------------------------------
// registerToolTask capability declaration tests
// ---------------------------------------------------------------------------

describe('registerToolTask capability declaration', () => {
    it('registers tasks.streaming.partial capability when streamPartial is true', () => {
        const taskStore = new InMemoryTaskStore();
        const mcpServer = new McpServer(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {
                    tasks: {
                        requests: { tools: { call: {} } },
                        list: {},
                        taskStore,
                        taskMessageQueue: new InMemoryTaskMessageQueue()
                    }
                }
            }
        );

        mcpServer.experimental.tasks.registerToolTask(
            'streaming-tool',
            {
                description: 'Streams partial results',
                inputSchema: z.object({ prompt: z.string() }),
                execution: { taskSupport: 'required', streamPartial: true }
            },
            {
                async createTask(_args, ctx) {
                    const task = await ctx.task.store.createTask({ ttl: 60_000 });
                    return { task };
                },
                async getTask(_args, ctx) {
                    const task = await ctx.task.store.getTask(ctx.task.id);
                    if (!task) throw new Error('not found');
                    return task;
                },
                async getTaskResult(_args, ctx) {
                    return (await ctx.task.store.getTaskResult(ctx.task.id)) as CallToolResult;
                }
            }
        );

        const capabilities = mcpServer.server.getCapabilities();
        expect(capabilities.tasks?.streaming?.partial).toBeDefined();
    });

    it('does not register streaming capability when streamPartial is not set', () => {
        const taskStore = new InMemoryTaskStore();
        const mcpServer = new McpServer(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {
                    tasks: {
                        requests: { tools: { call: {} } },
                        list: {},
                        taskStore,
                        taskMessageQueue: new InMemoryTaskMessageQueue()
                    }
                }
            }
        );

        mcpServer.experimental.tasks.registerToolTask(
            'non-streaming-tool',
            {
                description: 'No streaming',
                inputSchema: z.object({ prompt: z.string() }),
                execution: { taskSupport: 'required' }
            },
            {
                async createTask(_args, ctx) {
                    const task = await ctx.task.store.createTask({ ttl: 60_000 });
                    return { task };
                },
                async getTask(_args, ctx) {
                    const task = await ctx.task.store.getTask(ctx.task.id);
                    if (!task) throw new Error('not found');
                    return task;
                },
                async getTaskResult(_args, ctx) {
                    return (await ctx.task.store.getTaskResult(ctx.task.id)) as CallToolResult;
                }
            }
        );

        const capabilities = mcpServer.server.getCapabilities();
        expect(capabilities.tasks?.streaming).toBeUndefined();
    });

    it('does not register streaming capability when streamPartial is false', () => {
        const taskStore = new InMemoryTaskStore();
        const mcpServer = new McpServer(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {
                    tasks: {
                        requests: { tools: { call: {} } },
                        list: {},
                        taskStore,
                        taskMessageQueue: new InMemoryTaskMessageQueue()
                    }
                }
            }
        );

        mcpServer.experimental.tasks.registerToolTask(
            'non-streaming-tool',
            {
                description: 'No streaming',
                inputSchema: z.object({ prompt: z.string() }),
                execution: { taskSupport: 'required', streamPartial: false }
            },
            {
                async createTask(_args, ctx) {
                    const task = await ctx.task.store.createTask({ ttl: 60_000 });
                    return { task };
                },
                async getTask(_args, ctx) {
                    const task = await ctx.task.store.getTask(ctx.task.id);
                    if (!task) throw new Error('not found');
                    return task;
                },
                async getTaskResult(_args, ctx) {
                    return (await ctx.task.store.getTaskResult(ctx.task.id)) as CallToolResult;
                }
            }
        );

        const capabilities = mcpServer.server.getCapabilities();
        expect(capabilities.tasks?.streaming).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 8.2 — Property test: Emitter seq auto-increment (Property 2)
// ---------------------------------------------------------------------------

// Feature: task-streaming-partial-results-sdk, Property 2: Emitter seq auto-increment
describe('Property 2: Emitter seq auto-increment', () => {
    it('for any N calls, the emitter produces seq values [0, 1, ..., N-1]', async () => {
        const { mcpServer, messages, clientTransport } = await createStreamingServer();
        const taskId = await createTaskViaToolCall(clientTransport, messages);

        // Spy on sendTaskPartial to capture seq values without relying on transport timing
        const capturedSeqs: number[] = [];
        const originalSendTaskPartial = mcpServer.experimental.tasks.sendTaskPartial.bind(mcpServer.experimental.tasks);
        mcpServer.experimental.tasks.sendTaskPartial = async (tid: string, content: ContentBlock[], seq: number) => {
            capturedSeqs.push(seq);
            return originalSendTaskPartial(tid, content, seq);
        };

        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async n => {
                capturedSeqs.length = 0;
                const emitter = mcpServer.experimental.tasks.createPartialEmitter(taskId);

                for (let i = 0; i < n; i++) {
                    await emitter([{ type: 'text' as const, text: `chunk-${i}` }]);
                }

                const expected = Array.from({ length: n }, (_, i) => i);
                expect(capturedSeqs).toEqual(expected);
            }),
            { numRuns: 100 }
        );

        await mcpServer.close();
    });
});
