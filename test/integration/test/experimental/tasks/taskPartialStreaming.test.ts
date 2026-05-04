import { Client } from '@modelcontextprotocol/client';
import type { CallToolResult, TaskPartialNotificationParams } from '@modelcontextprotocol/core';
import { InMemoryTransport } from '@modelcontextprotocol/core';
import { InMemoryTaskMessageQueue, InMemoryTaskStore, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deferred promise helper — creates a promise that can be resolved externally.
 */
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Creates a full McpServer + Client pair connected via InMemoryTransport,
 * with task streaming capabilities on both sides.
 *
 * The server registers a streaming tool. When `manualMode` is false (default),
 * the tool's background work emits partials and completes automatically.
 * When `manualMode` is true, the tool creates a task and waits for external
 * signal before completing — allowing the test to send partials manually.
 */
async function createStreamingEnvironment(options?: {
    serverStreamPartial?: boolean;
    clientStreamingCapability?: boolean;
    partialCount?: number;
    partialDelayMs?: number;
    manualMode?: boolean;
}) {
    const {
        serverStreamPartial = true,
        clientStreamingCapability = true,
        partialCount = 3,
        partialDelayMs = 10,
        manualMode = false
    } = options ?? {};

    const taskStore = new InMemoryTaskStore();

    // Signal for manual mode: test resolves this to let the background work complete
    const completeSignal = deferred<void>();

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

    // Register a streaming tool that emits partial results in background work
    mcpServer.experimental.tasks.registerToolTask(
        'streaming-tool',
        {
            description: 'A tool that streams partial results',
            inputSchema: z.object({
                prompt: z.string(),
                chunks: z.number().optional(),
                delayMs: z.number().optional()
            }),
            execution: { taskSupport: 'required', streamPartial: serverStreamPartial }
        },
        {
            async createTask({ prompt, chunks, delayMs }, ctx) {
                const task = await ctx.task.store.createTask({
                    ttl: 60_000,
                    pollInterval: 50
                });

                const numChunks = chunks ?? partialCount;
                const delay = delayMs ?? partialDelayMs;

                // Background work: emit partials then complete
                (async () => {
                    try {
                        if (manualMode) {
                            // In manual mode, wait for external signal before completing
                            await completeSignal.promise;
                        } else {
                            // Small initial delay to allow the test to subscribe before first partial
                            await new Promise(resolve => setTimeout(resolve, 20));

                            const emitPartial = mcpServer.experimental.tasks.createPartialEmitter(task.taskId);

                            const words = prompt.split(' ');
                            for (let i = 0; i < numChunks; i++) {
                                const word = words[i % words.length] ?? `chunk-${i}`;
                                await emitPartial([{ type: 'text', text: word }]);
                                if (delay > 0) {
                                    await new Promise(resolve => setTimeout(resolve, delay));
                                }
                            }
                        }

                        // Store the canonical result
                        if (!manualMode) {
                            await ctx.task.store.storeTaskResult(task.taskId, 'completed', {
                                content: [{ type: 'text', text: prompt }]
                            });
                        }
                    } catch {
                        // Task may have been cleaned up if test ended
                    }
                })();

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

    const clientCapabilities: Record<string, unknown> = {};
    if (clientStreamingCapability) {
        clientCapabilities.tasks = { streaming: { partial: {} } };
    }

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: clientCapabilities });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

    return { mcpServer, client, clientTransport, serverTransport, taskStore, completeSignal };
}

// ---------------------------------------------------------------------------
// 11.1 — End-to-end streaming integration tests (Requirements 15.1–15.5)
// ---------------------------------------------------------------------------

describe('Task Partial Streaming — End-to-End Integration', () => {
    it('should receive all partial notifications in correct seq order', async () => {
        const { mcpServer, client, taskStore } = await createStreamingEnvironment({
            partialCount: 5,
            partialDelayMs: 30
        });

        // Create a task via tools/call with task augmentation
        const createResult = await client.request({
            method: 'tools/call',
            params: {
                name: 'streaming-tool',
                arguments: { prompt: 'Hello world from streaming test words', chunks: 5, delayMs: 30 },
                task: { ttl: 60_000 }
            }
        });

        expect(createResult).toHaveProperty('task');
        const taskId = createResult.task.taskId;
        expect(taskId).toBeDefined();
        expect(createResult.task.status).toBe('working');

        // Subscribe to partials immediately after task creation
        const received: TaskPartialNotificationParams[] = [];
        const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
            received.push(params);
        });

        // Wait for task to complete (partials are sent during background work)
        await vi.waitFor(
            async () => {
                const task = await taskStore.getTask(taskId);
                expect(task?.status).toBe('completed');
            },
            { timeout: 10_000, interval: 50 }
        );

        // Verify all partials were received in correct seq order
        expect(received.length).toBe(5);
        for (const [i, partial] of received.entries()) {
            expect(partial.seq).toBe(i);
            expect(partial.taskId).toBe(taskId);
            expect(partial.content).toHaveLength(1);
            expect(partial.content[0]!.type).toBe('text');
        }

        // Verify seq values are strictly monotonically increasing
        for (const [i, partial] of received.entries()) {
            if (i > 0) {
                expect(partial.seq).toBeGreaterThan(received[i - 1]!.seq);
            }
        }

        cleanup();
        await mcpServer.close();
    }, 15_000);

    it('should return complete canonical result via tasks/result', async () => {
        const { mcpServer, client, taskStore } = await createStreamingEnvironment({
            partialCount: 3,
            partialDelayMs: 30
        });

        // Create a task
        const createResult = await client.request({
            method: 'tools/call',
            params: {
                name: 'streaming-tool',
                arguments: { prompt: 'The final canonical result', chunks: 3, delayMs: 30 },
                task: { ttl: 60_000 }
            }
        });

        const taskId = createResult.task.taskId;

        // Subscribe to partials
        const received: TaskPartialNotificationParams[] = [];
        const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
            received.push(params);
        });

        // Wait for completion
        await vi.waitFor(
            async () => {
                const task = await taskStore.getTask(taskId);
                expect(task?.status).toBe('completed');
            },
            { timeout: 10_000, interval: 50 }
        );

        // Retrieve the final result via tasks/result
        const result = await client.request({
            method: 'tasks/result',
            params: { taskId }
        });

        // Verify the canonical result is the complete text, independent of partials
        expect(result.content).toEqual([{ type: 'text', text: 'The final canonical result' }]);

        // Verify partials were received (they are incremental, not the full result)
        expect(received.length).toBe(3);

        // Verify partial content matches expected incremental output
        // The tool splits the prompt by spaces and cycles through words
        expect(received[0]!.content).toEqual([{ type: 'text', text: 'The' }]);
        expect(received[1]!.content).toEqual([{ type: 'text', text: 'final' }]);
        expect(received[2]!.content).toEqual([{ type: 'text', text: 'canonical' }]);

        cleanup();
        await mcpServer.close();
    }, 15_000);

    it('should complete full lifecycle: tool call → task created → partials → status completed → result', async () => {
        const { mcpServer, client, taskStore } = await createStreamingEnvironment({
            partialCount: 3,
            partialDelayMs: 30
        });

        const partials: TaskPartialNotificationParams[] = [];

        // Phase 1: Create task via tools/call with task augmentation
        const createResult = await client.request({
            method: 'tools/call',
            params: {
                name: 'streaming-tool',
                arguments: { prompt: 'lifecycle test words here', chunks: 3, delayMs: 30 },
                task: { ttl: 60_000 }
            }
        });

        // Phase 2: Verify task was created
        const taskId = createResult.task.taskId;
        expect(createResult.task.status).toBe('working');
        expect(createResult.task.ttl).toBe(60_000);
        expect(createResult.task.createdAt).toBeDefined();

        // Phase 3: Subscribe to partials
        const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
            partials.push(params);
        });

        // Phase 4: Wait for partials and completion
        await vi.waitFor(
            async () => {
                const task = await taskStore.getTask(taskId);
                expect(task?.status).toBe('completed');
            },
            { timeout: 10_000, interval: 50 }
        );

        // Phase 5: Verify partials were received
        expect(partials.length).toBe(3);
        expect(partials.map(p => p.seq)).toEqual([0, 1, 2]);

        // Phase 6: Verify task status is completed
        const task = await client.request({
            method: 'tasks/get',
            params: { taskId }
        });
        expect(task.status).toBe('completed');

        // Phase 7: Retrieve final result
        const result = await client.request({
            method: 'tasks/result',
            params: { taskId }
        });
        expect(result.content).toEqual([{ type: 'text', text: 'lifecycle test words here' }]);

        cleanup();
        await mcpServer.close();
    }, 15_000);

    it('should exchange streaming capabilities during initialize', async () => {
        const { mcpServer, client } = await createStreamingEnvironment();

        // Verify server capabilities include tasks.streaming.partial
        const serverCapabilities = mcpServer.server.getCapabilities();
        expect(serverCapabilities.tasks?.streaming?.partial).toBeDefined();

        // Verify client capabilities were received by the server
        const clientCapabilities = mcpServer.server.getClientCapabilities();
        expect(clientCapabilities?.tasks?.streaming?.partial).toBeDefined();

        // Verify the client received server capabilities (via getServerCapabilities)
        const receivedServerCaps = client.getServerCapabilities();
        expect(receivedServerCaps?.tasks?.streaming?.partial).toBeDefined();

        await mcpServer.close();
    });
});

