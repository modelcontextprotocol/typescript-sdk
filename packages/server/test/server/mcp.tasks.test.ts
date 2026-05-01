import type { CreateTaskServerContext, JSONRPCMessage, TaskServerContext } from '@modelcontextprotocol/core';
import { InMemoryTaskStore, InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '../../src/index.js';
import type { ToolTaskHandler } from '../../src/index.js';

describe('registerToolTask', () => {
    it('passes task context as the second argument for no-schema task handlers', async () => {
        const server = new McpServer(
            { name: 'task-test', version: '1.0.0' },
            {
                capabilities: {
                    tasks: {
                        requests: { tools: { call: {} } },
                        taskStore: new InMemoryTaskStore()
                    }
                }
            }
        );

        let receivedArgs: unknown = 'not-called';
        let receivedCtx: CreateTaskServerContext | undefined;

        const handler = {
            createTask: async (_args: undefined, ctx: CreateTaskServerContext) => {
                receivedArgs = _args;
                receivedCtx = ctx;
                const task = await ctx.task.store.createTask({ ttl: ctx.task.requestedTtl });
                return { task };
            },
            getTask: async (_args: undefined, ctx: TaskServerContext) => ({
                taskId: ctx.task.id ?? 'unused',
                status: 'working' as const,
                ttl: null,
                createdAt: new Date(0).toISOString(),
                lastUpdatedAt: new Date(0).toISOString()
            }),
            getTaskResult: async () => ({
                content: [{ type: 'text' as const, text: 'done' }]
            })
        } satisfies ToolTaskHandler<undefined>;

        server.experimental.tasks.registerToolTask('no-schema-task', { description: 'Create a task without input arguments' }, handler);

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await clientTransport.start();

        const responses: JSONRPCMessage[] = [];
        clientTransport.onmessage = message => responses.push(message);

        await clientTransport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'task-client', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
        await clientTransport.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
                name: 'no-schema-task',
                task: { ttl: 600 }
            }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(response => 'id' in response && response.id === 2)).toBe(true));

        expect(receivedArgs).toBeUndefined();
        expect(receivedCtx?.task.store).toBeDefined();
        expect(receivedCtx?.task.requestedTtl).toBe(600);

        const response = responses.find(message => 'id' in message && message.id === 2) as {
            error?: unknown;
            result?: { task: { ttl?: number | null } };
        };
        expect(response.error).toBeUndefined();
        expect(response.result?.task.ttl).toBe(600);

        await server.close();
    });
});
