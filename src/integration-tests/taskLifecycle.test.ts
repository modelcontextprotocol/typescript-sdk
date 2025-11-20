import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from '../client/index.js';
import { StreamableHTTPClientTransport } from '../client/streamableHttp.js';
import { McpServer } from '../server/mcp.js';
import { StreamableHTTPServerTransport } from '../server/streamableHttp.js';
import { CallToolResultSchema, CreateTaskResultSchema, ElicitRequestSchema, ElicitResultSchema, TaskSchema } from '../types.js';
import { z } from 'zod';
import { InMemoryTaskStore } from '../examples/shared/inMemoryTaskStore.js';
import { InMemoryTransport } from '../inMemory.js';

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
                taskStore
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
                    const task = await extra.taskStore.createTask(
                        {
                            ttl: 60000,
                            pollInterval: 100
                        },
                        0,
                        { method: 'tools/call', params: { name: 'long-task', arguments: { duration, shouldFail } } }
                    );

                    // Simulate async work
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, duration));

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
                    const task = await extra.taskStore.createTask(
                        {
                            ttl: 60000,
                            pollInterval: 100
                        },
                        0,
                        { method: 'tools/call', params: { name: 'input-task', arguments: { userName } } }
                    );

                    // Perform async work that requires elicitation
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, 100));

                        // If userName not provided, request it via elicitation
                        if (!userName) {
                            const elicitationResult = await extra.sendRequest(
                                {
                                    method: 'elicitation/create',
                                    params: {
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
                                ElicitResultSchema
                            );

                            // Complete with the elicited name
                            const name =
                                elicitationResult.action === 'accept' && elicitationResult.content
                                    ? elicitationResult.content.userName
                                    : 'Unknown';
                            await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                                content: [{ type: 'text', text: `Hello, ${name}!` }]
                            });
                        } else {
                            // Complete immediately if userName was provided
                            await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                                content: [{ type: 'text', text: `Hello, ${userName}!` }]
                            });
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

    describe('Input Required Flow', () => {
        it('should handle elicitation during tool execution', async () => {
            // Use InMemoryTransport for this test since elicitation requires bidirectional communication
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
                return {
                    action: 'accept' as const,
                    content: {
                        userName: 'Alice'
                    }
                };
            });

            const [elicitClientTransport, elicitServerTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([elicitClient.connect(elicitClientTransport), mcpServer.connect(elicitServerTransport)]);

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

            // Wait for elicitation to occur and task to transition to input_required
            await new Promise(resolve => setTimeout(resolve, 200));

            // Check task status - should be input_required during elicitation
            let task = await elicitClient.request(
                {
                    method: 'tasks/get',
                    params: { taskId }
                },
                TaskSchema
            );

            // Task should either be input_required or already completed (if elicitation was fast)
            expect(['input_required', 'working', 'completed']).toContain(task.status);

            // Wait for completion after elicitation response
            // Poll until task completes or times out
            let attempts = 0;
            while (attempts < 20) {
                task = await elicitClient.request(
                    {
                        method: 'tasks/get',
                        params: { taskId }
                    },
                    TaskSchema
                );
                if (task.status === 'completed' || task.status === 'failed') {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }

            // Verify task completed with elicited input
            expect(task.status).toBe('completed');

            // Get result
            const result = await elicitClient.request(
                {
                    method: 'tasks/result',
                    params: { taskId }
                },
                CallToolResultSchema
            );

            expect(result.content).toEqual([{ type: 'text', text: 'Hello, Alice!' }]);

            await elicitClientTransport.close();
            await elicitServerTransport.close();
        });

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