// ---------------------------------------------------------------------------
// 11.2 — Edge case integration tests (Requirements 16.1–16.6)
// ---------------------------------------------------------------------------

describe('Task Partial Streaming — Edge Cases', () => {
    it('should discard duplicate seq values without error', async () => {
        const { mcpServer, client, completeSignal } = await createStreamingEnvironment({
            manualMode: true
        });

        const errors: Error[] = [];
        client.onerror = (err: Error) => errors.push(err);

        // Create a task (background work waits for completeSignal)
        const createResult = await client.request({
            method: 'tools/call',
            params: {
                name: 'streaming-tool',
                arguments: { prompt: 'dup test' },
                task: { ttl: 60_000 }
            }
        });

        const taskId = createResult.task.taskId;

        const received: TaskPartialNotificationParams[] = [];
        const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
            received.push(params);
        });

        // Manually send partials with duplicates via the server API
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'first' }], 0);
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'duplicate' }], 0);
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'second' }], 1);
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'dup-again' }], 1);
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'third' }], 2);

        // Wait for notifications to be delivered
        await vi.waitFor(() => expect(received.length).toBe(3), { timeout: 5000 });

        // Verify only non-duplicate notifications were delivered
        expect(received.map(r => r.seq)).toEqual([0, 1, 2]);
        expect(received[0]!.content).toEqual([{ type: 'text', text: 'first' }]);
        expect(received[1]!.content).toEqual([{ type: 'text', text: 'second' }]);
        expect(received[2]!.content).toEqual([{ type: 'text', text: 'third' }]);

        // No seq-related errors should have been reported for duplicates
        const seqErrors = errors.filter(e => e.message.includes('seq gap') || e.message.includes('first partial'));
        expect(seqErrors).toHaveLength(0);

        cleanup();
        completeSignal.resolve();
        await mcpServer.close();
    }, 10_000);

    it('should deliver notifications with seq gap and log a warning', async () => {
        const { mcpServer, client, completeSignal } = await createStreamingEnvironment({
            manualMode: true
        });

        const errors: Error[] = [];
        client.onerror = (err: Error) => errors.push(err);

        // Create a task
        const createResult = await client.request({
            method: 'tools/call',
            params: {
                name: 'streaming-tool',
                arguments: { prompt: 'gap test' },
                task: { ttl: 60_000 }
            }
        });

        const taskId = createResult.task.taskId;

        const received: TaskPartialNotificationParams[] = [];
        const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
            received.push(params);
        });

        // Send seq 0, then skip to seq 3 (gap of 1, 2)
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'a' }], 0);
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'b' }], 3);

        await vi.waitFor(() => expect(received.length).toBe(2), { timeout: 5000 });

        // Both should be delivered
        expect(received[0]!.seq).toBe(0);
        expect(received[1]!.seq).toBe(3);

        // A warning about the gap should have been logged
        expect(errors.some(e => e.message.includes('seq gap detected'))).toBe(true);

        // Subsequent sequential notifications should still work
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'c' }], 4);
        await vi.waitFor(() => expect(received.length).toBe(3), { timeout: 5000 });
        expect(received[2]!.seq).toBe(4);

        cleanup();
        completeSignal.resolve();
        await mcpServer.close();
    }, 10_000);

    it('should reject partial after terminal task status on the server', async () => {
        const { mcpServer, client, taskStore, completeSignal } = await createStreamingEnvironment({
            manualMode: true
        });

        // Create a task
        const createResult = await client.request({
            method: 'tools/call',
            params: {
                name: 'streaming-tool',
                arguments: { prompt: 'terminal test' },
                task: { ttl: 60_000 }
            }
        });

        const taskId = createResult.task.taskId;

        // Send one partial successfully
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'ok' }], 0);

        // Move task to terminal status
        await taskStore.storeTaskResult(taskId, 'completed', {
            content: [{ type: 'text', text: 'done' }]
        });

        // Attempting to send a partial after terminal status should throw
        await expect(mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'too late' }], 1)).rejects.toThrow(
            /terminal status/
        );

        completeSignal.resolve();
        await mcpServer.close();
    }, 10_000);

    it('should not send partials when server has streaming capability but client does not', async () => {
        const { mcpServer, client, completeSignal } = await createStreamingEnvironment({
            serverStreamPartial: true,
            clientStreamingCapability: false,
            manualMode: true
        });

        // Create a task
        const createResult = await client.request({
            method: 'tools/call',
            params: {
                name: 'streaming-tool',
                arguments: { prompt: 'no client cap' },
                task: { ttl: 60_000 }
            }
        });

        const taskId = createResult.task.taskId;

        const received: TaskPartialNotificationParams[] = [];
        client.experimental.tasks.subscribeTaskPartials(taskId, params => {
            received.push(params);
        });

        // sendTaskPartial should be a no-op (no error, but no notification sent)
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'ignored' }], 0);

        // Give time for any async delivery
        await new Promise(resolve => setTimeout(resolve, 100));

        // No partials should have been received
        expect(received).toHaveLength(0);

        completeSignal.resolve();
        await mcpServer.close();
    }, 10_000);

    it('should not fail when client has streaming capability but server does not', async () => {
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

        // Register a tool WITHOUT streamPartial (no streaming capability)
        mcpServer.experimental.tasks.registerToolTask(
            'non-streaming-tool',
            {
                description: 'A tool without streaming',
                inputSchema: z.object({ prompt: z.string() }),
                execution: { taskSupport: 'required' }
            },
            {
                async createTask({ prompt }, ctx) {
                    const task = await ctx.task.store.createTask({ ttl: 60_000, pollInterval: 50 });

                    // Complete after a short delay
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, 50));
                        try {
                            await ctx.task.store.storeTaskResult(task.taskId, 'completed', {
                                content: [{ type: 'text', text: prompt }]
                            });
                        } catch {
                            // Task may have been cleaned up
                        }
                    })();

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

        // Client declares streaming capability
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { tasks: { streaming: { partial: {} } } } });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

        // Verify server does NOT have streaming capability
        const serverCaps = mcpServer.server.getCapabilities();
        expect(serverCaps.tasks?.streaming).toBeUndefined();

        // Create a task — should work fine without streaming
        const createResult = await client.request({
            method: 'tools/call',
            params: {
                name: 'non-streaming-tool',
                arguments: { prompt: 'no streaming needed' },
                task: { ttl: 60_000 }
            }
        });

        const taskId = createResult.task.taskId;
        expect(createResult.task.status).toBe('working');

        // Subscribe to partials — should not fail even though server doesn't support it
        const received: TaskPartialNotificationParams[] = [];
        const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
            received.push(params);
        });

        // Wait for task to complete
        await vi.waitFor(
            async () => {
                const task = await taskStore.getTask(taskId);
                expect(task?.status).toBe('completed');
            },
            { timeout: 10_000, interval: 50 }
        );

        // Retrieve result — should work fine
        const result = await client.request({
            method: 'tasks/result',
            params: { taskId }
        });
        expect(result.content).toEqual([{ type: 'text', text: 'no streaming needed' }]);

        // No partials should have been received (server doesn't support streaming)
        expect(received).toHaveLength(0);

        cleanup();
        await mcpServer.close();
    }, 15_000);

    it('should discard partial notifications after client observes terminal status', async () => {
        const { mcpServer, client, taskStore, completeSignal } = await createStreamingEnvironment({
            manualMode: true
        });

        // Create a task
        const createResult = await client.request({
            method: 'tools/call',
            params: {
                name: 'streaming-tool',
                arguments: { prompt: 'post-terminal test' },
                task: { ttl: 60_000 }
            }
        });

        const taskId = createResult.task.taskId;

        const received: TaskPartialNotificationParams[] = [];
        const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
            received.push(params);
        });

        // Send a partial while task is working
        await mcpServer.experimental.tasks.sendTaskPartial(taskId, [{ type: 'text', text: 'before' }], 0);
        await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 5000 });

        // Move task to terminal status
        await taskStore.storeTaskResult(taskId, 'completed', {
            content: [{ type: 'text', text: 'done' }]
        });

        // Client observes terminal status
        const task = await client.request({
            method: 'tasks/get',
            params: { taskId }
        });
        expect(task.status).toBe('completed');

        // Client cleans up subscription (simulating well-behaved client after terminal status)
        cleanup();

        // Verify only the one partial before terminal was delivered
        expect(received).toHaveLength(1);
        expect(received[0]!.content).toEqual([{ type: 'text', text: 'before' }]);

        completeSignal.resolve();
        await mcpServer.close();
    }, 10_000);
});
