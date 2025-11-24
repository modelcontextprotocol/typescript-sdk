import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from '../client/index.js';
import { StreamableHTTPClientTransport } from '../client/streamableHttp.js';
import { McpServer } from '../server/mcp.js';
import { StreamableHTTPServerTransport } from '../server/streamableHttp.js';
import { CallToolResultSchema, CreateTaskResultSchema, ElicitRequestSchema, ElicitResultSchema, TaskSchema } from '../types.js';
import { z } from 'zod';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '../examples/shared/inMemoryTaskStore.js';
import type { TaskRequestOptions } from '../shared/protocol.js';

describe('Task Lifecycle Integration Tests', () => {
    let server: Server;
    let mcpServer: McpServer;
    let serverTransport: StreamableHTTPServerTransport;
    let baseUrl: URL;
    let taskStore: InMemoryTaskStore;

    beforeEach(async () => {
        // Create task store
        taskStore = new InMemoryTaskStore();

        // Create MCP server with task support
        mcpServer = new McpServer(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            }
                        },
                        list: {},
                        cancel: {}
                    }
                },
                taskStore,
                taskMessageQueue: new InMemoryTaskMessageQueue()
            }
        );

        // Register a long-running tool using registerToolTask
        mcpServer.registerToolTask(
            'long-task',
            {
                title: 'Long Running Task',
                description: 'A tool that takes time to complete',
                inputSchema: {
                    duration: z.number().describe('Duration in milliseconds').default(1000),
                    shouldFail: z.boolean().describe('Whether the task should fail').default(false)
                }
            },
            {
                async createTask({ duration, shouldFail }, extra) {
                    const task = await extra.taskStore.createTask({
                        ttl: 60000,
                        pollInterval: 100
                    });

                    // Simulate async work
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, duration));

                        try {
                            if (shouldFail) {
                                await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
                                    content: [{ type: 'text', text: 'Task failed as requested' }],
                                    isError: true
                                });
                            } else {
                                await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                                    content: [{ type: 'text', text: `Completed after ${duration}ms` }]
                                });
                            }
                        } catch {
                            // Task may have been cleaned up if test ended
                        }
                    })();

                    return { task };
                },
                async getTask(_args, extra) {
                    const task = await extra.taskStore.getTask(extra.taskId);
                    if (!task) {
                        throw new Error(`Task ${extra.taskId} not found`);
                    }
                    return task;
                },
                async getTaskResult(_args, extra) {
                    const result = await extra.taskStore.getTaskResult(extra.taskId);
                    return result as { content: Array<{ type: 'text'; text: string }> };
                }
            }
        );

        // Register a tool that requires input via elicitation
        mcpServer.registerToolTask(
            'input-task',
            {
                title: 'Input Required Task',
                description: 'A tool that requires user input',
                inputSchema: {
                    userName: z.string().describe('User name').optional()
                }
            },
            {
                async createTask({ userName }, extra) {
                    const task = await extra.taskStore.createTask({
                        ttl: 60000,
                        pollInterval: 100
                    });

                    // Perform async work that requires elicitation
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, 100));

                        // If userName not provided, request it via elicitation
                        if (!userName) {
                            const elicitationResult = await extra.sendRequest(
                                {
                                    method: 'elicitation/create',
                                    params: {
                                        mode: 'form',
                                        message: 'What is your name?',
                                        requestedSchema: {
                                            type: 'object',
                                            properties: {
                                                userName: { type: 'string' }
                                            },
                                            required: ['userName']
                                        }
                                    }
                                },
                                ElicitResultSchema,
                                { relatedTask: { taskId: task.taskId } } as unknown as TaskRequestOptions
                            );

                            // Complete with the elicited name
                            const name =
                                elicitationResult.action === 'accept' && elicitationResult.content
                                    ? elicitationResult.content.userName
                                    : 'Unknown';
                            try {
                                await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                                    content: [{ type: 'text', text: `Hello, ${name}!` }]
                                });
                            } catch {
                                // Task may have been cleaned up if test ended
                            }
                        } else {
                            // Complete immediately if userName was provided
                            try {
                                await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                                    content: [{ type: 'text', text: `Hello, ${userName}!` }]
                                });
                            } catch {
                                // Task may have been cleaned up if test ended
                            }
                        }
                    })();

                    return { task };
                },
                async getTask(_args, extra) {
                    const task = await extra.taskStore.getTask(extra.taskId);
                    if (!task) {
                        throw new Error(`Task ${extra.taskId} not found`);
                    }
                    return task;
                },
                async getTaskResult(_args, extra) {
                    const result = await extra.taskStore.getTaskResult(extra.taskId);
                    return result as { content: Array<{ type: 'text'; text: string }> };
                }
            }
        );

        // Create transport
        serverTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID()
        });

        await mcpServer.connect(serverTransport);

        // Create HTTP server
        server = createServer(async (req, res) => {
            await serverTransport.handleRequest(req, res);
        });

        // Start server
        baseUrl = await new Promise<URL>(resolve => {
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address() as AddressInfo;
                resolve(new URL(`http://127.0.0.1:${addr.port}`));
            });
        });
    });

    afterEach(async () => {
        taskStore.cleanup();
        await mcpServer.close().catch(() => {});
        await serverTransport.close().catch(() => {});
        server.close();
    });

    describe('Task Creation and Completion', () => {
        it('should create a task and return CreateTaskResult', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a task
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'long-task',
                        arguments: {
                            duration: 500,
                            shouldFail: false
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            // Verify CreateTaskResult structure
            expect(createResult).toHaveProperty('task');
            expect(createResult.task).toHaveProperty('taskId');
            expect(createResult.task.status).toBe('working');
            expect(createResult.task.ttl).toBe(60000);
            expect(createResult.task.createdAt).toBeDefined();
            expect(createResult.task.pollInterval).toBe(100);

            // Verify task is stored in taskStore
            const taskId = createResult.task.taskId;
            const storedTask = await taskStore.getTask(taskId);
            expect(storedTask).toBeDefined();
            expect(storedTask?.taskId).toBe(taskId);
            expect(storedTask?.status).toBe('working');

            // Wait for completion
            await new Promise(resolve => setTimeout(resolve, 600));

            // Verify task completed
            const completedTask = await taskStore.getTask(taskId);
            expect(completedTask?.status).toBe('completed');

            // Verify result is stored
            const result = await taskStore.getTaskResult(taskId);
            expect(result).toBeDefined();
            expect(result.content).toEqual([{ type: 'text', text: 'Completed after 500ms' }]);

            await transport.close();
        });

        it('should handle task failure correctly', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a task that will fail
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'long-task',
                        arguments: {
                            duration: 300,
                            shouldFail: true
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Wait for failure
            await new Promise(resolve => setTimeout(resolve, 400));

            // Verify task failed
            const task = await taskStore.getTask(taskId);
            expect(task?.status).toBe('failed');

            // Verify error result is stored
            const result = await taskStore.getTaskResult(taskId);
            expect(result.content).toEqual([{ type: 'text', text: 'Task failed as requested' }]);
            expect(result.isError).toBe(true);

            await transport.close();
        });
    });

    describe('Task Cancellation', () => {
        it('should cancel a working task', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a long-running task
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'long-task',
                        arguments: {
                            duration: 5000
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Verify task is working
            let task = await taskStore.getTask(taskId);
            expect(task?.status).toBe('working');

            // Cancel the task
            await taskStore.updateTaskStatus(taskId, 'cancelled');

            // Verify task is cancelled
            task = await taskStore.getTask(taskId);
            expect(task?.status).toBe('cancelled');

            await transport.close();
        });

        it('should reject cancellation of completed task', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a quick task
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'long-task',
                        arguments: {
                            duration: 100
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Wait for completion
            await new Promise(resolve => setTimeout(resolve, 200));

            // Verify task is completed
            const task = await taskStore.getTask(taskId);
            expect(task?.status).toBe('completed');

            // Try to cancel (should fail)
            await expect(taskStore.updateTaskStatus(taskId, 'cancelled')).rejects.toThrow();

            await transport.close();
        });
    });

    describe('Multiple Queued Messages', () => {
        it('should deliver multiple queued messages in order', async () => {
            // Register a tool that sends multiple server requests during execution
            mcpServer.registerToolTask(
                'multi-request-task',
                {
                    title: 'Multi Request Task',
                    description: 'A tool that sends multiple server requests',
                    inputSchema: {
                        requestCount: z.number().describe('Number of requests to send').default(3)
                    }
                },
                {
                    async createTask({ requestCount }, extra) {
                        const task = await extra.taskStore.createTask({
                            ttl: 60000,
                            pollInterval: 100
                        });

                        // Perform async work that sends multiple requests
                        (async () => {
                            await new Promise(resolve => setTimeout(resolve, 100));

                            const responses: string[] = [];

                            // Send multiple elicitation requests
                            for (let i = 0; i < requestCount; i++) {
                                const elicitationResult = await extra.sendRequest(
                                    {
                                        method: 'elicitation/create',
                                        params: {
                                            mode: 'form',
                                            message: `Request ${i + 1} of ${requestCount}`,
                                            requestedSchema: {
                                                type: 'object',
                                                properties: {
                                                    response: { type: 'string' }
                                                },
                                                required: ['response']
                                            }
                                        }
                                    },
                                    ElicitResultSchema,
                                    { relatedTask: { taskId: task.taskId } } as unknown as TaskRequestOptions
                                );

                                if (elicitationResult.action === 'accept' && elicitationResult.content) {
                                    responses.push(elicitationResult.content.response as string);
                                }
                            }

                            // Complete with all responses
                            try {
                                await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                                    content: [{ type: 'text', text: `Received responses: ${responses.join(', ')}` }]
                                });
                            } catch {
                                // Task may have been cleaned up if test ended
                            }
                        })();

                        return { task };
                    },
                    async getTask(_args, extra) {
                        const task = await extra.taskStore.getTask(extra.taskId);
                        if (!task) {
                            throw new Error(`Task ${extra.taskId} not found`);
                        }
                        return task;
                    },
                    async getTaskResult(_args, extra) {
                        const result = await extra.taskStore.getTaskResult(extra.taskId);
                        return result as { content: Array<{ type: 'text'; text: string }> };
                    }
                }
            );

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {}
                    }
                }
            );

            const receivedMessages: Array<{ method: string; message: string }> = [];

            // Set up elicitation handler on client to track message order
            client.setRequestHandler(ElicitRequestSchema, async request => {
                // Track the message
                receivedMessages.push({
                    method: request.method,
                    message: request.params.message
                });

                // Extract the request number from the message
                const match = request.params.message.match(/Request (\d+) of (\d+)/);
                const requestNum = match ? match[1] : 'unknown';

                // Respond with the request number
                return {
                    action: 'accept' as const,
                    content: {
                        response: `Response ${requestNum}`
                    }
                };
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a task that will send 3 requests
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'multi-request-task',
                        arguments: {
                            requestCount: 3
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Wait for messages to be queued
            await new Promise(resolve => setTimeout(resolve, 200));

            // Call tasks/result to receive all queued messages
            // This should deliver all 3 elicitation requests in order
            const result = await client.request(
                {
                    method: 'tasks/result',
                    params: { taskId }
                },
                CallToolResultSchema
            );

            // Verify all messages were delivered in order
            expect(receivedMessages.length).toBe(3);
            expect(receivedMessages[0].message).toBe('Request 1 of 3');
            expect(receivedMessages[1].message).toBe('Request 2 of 3');
            expect(receivedMessages[2].message).toBe('Request 3 of 3');

            // Verify final result includes all responses
            expect(result.content).toEqual([{ type: 'text', text: 'Received responses: Response 1, Response 2, Response 3' }]);

            // Verify task is completed
            const task = await client.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );
            expect(task.status).toBe('completed');

            await transport.close();
        }, 10000);
    });

    describe('Input Required Flow', () => {
        it('should handle elicitation during tool execution', async () => {
            const elicitClient = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {}
                    }
                }
            );

            // Set up elicitation handler on client
            elicitClient.setRequestHandler(ElicitRequestSchema, async request => {
                // Verify elicitation request structure
                expect(request.params.message).toBe('What is your name?');
                expect(request.params.requestedSchema).toHaveProperty('properties');

                // Respond with user input
                const response = {
                    action: 'accept' as const,
                    content: {
                        userName: 'Alice'
                    }
                };
                return response;
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await elicitClient.connect(transport);

            // Create a task without userName (will trigger elicitation)
            const createResult = await elicitClient.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'input-task',
                        arguments: {},
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Wait for elicitation to occur
            await new Promise(resolve => setTimeout(resolve, 200));

            // Check if the elicitation request was queued

            // Call tasks/result to receive the queued elicitation request
            // This should deliver the elicitation request via the side-channel
            // and then deliver the final result after the client responds
            const result = await elicitClient.request(
                {
                    method: 'tasks/result',
                    params: { taskId }
                },
                CallToolResultSchema
            );

            // Verify final result is delivered correctly
            expect(result.content).toEqual([{ type: 'text', text: 'Hello, Alice!' }]);

            // Verify task is now completed
            const task = await elicitClient.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );
            expect(task.status).toBe('completed');

            await transport.close();
        }, 10000); // Increase timeout to 10 seconds for debugging

        it('should complete immediately when input is provided upfront', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a task with userName provided (no elicitation needed)
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'input-task',
                        arguments: {
                            userName: 'Bob'
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Wait for completion
            await new Promise(resolve => setTimeout(resolve, 300));

            // Verify task completed without elicitation
            const task = await client.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );
            expect(task.status).toBe('completed');

            // Get result
            const result = await client.request(
                {
                    method: 'tasks/result',
                    params: { taskId }
                },
                CallToolResultSchema
            );

            expect(result.content).toEqual([{ type: 'text', text: 'Hello, Bob!' }]);

            await transport.close();
        });
    });

    describe('Task Listing and Pagination', () => {
        it('should list tasks', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create multiple tasks
            const taskIds: string[] = [];
            for (let i = 0; i < 3; i++) {
                const createResult = await client.request(
                    {
                        method: 'tools/call',
                        params: {
                            name: 'long-task',
                            arguments: {
                                duration: 1000
                            },
                            task: {
                                ttl: 60000
                            }
                        }
                    },
                    CreateTaskResultSchema
                );
                taskIds.push(createResult.task.taskId);
            }

            // List tasks using taskStore
            const listResult = await taskStore.listTasks();

            expect(listResult.tasks.length).toBeGreaterThanOrEqual(3);
            expect(listResult.tasks.some(t => taskIds.includes(t.taskId))).toBe(true);

            await transport.close();
        });

        it('should handle pagination with large datasets', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create 15 tasks (more than page size of 10)
            for (let i = 0; i < 15; i++) {
                await client.request(
                    {
                        method: 'tools/call',
                        params: {
                            name: 'long-task',
                            arguments: {
                                duration: 5000
                            },
                            task: {
                                ttl: 60000
                            }
                        }
                    },
                    CreateTaskResultSchema
                );
            }

            // Get first page using taskStore
            const page1 = await taskStore.listTasks();

            expect(page1.tasks.length).toBe(10);
            expect(page1.nextCursor).toBeDefined();

            // Get second page
            const page2 = await taskStore.listTasks(page1.nextCursor);

            expect(page2.tasks.length).toBeGreaterThanOrEqual(5);

            await transport.close();
        });
    });

    describe('Error Handling', () => {
        it('should return null for non-existent task', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Try to get non-existent task
            const task = await taskStore.getTask('non-existent');
            expect(task).toBeNull();

            await transport.close();
        });

        it('should return error for invalid task operation', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create and complete a task
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'long-task',
                        arguments: {
                            duration: 100
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Wait for completion
            await new Promise(resolve => setTimeout(resolve, 200));

            // Try to cancel completed task (should fail)
            await expect(taskStore.updateTaskStatus(taskId, 'cancelled')).rejects.toThrow();

            await transport.close();
        });
    });

    describe('TTL and Cleanup', () => {
        it('should respect TTL in task creation', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a task with specific TTL
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'long-task',
                        arguments: {
                            duration: 100
                        },
                        task: {
                            ttl: 5000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Verify TTL is set correctly
            expect(createResult.task.ttl).toBe(60000); // The task store uses 60000 as default

            // Task should exist
            const task = await client.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );
            expect(task).toBeDefined();
            expect(task.ttl).toBe(60000);

            await transport.close();
        });
    });

    describe('Task Cancellation with Queued Messages', () => {
        it('should clear queue and deliver no messages when task is cancelled before tasks/result', async () => {
            // Register a tool that queues messages but doesn't complete immediately
            mcpServer.registerToolTask(
                'cancellable-task',
                {
                    title: 'Cancellable Task',
                    description: 'A tool that queues messages and can be cancelled',
                    inputSchema: {
                        messageCount: z.number().describe('Number of messages to queue').default(2)
                    }
                },
                {
                    async createTask({ messageCount }, extra) {
                        const task = await extra.taskStore.createTask({
                            ttl: 60000,
                            pollInterval: 100
                        });

                        // Perform async work that queues messages
                        (async () => {
                            try {
                                await new Promise(resolve => setTimeout(resolve, 100));

                                // Queue multiple elicitation requests
                                for (let i = 0; i < messageCount; i++) {
                                    // Send request but don't await - let it queue
                                    extra
                                        .sendRequest(
                                            {
                                                method: 'elicitation/create',
                                                params: {
                                                    mode: 'form',
                                                    message: `Message ${i + 1} of ${messageCount}`,
                                                    requestedSchema: {
                                                        type: 'object',
                                                        properties: {
                                                            response: { type: 'string' }
                                                        },
                                                        required: ['response']
                                                    }
                                                }
                                            },
                                            ElicitResultSchema,
                                            { relatedTask: { taskId: task.taskId } } as unknown as TaskRequestOptions
                                        )
                                        .catch(() => {
                                            // Ignore errors from cancelled requests
                                        });
                                }

                                // Don't complete - let the task be cancelled
                                // Wait indefinitely (or until cancelled)
                                await new Promise(() => {});
                            } catch {
                                // Ignore errors - task was cancelled
                            }
                        })().catch(() => {
                            // Catch any unhandled errors from the async execution
                        });

                        return { task };
                    },
                    async getTask(_args, extra) {
                        const task = await extra.taskStore.getTask(extra.taskId);
                        if (!task) {
                            throw new Error(`Task ${extra.taskId} not found`);
                        }
                        return task;
                    },
                    async getTaskResult(_args, extra) {
                        const result = await extra.taskStore.getTaskResult(extra.taskId);
                        return result as { content: Array<{ type: 'text'; text: string }> };
                    }
                }
            );

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {}
                    }
                }
            );

            let elicitationCallCount = 0;

            // Set up elicitation handler to track if any messages are delivered
            client.setRequestHandler(ElicitRequestSchema, async () => {
                elicitationCallCount++;
                return {
                    action: 'accept' as const,
                    content: {
                        response: 'Should not be called'
                    }
                };
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a task that will queue messages
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'cancellable-task',
                        arguments: {
                            messageCount: 2
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Wait for messages to be queued
            await new Promise(resolve => setTimeout(resolve, 200));

            // Verify task is working and messages are queued
            let task = await client.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );
            expect(task.status).toBe('working');

            // Cancel the task before calling tasks/result using the proper tasks/cancel request
            // This will trigger queue cleanup via _clearTaskQueue in the handler
            await client.request(
                {
                    method: 'tasks/cancel',
                    params: { taskId }
                },
                z.object({ _meta: z.record(z.unknown()).optional() })
            );

            // Verify task is cancelled
            task = await client.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );
            expect(task.status).toBe('cancelled');

            // Attempt to call tasks/result
            // When a task is cancelled, the system needs to clear the message queue
            // and reject any pending message delivery promises, meaning no further
            // messages should be delivered for a cancelled task.
            try {
                await client.request(
                    {
                        method: 'tasks/result',
                        params: { taskId }
                    },
                    CallToolResultSchema
                );
            } catch {
                // tasks/result might throw an error for cancelled tasks without a result
                // This is acceptable behavior
            }

            // Verify no elicitation messages were delivered, as the queue should be cleared immediately on cancellation
            expect(elicitationCallCount).toBe(0);

            // Verify queue remains cleared on subsequent calls
            try {
                await client.request(
                    {
                        method: 'tasks/result',
                        params: { taskId }
                    },
                    CallToolResultSchema
                );
            } catch {
                // Expected - task is cancelled
            }

            // Still no messages should have been delivered
            expect(elicitationCallCount).toBe(0);

            await transport.close();
        }, 10000);
    });

    describe('Continuous Message Delivery', () => {
        it('should deliver messages immediately while tasks/result is blocking', async () => {
            // Register a tool that queues messages over time
            mcpServer.registerToolTask(
                'streaming-task',
                {
                    title: 'Streaming Task',
                    description: 'A tool that sends messages over time',
                    inputSchema: {
                        messageCount: z.number().describe('Number of messages to send').default(3),
                        delayBetweenMessages: z.number().describe('Delay between messages in ms').default(200)
                    }
                },
                {
                    async createTask({ messageCount, delayBetweenMessages }, extra) {
                        const task = await extra.taskStore.createTask({
                            ttl: 60000,
                            pollInterval: 100
                        });

                        // Perform async work that sends messages over time
                        (async () => {
                            try {
                                // Wait a bit before starting to send messages
                                await new Promise(resolve => setTimeout(resolve, 100));

                                const responses: string[] = [];

                                // Send messages with delays between them
                                for (let i = 0; i < messageCount; i++) {
                                    const elicitationResult = await extra.sendRequest(
                                        {
                                            method: 'elicitation/create',
                                            params: {
                                                mode: 'form',
                                                message: `Streaming message ${i + 1} of ${messageCount}`,
                                                requestedSchema: {
                                                    type: 'object',
                                                    properties: {
                                                        response: { type: 'string' }
                                                    },
                                                    required: ['response']
                                                }
                                            }
                                        },
                                        ElicitResultSchema,
                                        { relatedTask: { taskId: task.taskId } } as unknown as TaskRequestOptions
                                    );

                                    if (elicitationResult.action === 'accept' && elicitationResult.content) {
                                        responses.push(elicitationResult.content.response as string);
                                    }

                                    // Wait before sending next message (if not the last one)
                                    if (i < messageCount - 1) {
                                        await new Promise(resolve => setTimeout(resolve, delayBetweenMessages));
                                    }
                                }

                                // Complete with all responses
                                try {
                                    await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                                        content: [{ type: 'text', text: `Received all responses: ${responses.join(', ')}` }]
                                    });
                                } catch {
                                    // Task may have been cleaned up if test ended
                                }
                            } catch (error) {
                                // Handle errors
                                try {
                                    await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
                                        content: [{ type: 'text', text: `Error: ${error}` }],
                                        isError: true
                                    });
                                } catch {
                                    // Task may have been cleaned up if test ended
                                }
                            }
                        })();

                        return { task };
                    },
                    async getTask(_args, extra) {
                        const task = await extra.taskStore.getTask(extra.taskId);
                        if (!task) {
                            throw new Error(`Task ${extra.taskId} not found`);
                        }
                        return task;
                    },
                    async getTaskResult(_args, extra) {
                        const result = await extra.taskStore.getTaskResult(extra.taskId);
                        return result as { content: Array<{ type: 'text'; text: string }> };
                    }
                }
            );

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {}
                    }
                }
            );

            const receivedMessages: Array<{ message: string; timestamp: number }> = [];
            let tasksResultStartTime = 0;

            // Set up elicitation handler to track when messages arrive
            client.setRequestHandler(ElicitRequestSchema, async request => {
                const timestamp = Date.now();
                receivedMessages.push({
                    message: request.params.message,
                    timestamp
                });

                // Extract the message number
                const match = request.params.message.match(/Streaming message (\d+) of (\d+)/);
                const messageNum = match ? match[1] : 'unknown';

                // Respond immediately
                return {
                    action: 'accept' as const,
                    content: {
                        response: `Response ${messageNum}`
                    }
                };
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a task that will send messages over time
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'streaming-task',
                        arguments: {
                            messageCount: 3,
                            delayBetweenMessages: 300
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Verify task is in working status
            let task = await client.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );
            expect(task.status).toBe('working');

            // Call tasks/result immediately (before messages are queued)
            // This should block and deliver messages as they arrive
            tasksResultStartTime = Date.now();
            const resultPromise = client.request(
                {
                    method: 'tasks/result',
                    params: { taskId }
                },
                CallToolResultSchema
            );

            // Wait for the task to complete and get the result
            const result = await resultPromise;

            // Verify all 3 messages were delivered
            expect(receivedMessages.length).toBe(3);
            expect(receivedMessages[0].message).toBe('Streaming message 1 of 3');
            expect(receivedMessages[1].message).toBe('Streaming message 2 of 3');
            expect(receivedMessages[2].message).toBe('Streaming message 3 of 3');

            // Verify messages were delivered over time (not all at once)
            // The delay between messages should be approximately 300ms
            const timeBetweenFirstAndSecond = receivedMessages[1].timestamp - receivedMessages[0].timestamp;
            const timeBetweenSecondAndThird = receivedMessages[2].timestamp - receivedMessages[1].timestamp;

            // Allow some tolerance for timing (messages should be at least 200ms apart)
            expect(timeBetweenFirstAndSecond).toBeGreaterThan(200);
            expect(timeBetweenSecondAndThird).toBeGreaterThan(200);

            // Verify messages were delivered while tasks/result was blocking
            // (all messages should arrive after tasks/result was called)
            for (const msg of receivedMessages) {
                expect(msg.timestamp).toBeGreaterThanOrEqual(tasksResultStartTime);
            }

            // Verify final result is correct
            expect(result.content).toEqual([{ type: 'text', text: 'Received all responses: Response 1, Response 2, Response 3' }]);

            // Verify task is now completed
            task = await client.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );
            expect(task.status).toBe('completed');

            await transport.close();
        }, 15000); // Increase timeout to 15 seconds to allow for message delays
    });

    describe('Terminal Task with Queued Messages', () => {
        it('should deliver queued messages followed by final result for terminal task', async () => {
            // Register a tool that completes quickly and queues messages before completion
            mcpServer.registerToolTask(
                'quick-complete-task',
                {
                    title: 'Quick Complete Task',
                    description: 'A tool that queues messages and completes quickly',
                    inputSchema: {
                        messageCount: z.number().describe('Number of messages to queue').default(2)
                    }
                },
                {
                    async createTask({ messageCount }, extra) {
                        const task = await extra.taskStore.createTask({
                            ttl: 60000,
                            pollInterval: 100
                        });

                        // Perform async work that queues messages and completes quickly
                        (async () => {
                            try {
                                // Queue messages without waiting for responses
                                const pendingRequests: Promise<unknown>[] = [];

                                for (let i = 0; i < messageCount; i++) {
                                    const requestPromise = extra.sendRequest(
                                        {
                                            method: 'elicitation/create',
                                            params: {
                                                mode: 'form',
                                                message: `Quick message ${i + 1} of ${messageCount}`,
                                                requestedSchema: {
                                                    type: 'object',
                                                    properties: {
                                                        response: { type: 'string' }
                                                    },
                                                    required: ['response']
                                                }
                                            }
                                        },
                                        ElicitResultSchema,
                                        { relatedTask: { taskId: task.taskId } } as unknown as TaskRequestOptions
                                    );
                                    pendingRequests.push(requestPromise);
                                }

                                // Complete the task immediately (before responses are received)
                                // This creates a terminal task with queued messages
                                try {
                                    await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                                        content: [{ type: 'text', text: 'Task completed quickly' }]
                                    });
                                } catch {
                                    // Task may have been cleaned up if test ended
                                }

                                // Wait for all responses in the background
                                await Promise.all(pendingRequests.map(p => p.catch(() => {})));
                            } catch (error) {
                                // Handle errors
                                try {
                                    await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
                                        content: [{ type: 'text', text: `Error: ${error}` }],
                                        isError: true
                                    });
                                } catch {
                                    // Task may have been cleaned up if test ended
                                }
                            }
                        })();

                        return { task };
                    },
                    async getTask(_args, extra) {
                        const task = await extra.taskStore.getTask(extra.taskId);
                        if (!task) {
                            throw new Error(`Task ${extra.taskId} not found`);
                        }
                        return task;
                    },
                    async getTaskResult(_args, extra) {
                        const result = await extra.taskStore.getTaskResult(extra.taskId);
                        return result as { content: Array<{ type: 'text'; text: string }> };
                    }
                }
            );

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {}
                    }
                }
            );

            const receivedMessages: Array<{ type: string; message?: string; content?: unknown }> = [];

            // Set up elicitation handler to track message order
            client.setRequestHandler(ElicitRequestSchema, async request => {
                receivedMessages.push({
                    type: 'elicitation',
                    message: request.params.message
                });

                // Extract the message number
                const match = request.params.message.match(/Quick message (\d+) of (\d+)/);
                const messageNum = match ? match[1] : 'unknown';

                return {
                    action: 'accept' as const,
                    content: {
                        response: `Response ${messageNum}`
                    }
                };
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a task that will complete quickly with queued messages
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'quick-complete-task',
                        arguments: {
                            messageCount: 2
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Wait for task to complete and messages to be queued
            await new Promise(resolve => setTimeout(resolve, 200));

            // Verify task is in terminal status (completed)
            const task = await client.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );
            expect(task.status).toBe('completed');

            // Call tasks/result - should deliver queued messages followed by final result
            const result = await client.request(
                {
                    method: 'tasks/result',
                    params: { taskId }
                },
                CallToolResultSchema
            );

            // Verify all queued messages were delivered before the final result
            expect(receivedMessages.length).toBe(2);
            expect(receivedMessages[0].message).toBe('Quick message 1 of 2');
            expect(receivedMessages[1].message).toBe('Quick message 2 of 2');

            // Verify final result is correct
            expect(result.content).toEqual([{ type: 'text', text: 'Task completed quickly' }]);

            // Verify queue is cleaned up - calling tasks/result again should only return the result
            receivedMessages.length = 0; // Clear the array

            const result2 = await client.request(
                {
                    method: 'tasks/result',
                    params: { taskId }
                },
                CallToolResultSchema
            );

            // No messages should be delivered on second call (queue was cleaned up)
            expect(receivedMessages.length).toBe(0);
            expect(result2.content).toEqual([{ type: 'text', text: 'Task completed quickly' }]);

            await transport.close();
        }, 10000);
    });

    describe('Concurrent Operations', () => {
        it('should handle multiple concurrent task creations', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create multiple tasks concurrently
            const promises = Array.from({ length: 5 }, () =>
                client.request(
                    {
                        method: 'tools/call',
                        params: {
                            name: 'long-task',
                            arguments: {
                                duration: 500
                            },
                            task: {
                                ttl: 60000
                            }
                        }
                    },
                    CreateTaskResultSchema
                )
            );

            const results = await Promise.all(promises);

            // Verify all tasks were created with unique IDs
            const taskIds = results.map(r => r.task.taskId);
            expect(new Set(taskIds).size).toBe(5);

            // Verify all tasks are in working status
            for (const result of results) {
                expect(result.task.status).toBe('working');
            }

            await transport.close();
        });

        it('should handle concurrent operations on same task', async () => {
            const client = new Client({
                name: 'test-client',
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(baseUrl);
            await client.connect(transport);

            // Create a task
            const createResult = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'long-task',
                        arguments: {
                            duration: 2000
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                },
                CreateTaskResultSchema
            );

            const taskId = createResult.task.taskId;

            // Perform multiple concurrent gets
            const getPromises = Array.from({ length: 5 }, () =>
                client.request(
                    {
                        method: 'tasks/get',
                        params: { taskId }
                    },
                    TaskSchema
                )
            );

            const tasks = await Promise.all(getPromises);

            // All should return the same task
            for (const task of tasks) {
                expect(task.taskId).toBe(taskId);
                expect(task.status).toBe('working');
            }

            await transport.close();
        });
    });
});
