/**
 * Tests for experimental server streaming methods: createMessageStream and elicitInputStream.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { InMemoryTransport } from '../../../src/inMemory.js';
import { InMemoryTaskStore } from '../../../src/experimental/tasks/stores/in-memory.js';
import { toArrayAsync } from '../../../src/shared/responseMessage.js';
import {
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    type CreateMessageResult,
    type ElicitResult,
    type Task
} from '../../../src/types.js';

describe('createMessageStream', () => {
    test('should throw when tools are provided without sampling.tools capability', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });
        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            role: 'assistant',
            content: { type: 'text', text: 'Response' },
            model: 'test-model'
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        expect(() => {
            server.experimental.tasks.createMessageStream({
                messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
                maxTokens: 100,
                tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
            });
        }).toThrow('Client does not support sampling tools capability');

        await client.close().catch(() => {});
        await server.close().catch(() => {});
    });

    test('should throw when tool_result has no matching tool_use in previous message', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });
        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            role: 'assistant',
            content: { type: 'text', text: 'Response' },
            model: 'test-model'
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        expect(() => {
            server.experimental.tasks.createMessageStream({
                messages: [
                    { role: 'user', content: { type: 'text', text: 'Hello' } },
                    {
                        role: 'user',
                        content: [{ type: 'tool_result', toolUseId: 'test-id', content: [{ type: 'text', text: 'result' }] }]
                    }
                ],
                maxTokens: 100
            });
        }).toThrow('tool_result blocks are not matching any tool_use from the previous message');

        await client.close().catch(() => {});
        await server.close().catch(() => {});
    });

    describe('terminal message guarantees', () => {
        test('should yield exactly one terminal message for successful request', async () => {
            const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });
            const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

            client.setRequestHandler(CreateMessageRequestSchema, async () => ({
                role: 'assistant',
                content: { type: 'text', text: 'Response' },
                model: 'test-model'
            }));

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const stream = server.experimental.tasks.createMessageStream({
                messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
                maxTokens: 100
            });

            const allMessages = await toArrayAsync(stream);

            expect(allMessages.length).toBe(1);
            expect(allMessages[0].type).toBe('result');

            const taskMessages = allMessages.filter(m => m.type === 'taskCreated' || m.type === 'taskStatus');
            expect(taskMessages.length).toBe(0);

            await client.close().catch(() => {});
            await server.close().catch(() => {});
        });

        test('should yield error as terminal message when client returns error', async () => {
            const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });
            const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

            client.setRequestHandler(CreateMessageRequestSchema, async () => {
                throw new Error('Simulated client error');
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const stream = server.experimental.tasks.createMessageStream({
                messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
                maxTokens: 100
            });

            const allMessages = await toArrayAsync(stream);

            expect(allMessages.length).toBe(1);
            expect(allMessages[0].type).toBe('error');

            await client.close().catch(() => {});
            await server.close().catch(() => {});
        });

        test('should yield exactly one terminal message with result', async () => {
            const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });
            const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

            client.setRequestHandler(CreateMessageRequestSchema, () => ({
                model: 'test-model',
                role: 'assistant' as const,
                content: { type: 'text' as const, text: 'Response' }
            }));

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const stream = server.experimental.tasks.createMessageStream({
                messages: [{ role: 'user', content: { type: 'text', text: 'Message' } }],
                maxTokens: 100
            });

            const messages = await toArrayAsync(stream);
            const terminalMessages = messages.filter(m => m.type === 'result' || m.type === 'error');

            expect(terminalMessages.length).toBe(1);

            const lastMessage = messages[messages.length - 1];
            expect(lastMessage.type === 'result' || lastMessage.type === 'error').toBe(true);

            if (lastMessage.type === 'result') {
                expect((lastMessage.result as CreateMessageResult).content).toBeDefined();
            }

            await client.close().catch(() => {});
            await server.close().catch(() => {});
        });
    });

    describe('non-task request minimality', () => {
        test('should yield only result message for non-task request', async () => {
            const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });
            const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

            client.setRequestHandler(CreateMessageRequestSchema, () => ({
                model: 'test-model',
                role: 'assistant' as const,
                content: { type: 'text' as const, text: 'Response' }
            }));

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const stream = server.experimental.tasks.createMessageStream({
                messages: [{ role: 'user', content: { type: 'text', text: 'Message' } }],
                maxTokens: 100
            });

            const messages = await toArrayAsync(stream);

            const taskMessages = messages.filter(m => m.type === 'taskCreated' || m.type === 'taskStatus');
            expect(taskMessages.length).toBe(0);

            const resultMessages = messages.filter(m => m.type === 'result');
            expect(resultMessages.length).toBe(1);

            expect(messages.length).toBe(1);

            await client.close().catch(() => {});
            await server.close().catch(() => {});
        });
    });

    describe('task-augmented request handling', () => {
        test('should yield taskCreated and result for task-augmented request', async () => {
            const clientTaskStore = new InMemoryTaskStore();
            const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });
            const client = new Client(
                { name: 'test client', version: '1.0' },
                {
                    capabilities: {
                        sampling: {},
                        tasks: {
                            requests: {
                                sampling: { createMessage: {} }
                            }
                        }
                    },
                    taskStore: clientTaskStore
                }
            );

            client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
                const result = {
                    model: 'test-model',
                    role: 'assistant' as const,
                    content: { type: 'text' as const, text: 'Task response' }
                };

                if (request.params.task && extra.taskStore) {
                    const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl });
                    await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
                    return { task };
                }
                return result;
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const stream = server.experimental.tasks.createMessageStream(
                {
                    messages: [{ role: 'user', content: { type: 'text', text: 'Task-augmented message' } }],
                    maxTokens: 100
                },
                { task: { ttl: 60_000 } }
            );

            const messages = await toArrayAsync(stream);

            // Should have taskCreated and result
            expect(messages.length).toBeGreaterThanOrEqual(2);

            // First message should be taskCreated
            expect(messages[0].type).toBe('taskCreated');
            const taskCreated = messages[0] as { type: 'taskCreated'; task: Task };
            expect(taskCreated.task.taskId).toBeDefined();

            // Last message should be result
            const lastMessage = messages[messages.length - 1];
            expect(lastMessage.type).toBe('result');
            if (lastMessage.type === 'result') {
                expect((lastMessage.result as CreateMessageResult).model).toBe('test-model');
            }

            clientTaskStore.cleanup();
            await client.close().catch(() => {});
            await server.close().catch(() => {});
        });
    });
});

describe('elicitInputStream', () => {
    let server: Server;
    let client: Client;
    let clientTransport: ReturnType<typeof InMemoryTransport.createLinkedPair>[0];
    let serverTransport: ReturnType<typeof InMemoryTransport.createLinkedPair>[1];

    beforeEach(async () => {
        server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        client = new Client(
            { name: 'test client', version: '1.0' },
            {
                capabilities: {
                    elicitation: {
                        form: {},
                        url: {}
                    }
                }
            }
        );

        [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    });

    afterEach(async () => {
        await server.close().catch(() => {});
        await client.close().catch(() => {});
    });

    test('should throw when client does not support form elicitation', async () => {
        // Create client without form elicitation capability
        const noFormClient = new Client(
            { name: 'test client', version: '1.0' },
            {
                capabilities: {
                    elicitation: {
                        url: {}
                    }
                }
            }
        );

        const [noFormClientTransport, noFormServerTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([noFormClient.connect(noFormClientTransport), server.connect(noFormServerTransport)]);

        expect(() => {
            server.experimental.tasks.elicitInputStream({
                mode: 'form',
                message: 'Enter data',
                requestedSchema: { type: 'object', properties: {} }
            });
        }).toThrow('Client does not support form elicitation.');

        await noFormClient.close().catch(() => {});
    });

    test('should throw when client does not support url elicitation', async () => {
        // Create client without url elicitation capability
        const noUrlClient = new Client(
            { name: 'test client', version: '1.0' },
            {
                capabilities: {
                    elicitation: {
                        form: {}
                    }
                }
            }
        );

        const [noUrlClientTransport, noUrlServerTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([noUrlClient.connect(noUrlClientTransport), server.connect(noUrlServerTransport)]);

        expect(() => {
            server.experimental.tasks.elicitInputStream({
                mode: 'url',
                message: 'Open URL',
                elicitationId: 'test-123',
                url: 'https://example.com/auth'
            });
        }).toThrow('Client does not support url elicitation.');

        await noUrlClient.close().catch(() => {});
    });

    test('should default to form mode when mode is not specified', async () => {
        const requestStreamSpy = vi.spyOn(server.experimental.tasks, 'requestStream');

        client.setRequestHandler(ElicitRequestSchema, () => ({
            action: 'accept',
            content: { value: 'test' }
        }));

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Call without explicit mode - need to cast because TypeScript expects mode
        const params = {
            message: 'Enter value',
            requestedSchema: {
                type: 'object' as const,
                properties: { value: { type: 'string' as const } }
            }
        };

        const stream = server.experimental.tasks.elicitInputStream(
            params as Parameters<typeof server.experimental.tasks.elicitInputStream>[0]
        );
        await toArrayAsync(stream);

        // Verify mode was normalized to 'form'
        expect(requestStreamSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'elicitation/create',
                params: expect.objectContaining({ mode: 'form' })
            }),
            expect.anything(),
            undefined
        );
    });

    test('should yield error as terminal message when client returns error', async () => {
        client.setRequestHandler(ElicitRequestSchema, () => {
            throw new Error('Simulated client error');
        });

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const stream = server.experimental.tasks.elicitInputStream({
            mode: 'form',
            message: 'Enter data',
            requestedSchema: {
                type: 'object',
                properties: { value: { type: 'string' } }
            }
        });

        const allMessages = await toArrayAsync(stream);

        expect(allMessages.length).toBe(1);
        expect(allMessages[0].type).toBe('error');
    });

    // For any streaming elicitation request, the AsyncGenerator yields exactly one terminal
    // message (either 'result' or 'error') as its final message.
    describe('terminal message guarantees', () => {
        test.each([
            { action: 'accept' as const, content: { data: 'test-value' } },
            { action: 'decline' as const, content: undefined },
            { action: 'cancel' as const, content: undefined }
        ])('should yield exactly one terminal message for action: $action', async ({ action, content }) => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action,
                content
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const stream = server.experimental.tasks.elicitInputStream({
                mode: 'form',
                message: 'Test message',
                requestedSchema: {
                    type: 'object',
                    properties: { data: { type: 'string' } }
                }
            });

            const messages = await toArrayAsync(stream);

            // Count terminal messages (result or error)
            const terminalMessages = messages.filter(m => m.type === 'result' || m.type === 'error');

            expect(terminalMessages.length).toBe(1);

            // Verify terminal message is the last message
            const lastMessage = messages[messages.length - 1];
            expect(lastMessage.type === 'result' || lastMessage.type === 'error').toBe(true);

            // Verify result content matches expected action
            if (lastMessage.type === 'result') {
                expect((lastMessage.result as ElicitResult).action).toBe(action);
            }
        });
    });

    // For any non-task elicitation request, the generator yields exactly one 'result' message
    // (or 'error' if the request fails), with no 'taskCreated' or 'taskStatus' messages.
    describe('non-task request minimality', () => {
        test.each([
            { action: 'accept' as const, content: { value: 'test' } },
            { action: 'decline' as const, content: undefined },
            { action: 'cancel' as const, content: undefined }
        ])('should yield only result message for non-task request with action: $action', async ({ action, content }) => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action,
                content
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Non-task request (no task option)
            const stream = server.experimental.tasks.elicitInputStream({
                mode: 'form',
                message: 'Non-task request',
                requestedSchema: {
                    type: 'object',
                    properties: { value: { type: 'string' } }
                }
            });

            const messages = await toArrayAsync(stream);

            // Verify no taskCreated or taskStatus messages
            const taskMessages = messages.filter(m => m.type === 'taskCreated' || m.type === 'taskStatus');
            expect(taskMessages.length).toBe(0);

            // Verify exactly one result message
            const resultMessages = messages.filter(m => m.type === 'result');
            expect(resultMessages.length).toBe(1);

            // Verify total message count is 1
            expect(messages.length).toBe(1);
        });
    });

    // For any task-augmented elicitation request, the generator should yield at least one
    // 'taskCreated' message followed by 'taskStatus' messages before yielding the final
    // result or error.
    describe('task-augmented request handling', () => {
        test('should yield taskCreated and result for task-augmented request', async () => {
            const clientTaskStore = new InMemoryTaskStore();
            const taskClient = new Client(
                { name: 'test client', version: '1.0' },
                {
                    capabilities: {
                        elicitation: { form: {} },
                        tasks: {
                            requests: {
                                elicitation: { create: {} }
                            }
                        }
                    },
                    taskStore: clientTaskStore
                }
            );

            taskClient.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
                const result = {
                    action: 'accept' as const,
                    content: { username: 'task-user' }
                };

                if (request.params.task && extra.taskStore) {
                    const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl });
                    await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
                    return { task };
                }
                return result;
            });

            const [taskClientTransport, taskServerTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([taskClient.connect(taskClientTransport), server.connect(taskServerTransport)]);

            const stream = server.experimental.tasks.elicitInputStream(
                {
                    mode: 'form',
                    message: 'Task-augmented request',
                    requestedSchema: {
                        type: 'object',
                        properties: { username: { type: 'string' } },
                        required: ['username']
                    }
                },
                { task: { ttl: 60_000 } }
            );

            const messages = await toArrayAsync(stream);

            // Should have taskCreated and result
            expect(messages.length).toBeGreaterThanOrEqual(2);

            // First message should be taskCreated
            expect(messages[0].type).toBe('taskCreated');
            const taskCreated = messages[0] as { type: 'taskCreated'; task: Task };
            expect(taskCreated.task.taskId).toBeDefined();

            // Last message should be result
            const lastMessage = messages[messages.length - 1];
            expect(lastMessage.type).toBe('result');
            if (lastMessage.type === 'result') {
                expect((lastMessage.result as ElicitResult).action).toBe('accept');
                expect((lastMessage.result as ElicitResult).content).toEqual({ username: 'task-user' });
            }

            clientTaskStore.cleanup();
            await taskClient.close().catch(() => {});
        });
    });
});
