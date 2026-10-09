import { z } from 'zod';
import { Client } from '../../src/client/index.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { McpServer } from '../../src/server/mcp.js';
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from '../../src/experimental/tasks/stores/in-memory.js';
import type { TaskRequestOptions } from '../../src/shared/protocol.js';
import { ElicitRequestSchema, ElicitResultSchema, type CallToolResult } from '../../src/types.js';

describe('taskSupport "optional" tool called without task augmentation', () => {
    test('delivers a task-related elicitation and returns the result', async () => {
        const taskStore = new InMemoryTaskStore();
        const mcpServer = new McpServer(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: { tasks: { requests: { tools: { call: {} } } } },
                taskStore,
                taskMessageQueue: new InMemoryTaskMessageQueue()
            }
        );

        mcpServer.experimental.tasks.registerToolTask(
            'confirm',
            { inputSchema: { question: z.string() }, execution: { taskSupport: 'optional' } },
            {
                createTask: async ({ question }, extra) => {
                    const task = await extra.taskStore.createTask({ pollInterval: 10 });
                    void (async () => {
                        const answer = await extra.sendRequest(
                            {
                                method: 'elicitation/create',
                                params: {
                                    mode: 'form',
                                    message: question,
                                    requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
                                }
                            },
                            ElicitResultSchema,
                            { relatedTask: { taskId: task.taskId } } as unknown as TaskRequestOptions
                        );
                        await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                            content: [{ type: 'text', text: `ok=${answer.content?.ok}` }]
                        });
                    })();
                    return { task };
                },
                getTask: async (_args, extra) => (await extra.taskStore.getTask(extra.taskId))!,
                getTaskResult: async (_args, extra) => (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });
        const prompts: string[] = [];
        client.setRequestHandler(ElicitRequestSchema, async request => {
            prompts.push(request.params.message);
            return { action: 'accept', content: { ok: true } };
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

        const result = await client.callTool({ name: 'confirm', arguments: { question: 'Install it?' } }, undefined, { timeout: 2000 });

        expect(prompts).toEqual(['Install it?']);
        expect(result.content).toEqual([{ type: 'text', text: 'ok=true' }]);

        taskStore.cleanup();
        await client.close();
    });
});
