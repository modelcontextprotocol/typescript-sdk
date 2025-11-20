/* eslint-disable @typescript-eslint/no-unused-vars */
import { z } from 'zod';
import { Client } from '../client/index.js';
import { InMemoryTransport } from '../inMemory.js';
import type { Transport } from '../shared/transport.js';
import {
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    ErrorCode,
    LATEST_PROTOCOL_VERSION,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    type LoggingMessageNotification,
    McpError,
    NotificationSchema,
    RequestSchema,
    ResultSchema,
    SetLevelRequestSchema,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../types.js';
import { Server } from './index.js';
import { McpServer } from './mcp.js';
import { InMemoryTaskStore } from '../examples/shared/inMemoryTaskStore.js';
import { CallToolRequestSchema, CallToolResultSchema } from '../types.js';

test('should accept latest protocol version', async () => {
    let sendPromiseResolve: (value: unknown) => void;
    const sendPromise = new Promise(resolve => {
        sendPromiseResolve = resolve;
    });

    const serverTransport: Transport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockImplementation(message => {
            if (message.id === 1 && message.result) {
                expect(message.result).toEqual({
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: expect.any(Object),
                    serverInfo: {
                        name: 'test server',
                        version: '1.0'
                    },
                    instructions: 'Test instructions'
                });
                sendPromiseResolve(undefined);
            }
            return Promise.resolve();
        })
    };

    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            },
            instructions: 'Test instructions'
        }
    );

    await server.connect(serverTransport);

    // Simulate initialize request with latest version
    serverTransport.onmessage?.({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
                name: 'test client',
                version: '1.0'
            }
        }
    });

    await expect(sendPromise).resolves.toBeUndefined();
});

test('should accept supported older protocol version', async () => {
    const OLD_VERSION = SUPPORTED_PROTOCOL_VERSIONS[1];
    let sendPromiseResolve: (value: unknown) => void;
    const sendPromise = new Promise(resolve => {
        sendPromiseResolve = resolve;
    });

    const serverTransport: Transport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockImplementation(message => {
            if (message.id === 1 && message.result) {
                expect(message.result).toEqual({
                    protocolVersion: OLD_VERSION,
                    capabilities: expect.any(Object),
                    serverInfo: {
                        name: 'test server',
                        version: '1.0'
                    }
                });
                sendPromiseResolve(undefined);
            }
            return Promise.resolve();
        })
    };

    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            }
        }
    );

    await server.connect(serverTransport);

    // Simulate initialize request with older version
    serverTransport.onmessage?.({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: OLD_VERSION,
            capabilities: {},
            clientInfo: {
                name: 'test client',
                version: '1.0'
            }
        }
    });

    await expect(sendPromise).resolves.toBeUndefined();
});

test('should handle unsupported protocol version', async () => {
    let sendPromiseResolve: (value: unknown) => void;
    const sendPromise = new Promise(resolve => {
        sendPromiseResolve = resolve;
    });

    const serverTransport: Transport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockImplementation(message => {
            if (message.id === 1 && message.result) {
                expect(message.result).toEqual({
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: expect.any(Object),
                    serverInfo: {
                        name: 'test server',
                        version: '1.0'
                    }
                });
                sendPromiseResolve(undefined);
            }
            return Promise.resolve();
        })
    };

    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            }
        }
    );

    await server.connect(serverTransport);

    // Simulate initialize request with unsupported version
    serverTransport.onmessage?.({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: 'invalid-version',
            capabilities: {},
            clientInfo: {
                name: 'test client',
                version: '1.0'
            }
        }
    });

    await expect(sendPromise).resolves.toBeUndefined();
});

test('should respect client capabilities', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            },
            enforceStrictCapabilities: true
        }
    );

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            }
        }
    );

    // Implement request handler for sampling/createMessage
    client.setRequestHandler(CreateMessageRequestSchema, async _request => {
        // Mock implementation of createMessage
        return {
            model: 'test-model',
            role: 'assistant',
            content: {
                type: 'text',
                text: 'This is a test response'
            }
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(server.getClientCapabilities()).toEqual({ sampling: {} });

    // This should work because sampling is supported by the client
    await expect(
        server.createMessage({
            messages: [],
            maxTokens: 10
        })
    ).resolves.not.toThrow();

    // This should still throw because roots are not supported by the client
    await expect(server.listRoots()).rejects.toThrow(/Client does not support/);
});

test('should respect client elicitation capabilities', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            },
            enforceStrictCapabilities: true
        }
    );

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                elicitation: {}
            }
        }
    );

    client.setRequestHandler(ElicitRequestSchema, params => ({
        action: 'accept',
        content: {
            username: params.params.message.includes('username') ? 'test-user' : undefined,
            confirmed: true
        }
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(server.getClientCapabilities()).toEqual({ elicitation: {} });

    // This should work because elicitation is supported by the client
    await expect(
        server.elicitInput({
            message: 'Please provide your username',
            requestedSchema: {
                type: 'object',
                properties: {
                    username: {
                        type: 'string',
                        title: 'Username',
                        description: 'Your username'
                    },
                    confirmed: {
                        type: 'boolean',
                        title: 'Confirm',
                        description: 'Please confirm',
                        default: false
                    }
                },
                required: ['username']
            }
        })
    ).resolves.toEqual({
        action: 'accept',
        content: {
            username: 'test-user',
            confirmed: true
        }
    });

    // This should still throw because sampling is not supported by the client
    await expect(
        server.createMessage({
            messages: [],
            maxTokens: 10
        })
    ).rejects.toThrow(/Client does not support/);
});

test('should validate elicitation response against requested schema', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            },
            enforceStrictCapabilities: true
        }
    );

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                elicitation: {}
            }
        }
    );

    // Set up client to return valid response
    client.setRequestHandler(ElicitRequestSchema, _request => ({
        action: 'accept',
        content: {
            name: 'John Doe',
            email: 'john@example.com',
            age: 30
        }
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Test with valid response
    await expect(
        server.elicitInput({
            message: 'Please provide your information',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        minLength: 1
                    },
                    email: {
                        type: 'string',
                        minLength: 1
                    },
                    age: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 150
                    }
                },
                required: ['name', 'email']
            }
        })
    ).resolves.toEqual({
        action: 'accept',
        content: {
            name: 'John Doe',
            email: 'john@example.com',
            age: 30
        }
    });
});

test('should reject elicitation response with invalid data', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            },
            enforceStrictCapabilities: true
        }
    );

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                elicitation: {}
            }
        }
    );

    // Set up client to return invalid response (missing required field, invalid age)
    client.setRequestHandler(ElicitRequestSchema, _request => ({
        action: 'accept',
        content: {
            email: '', // Invalid - too short
            age: -5 // Invalid age
        }
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Test with invalid response
    await expect(
        server.elicitInput({
            message: 'Please provide your information',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        minLength: 1
                    },
                    email: {
                        type: 'string',
                        minLength: 1
                    },
                    age: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 150
                    }
                },
                required: ['name', 'email']
            }
        })
    ).rejects.toThrow(/does not match requested schema/);
});

test('should allow elicitation reject and cancel without validation', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            },
            enforceStrictCapabilities: true
        }
    );

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                elicitation: {}
            }
        }
    );

    let requestCount = 0;
    client.setRequestHandler(ElicitRequestSchema, _request => {
        requestCount++;
        if (requestCount === 1) {
            return { action: 'decline' };
        } else {
            return { action: 'cancel' };
        }
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const schema = {
        type: 'object' as const,
        properties: {
            name: { type: 'string' as const }
        },
        required: ['name']
    };

    // Test reject - should not validate
    await expect(
        server.elicitInput({
            message: 'Please provide your name',
            requestedSchema: schema
        })
    ).resolves.toEqual({
        action: 'decline'
    });

    // Test cancel - should not validate
    await expect(
        server.elicitInput({
            message: 'Please provide your name',
            requestedSchema: schema
        })
    ).resolves.toEqual({
        action: 'cancel'
    });
});

test('should respect server notification capabilities', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                logging: {}
            },
            enforceStrictCapabilities: true
        }
    );

    const [_clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    // This should work because logging is supported by the server
    await expect(
        server.sendLoggingMessage({
            level: 'info',
            data: 'Test log message'
        })
    ).resolves.not.toThrow();

    // This should throw because resource notificaitons are not supported by the server
    await expect(server.sendResourceUpdated({ uri: 'test://resource' })).rejects.toThrow(/^Server does not support/);
});

test('should only allow setRequestHandler for declared capabilities', () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {}
            }
        }
    );

    // These should work because the capabilities are declared
    expect(() => {
        server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
    }).not.toThrow();

    expect(() => {
        server.setRequestHandler(ListResourcesRequestSchema, () => ({
            resources: []
        }));
    }).not.toThrow();

    // These should throw because the capabilities are not declared
    expect(() => {
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    }).toThrow(/^Server does not support tools/);

    expect(() => {
        server.setRequestHandler(SetLevelRequestSchema, () => ({}));
    }).toThrow(/^Server does not support logging/);
});

/*
  Test that custom request/notification/result schemas can be used with the Server class.
  */
test('should typecheck', () => {
    const GetWeatherRequestSchema = RequestSchema.extend({
        method: z.literal('weather/get'),
        params: z.object({
            city: z.string()
        })
    });

    const GetForecastRequestSchema = RequestSchema.extend({
        method: z.literal('weather/forecast'),
        params: z.object({
            city: z.string(),
            days: z.number()
        })
    });

    const WeatherForecastNotificationSchema = NotificationSchema.extend({
        method: z.literal('weather/alert'),
        params: z.object({
            severity: z.enum(['warning', 'watch']),
            message: z.string()
        })
    });

    const WeatherRequestSchema = GetWeatherRequestSchema.or(GetForecastRequestSchema);
    const WeatherNotificationSchema = WeatherForecastNotificationSchema;
    const WeatherResultSchema = ResultSchema.extend({
        temperature: z.number(),
        conditions: z.string()
    });

    type WeatherRequest = z.infer<typeof WeatherRequestSchema>;
    type WeatherNotification = z.infer<typeof WeatherNotificationSchema>;
    type WeatherResult = z.infer<typeof WeatherResultSchema>;

    // Create a typed Server for weather data
    const weatherServer = new Server<WeatherRequest, WeatherNotification, WeatherResult>(
        {
            name: 'WeatherServer',
            version: '1.0.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            }
        }
    );

    // Typecheck that only valid weather requests/notifications/results are allowed
    weatherServer.setRequestHandler(GetWeatherRequestSchema, _request => {
        return {
            temperature: 72,
            conditions: 'sunny'
        };
    });

    weatherServer.setNotificationHandler(WeatherForecastNotificationSchema, notification => {
        console.log(`Weather alert: ${notification.params.message}`);
    });
});

test('should handle server cancelling a request', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            }
        }
    );

    // Set up client to delay responding to createMessage
    client.setRequestHandler(CreateMessageRequestSchema, async (_request, _extra) => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return {
            model: 'test',
            role: 'assistant',
            content: {
                type: 'text',
                text: 'Test response'
            }
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Set up abort controller
    const controller = new AbortController();

    // Issue request but cancel it immediately
    const createMessagePromise = server.createMessage(
        {
            messages: [],
            maxTokens: 10
        },
        {
            signal: controller.signal
        }
    );
    controller.abort('Cancelled by test');

    // Request should be rejected with an McpError
    await expect(createMessagePromise).rejects.toThrow(McpError);
});

test('should handle request timeout', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    // Set up client that delays responses
    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            }
        }
    );

    client.setRequestHandler(CreateMessageRequestSchema, async (_request, extra) => {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(resolve, 100);
            extra.signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                reject(extra.signal.reason);
            });
        });

        return {
            model: 'test',
            role: 'assistant',
            content: {
                type: 'text',
                text: 'Test response'
            }
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Request with 0 msec timeout should fail immediately
    await expect(
        server.createMessage(
            {
                messages: [],
                maxTokens: 10
            },
            { timeout: 0 }
        )
    ).rejects.toMatchObject({
        code: ErrorCode.RequestTimeout
    });
});

/*
  Test automatic log level handling for transports with and without sessionId
 */
test('should respect log level for transport without sessionId', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            },
            enforceStrictCapabilities: true
        }
    );

    const client = new Client({
        name: 'test client',
        version: '1.0'
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(clientTransport.sessionId).toEqual(undefined);

    // Client sets logging level to warning
    await client.setLoggingLevel('warning');

    // This one will make it through
    const warningParams: LoggingMessageNotification['params'] = {
        level: 'warning',
        logger: 'test server',
        data: 'Warning message'
    };

    // This one will not
    const debugParams: LoggingMessageNotification['params'] = {
        level: 'debug',
        logger: 'test server',
        data: 'Debug message'
    };

    // Test the one that makes it through
    clientTransport.onmessage = vi.fn().mockImplementation(message => {
        expect(message).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: warningParams
        });
    });

    // This one will not make it through
    await server.sendLoggingMessage(debugParams);
    expect(clientTransport.onmessage).not.toHaveBeenCalled();

    // This one will, triggering the above test in clientTransport.onmessage
    await server.sendLoggingMessage(warningParams);
    expect(clientTransport.onmessage).toHaveBeenCalled();
});

test('should respect log level for transport with sessionId', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            },
            enforceStrictCapabilities: true
        }
    );

    const client = new Client({
        name: 'test client',
        version: '1.0'
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Add a session id to the transports
    const SESSION_ID = 'test-session-id';
    clientTransport.sessionId = SESSION_ID;
    serverTransport.sessionId = SESSION_ID;

    expect(clientTransport.sessionId).toBeDefined();
    expect(serverTransport.sessionId).toBeDefined();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Client sets logging level to warning
    await client.setLoggingLevel('warning');

    // This one will make it through
    const warningParams: LoggingMessageNotification['params'] = {
        level: 'warning',
        logger: 'test server',
        data: 'Warning message'
    };

    // This one will not
    const debugParams: LoggingMessageNotification['params'] = {
        level: 'debug',
        logger: 'test server',
        data: 'Debug message'
    };

    // Test the one that makes it through
    clientTransport.onmessage = vi.fn().mockImplementation(message => {
        expect(message).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: warningParams
        });
    });

    // This one will not make it through
    await server.sendLoggingMessage(debugParams, SESSION_ID);
    expect(clientTransport.onmessage).not.toHaveBeenCalled();

    // This one will, triggering the above test in clientTransport.onmessage
    await server.sendLoggingMessage(warningParams, SESSION_ID);
    expect(clientTransport.onmessage).toHaveBeenCalled();
});

describe('Task-based execution', () => {
    test('server with TaskStore should handle task-based tool execution', async () => {
        const taskStore = new InMemoryTaskStore();

        const server = new McpServer(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            }
                        }
                    }
                },
                taskStore
            }
        );

        // Register a tool using registerToolTask
        server.registerToolTask(
            'test-tool',
            {
                description: 'A test tool',
                inputSchema: {}
            },
            {
                async createTask(_args, extra) {
                    const task = await extra.taskStore.createTask(
                        {
                            ttl: extra.taskRequestedTtl
                        },
                        extra.requestId,
                        { method: 'tools/call', params: { name: 'test-tool', arguments: {} } }
                    );

                    // Simulate some async work
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, 10));
                        const result = {
                            content: [{ type: 'text', text: 'Tool executed successfully!' }]
                        };
                        await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
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
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            }
                        }
                    }
                }
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Use callTool to create a task
        await client.callTool({ name: 'test-tool', arguments: {} }, CallToolResultSchema, {
            task: {
                ttl: 60000
            }
        });

        // Wait for the task to complete
        await new Promise(resolve => setTimeout(resolve, 50));

        // Get the task ID from the task list since it's generated automatically
        const taskList = await client.listTasks();
        expect(taskList.tasks.length).toBeGreaterThan(0);
        const taskId = taskList.tasks[0].taskId;

        // Verify we can retrieve the task
        const task = await client.getTask({ taskId });
        expect(task).toBeDefined();
        expect(task.status).toBe('completed');

        // Verify we can retrieve the result
        const result = await client.getTaskResult({ taskId }, CallToolResultSchema);
        expect(result.content).toEqual([{ type: 'text', text: 'Tool executed successfully!' }]);

        // Cleanup
        taskStore.cleanup();
    });

    test('server without TaskStore should reject task-based requests', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
                // No taskStore configured
            }
        );

        server.setRequestHandler(CallToolRequestSchema, async request => {
            if (request.params.name === 'test-tool') {
                return {
                    content: [{ type: 'text', text: 'Success!' }]
                };
            }
            throw new Error('Unknown tool');
        });

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'test-tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                }
            ]
        }));

        const client = new Client(
            {
                name: 'test-client',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            }
                        }
                    }
                }
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Try to get a task when server doesn't have TaskStore
        // The server will return a "Method not found" error
        await expect(client.getTask({ taskId: 'non-existent' })).rejects.toThrow('Method not found');
    });

    test('should automatically attach related-task metadata to nested requests during tool execution', async () => {
        const taskStore = new InMemoryTaskStore();

        const server = new McpServer(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            }
                        }
                    }
                },
                taskStore
            }
        );

        const client = new Client(
            {
                name: 'test-client',
                version: '1.0.0'
            },
            {
                capabilities: {
                    elicitation: {},
                    tasks: {
                        requests: {
                            elicitation: {
                                create: {}
                            }
                        }
                    }
                }
            }
        );

        // Track the elicitation request to verify related-task metadata
        let capturedElicitRequest: z.infer<typeof ElicitRequestSchema> | null = null;

        // Set up client elicitation handler
        client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
            let taskId: string | undefined;

            // Check if task creation is requested
            if (request.params.task && extra.taskStore) {
                const createdTask = await extra.taskStore.createTask(
                    {
                        ttl: extra.taskRequestedTtl
                    },
                    extra.requestId,
                    request
                );
                taskId = createdTask.taskId;
            }

            // Capture the request to verify metadata later
            capturedElicitRequest = request;

            return {
                action: 'accept',
                content: {
                    username: 'test-user'
                }
            };
        });

        // Register a tool using registerToolTask that makes a nested elicitation request
        server.registerToolTask(
            'collect-info',
            {
                description: 'Collects user info via elicitation',
                inputSchema: {}
            },
            {
                async createTask(_args, extra) {
                    const task = await extra.taskStore.createTask(
                        {
                            ttl: extra.taskRequestedTtl
                        },
                        extra.requestId,
                        { method: 'tools/call', params: { name: 'collect-info', arguments: {} } }
                    );

                    // Perform async work that makes a nested request
                    (async () => {
                        // During tool execution, make a nested request to the client using extra.sendRequest
                        const elicitResult = await extra.sendRequest(
                            {
                                method: 'elicitation/create',
                                params: {
                                    message: 'Please provide your username',
                                    requestedSchema: {
                                        type: 'object',
                                        properties: {
                                            username: { type: 'string' }
                                        },
                                        required: ['username']
                                    }
                                }
                            },
                            ElicitResultSchema
                        );

                        const result = {
                            content: [
                                {
                                    type: 'text',
                                    text: `Collected username: ${elicitResult.action === 'accept' && elicitResult.content ? (elicitResult.content as Record<string, unknown>).username : 'none'}`
                                }
                            ]
                        };
                        await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
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

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Call tool WITH task creation
        await client.callTool({ name: 'collect-info', arguments: {} }, CallToolResultSchema, {
            task: {
                ttl: 60000
            }
        });

        // Wait for completion
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify the nested elicitation request was made (related-task metadata is no longer automatically attached)
        expect(capturedElicitRequest).toBeDefined();

        // Get the task ID from the task list since it's generated automatically
        const taskList = await client.listTasks();
        expect(taskList.tasks.length).toBeGreaterThan(0);
        const taskId = taskList.tasks[0].taskId;

        // Verify tool result was correct
        const result = await client.getTaskResult({ taskId }, CallToolResultSchema);
        expect(result.content).toEqual([
            {
                type: 'text',
                text: 'Collected username: test-user'
            }
        ]);

        // Cleanup
        taskStore.cleanup();
    });

    describe('Server calling client via elicitation', () => {
        let clientTaskStore: InMemoryTaskStore;

        beforeEach(() => {
            clientTaskStore = new InMemoryTaskStore();
        });

        afterEach(() => {
            clientTaskStore?.cleanup();
        });

        test('should create task on client via elicitation', async () => {
            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {},
                        tasks: {
                            requests: {
                                elicitation: {
                                    create: {}
                                }
                            }
                        }
                    },
                    taskStore: clientTaskStore
                }
            );

            client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
                let taskId: string | undefined;

                // Check if task creation is requested
                if (request.params.task && extra.taskStore) {
                    const createdTask = await extra.taskStore.createTask(
                        {
                            ttl: extra.taskRequestedTtl
                        },
                        extra.requestId,
                        request
                    );
                    taskId = createdTask.taskId;
                }
                const result = {
                    action: 'accept',
                    content: { username: 'server-test-user', confirmed: true }
                };
                if (taskId && extra.taskStore) {
                    await extra.taskStore.storeTaskResult(taskId, 'completed', result);
                }
                return result;
            });

            const server = new Server({
                name: 'test-server',
                version: '1.0.0'
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Server creates task on client via elicitation
            const ElicitResultSchema = z.object({
                action: z.enum(['accept', 'decline', 'cancel']),
                content: z.record(z.unknown()).optional()
            });

            await server.request(
                {
                    method: 'elicitation/create',
                    params: {
                        message: 'Please provide your username',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                username: { type: 'string' },
                                confirmed: { type: 'boolean' }
                            },
                            required: ['username']
                        }
                    }
                },
                ElicitResultSchema,
                { task: { ttl: 60000 } }
            );

            // Get the task ID from the task list since it's generated automatically
            const taskList = await server.listTasks();
            expect(taskList.tasks.length).toBeGreaterThan(0);
            const taskId = taskList.tasks[0].taskId;

            // Verify task was created
            const task = await server.getTask({ taskId });
            expect(task.status).toBe('completed');
        });

        test('should query task from client using getTask', async () => {
            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {},
                        tasks: {
                            requests: {
                                elicitation: {
                                    create: {}
                                }
                            }
                        }
                    },
                    taskStore: clientTaskStore
                }
            );

            client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
                let taskId: string | undefined;

                // Check if task creation is requested
                if (request.params.task && extra.taskStore) {
                    const createdTask = await extra.taskStore.createTask(
                        {
                            ttl: extra.taskRequestedTtl
                        },
                        extra.requestId,
                        request
                    );
                    taskId = createdTask.taskId;
                }
                const result = {
                    action: 'accept',
                    content: { username: 'list-user' }
                };
                if (taskId && extra.taskStore) {
                    await extra.taskStore.storeTaskResult(taskId, 'completed', result);
                }
                return result;
            });

            const server = new Server({
                name: 'test-server',
                version: '1.0.0'
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Create task
            const ElicitResultSchema = z.object({
                action: z.enum(['accept', 'decline', 'cancel']),
                content: z.record(z.unknown()).optional()
            });

            await server.request(
                {
                    method: 'elicitation/create',
                    params: {
                        message: 'Provide info',
                        requestedSchema: {
                            type: 'object',
                            properties: { username: { type: 'string' } }
                        }
                    }
                },
                ElicitResultSchema,
                { task: { ttl: 60000 } }
            );

            // Get the task ID from the task list since it's generated automatically
            const taskList = await server.listTasks();
            expect(taskList.tasks.length).toBeGreaterThan(0);
            const taskId = taskList.tasks[0].taskId;

            // Query task
            const task = await server.getTask({ taskId });
            expect(task).toBeDefined();
            expect(task.taskId).toBe(taskId);
            expect(task.status).toBe('completed');
        });

        test('should query task result from client using getTaskResult', async () => {
            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {},
                        tasks: {
                            requests: {
                                elicitation: {
                                    create: {}
                                }
                            }
                        }
                    },
                    taskStore: clientTaskStore
                }
            );

            client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
                let taskId: string | undefined;

                // Check if task creation is requested
                if (request.params.task && extra.taskStore) {
                    const createdTask = await extra.taskStore.createTask(
                        {
                            ttl: extra.taskRequestedTtl
                        },
                        extra.requestId,
                        request
                    );
                    taskId = createdTask.taskId;
                }
                const result = {
                    action: 'accept',
                    content: { username: 'result-user', confirmed: true }
                };
                if (taskId && extra.taskStore) {
                    await extra.taskStore.storeTaskResult(taskId, 'completed', result);
                }
                return result;
            });

            const server = new Server({
                name: 'test-server',
                version: '1.0.0'
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Create task
            const ElicitResultSchema = z.object({
                action: z.enum(['accept', 'decline', 'cancel']),
                content: z.record(z.unknown()).optional()
            });

            await server.request(
                {
                    method: 'elicitation/create',
                    params: {
                        message: 'Provide info',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                username: { type: 'string' },
                                confirmed: { type: 'boolean' }
                            }
                        }
                    }
                },
                ElicitResultSchema,
                { task: { ttl: 60000 } }
            );

            // Get the task ID from the task list since it's generated automatically
            const taskList = await server.listTasks();
            expect(taskList.tasks.length).toBeGreaterThan(0);
            const taskId = taskList.tasks[0].taskId;

            // Query result
            const result = await server.getTaskResult({ taskId }, ElicitResultSchema);
            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ username: 'result-user', confirmed: true });
        });

        test('should query task list from client using listTasks', async () => {
            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {},
                        tasks: {
                            requests: {
                                elicitation: {
                                    create: {}
                                }
                            }
                        }
                    },
                    taskStore: clientTaskStore
                }
            );

            client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
                let taskId: string | undefined;

                // Check if task creation is requested
                if (request.params.task && extra.taskStore) {
                    const createdTask = await extra.taskStore.createTask(
                        {
                            ttl: extra.taskRequestedTtl
                        },
                        extra.requestId,
                        request
                    );
                    taskId = createdTask.taskId;
                }
                const result = {
                    action: 'accept',
                    content: { username: 'list-user' }
                };
                if (taskId && extra.taskStore) {
                    await extra.taskStore.storeTaskResult(taskId, 'completed', result);
                }
                return result;
            });

            const server = new Server(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        tasks: {
                            requests: {
                                elicitation: {
                                    create: {}
                                }
                            }
                        }
                    }
                }
            );

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Create multiple tasks
            const ElicitResultSchema = z.object({
                action: z.enum(['accept', 'decline', 'cancel']),
                content: z.record(z.unknown()).optional()
            });

            const createdTaskIds: string[] = [];
            for (let i = 0; i < 2; i++) {
                await server.request(
                    {
                        method: 'elicitation/create',
                        params: {
                            message: 'Provide info',
                            requestedSchema: {
                                type: 'object',
                                properties: { username: { type: 'string' } }
                            }
                        }
                    },
                    ElicitResultSchema,
                    { task: { ttl: 60000 } }
                );

                // Get the task ID from the task list
                const taskList = await server.listTasks();
                const newTask = taskList.tasks.find(t => !createdTaskIds.includes(t.taskId));
                if (newTask) {
                    createdTaskIds.push(newTask.taskId);
                }
            }

            // Query task list
            const taskList = await server.listTasks();
            expect(taskList.tasks.length).toBeGreaterThanOrEqual(2);
            for (const taskId of createdTaskIds) {
                expect(taskList.tasks).toContainEqual(
                    expect.objectContaining({
                        taskId,
                        status: 'completed'
                    })
                );
            }
        });
    });

    test('should handle multiple concurrent task-based tool calls', async () => {
        const taskStore = new InMemoryTaskStore();

        const server = new McpServer(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            }
                        }
                    }
                },
                taskStore
            }
        );

        // Register a tool using registerToolTask with variable delay
        server.registerToolTask(
            'async-tool',
            {
                description: 'An async test tool',
                inputSchema: {
                    delay: z.number().optional().default(10),
                    taskNum: z.number().optional()
                }
            },
            {
                async createTask({ delay, taskNum }, extra) {
                    const task = await extra.taskStore.createTask(
                        {
                            ttl: extra.taskRequestedTtl
                        },
                        extra.requestId,
                        { method: 'tools/call', params: { name: 'async-tool', arguments: { delay, taskNum } } }
                    );

                    // Simulate async work
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, delay));
                        const result = {
                            content: [{ type: 'text', text: `Completed task ${taskNum || 'unknown'}` }]
                        };
                        await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
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
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            }
                        }
                    }
                }
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Create multiple tasks concurrently
        const pendingRequests = Array.from({ length: 4 }, (_, index) =>
            client.callTool({ name: 'async-tool', arguments: { delay: 10 + index * 5, taskNum: index + 1 } }, CallToolResultSchema, {
                task: { ttl: 60000 }
            })
        );

        // Wait for all tasks to complete
        await Promise.all(pendingRequests);

        // Wait a bit more to ensure all tasks are completed
        await new Promise(resolve => setTimeout(resolve, 50));

        // Get all task IDs from the task list
        const taskList = await client.listTasks();
        expect(taskList.tasks.length).toBeGreaterThanOrEqual(4);
        const taskIds = taskList.tasks.map(t => t.taskId);

        // Verify all tasks completed successfully
        for (let i = 0; i < taskIds.length; i++) {
            const task = await client.getTask({ taskId: taskIds[i] });
            expect(task.status).toBe('completed');
            expect(task.taskId).toBe(taskIds[i]);

            const result = await client.getTaskResult({ taskId: taskIds[i] }, CallToolResultSchema);
            expect(result.content).toEqual([{ type: 'text', text: `Completed task ${i + 1}` }]);
        }

        // Verify listTasks returns all tasks
        const finalTaskList = await client.listTasks();
        for (const taskId of taskIds) {
            expect(finalTaskList.tasks).toContainEqual(expect.objectContaining({ taskId }));
        }

        // Cleanup
        taskStore.cleanup();
    });

    describe('Error scenarios', () => {
        let taskStore: InMemoryTaskStore;
        let clientTaskStore: InMemoryTaskStore;

        beforeEach(() => {
            taskStore = new InMemoryTaskStore();
            clientTaskStore = new InMemoryTaskStore();
        });

        afterEach(() => {
            taskStore?.cleanup();
            clientTaskStore?.cleanup();
        });

        test('should throw error when client queries non-existent task from server', async () => {
            const server = new Server(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        tools: {},
                        tasks: {
                            requests: {
                                tools: {
                                    call: {}
                                }
                            }
                        }
                    },
                    taskStore
                }
            );

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        tasks: {
                            requests: {
                                tools: {
                                    call: {}
                                }
                            }
                        }
                    }
                }
            );

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Try to query a task that doesn't exist
            await expect(client.getTask({ taskId: 'non-existent-task' })).rejects.toThrow();
        });

        test('should throw error when server queries non-existent task from client', async () => {
            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        elicitation: {},
                        tasks: {
                            requests: {
                                elicitation: {
                                    create: {}
                                }
                            }
                        }
                    },
                    taskStore: clientTaskStore
                }
            );

            client.setRequestHandler(ElicitRequestSchema, async () => ({
                action: 'accept',
                content: { username: 'test' }
            }));

            const server = new Server(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {
                        tasks: {
                            requests: {
                                elicitation: {
                                    create: {}
                                }
                            }
                        }
                    }
                }
            );

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Try to query a task that doesn't exist on client
            await expect(server.getTask({ taskId: 'non-existent-task' })).rejects.toThrow();
        });
    });
});

test('should respect client task capabilities', async () => {
    const clientTaskStore = new InMemoryTaskStore();

    const client = new Client(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            capabilities: {
                sampling: {},
                elicitation: {},
                tasks: {
                    requests: {
                        elicitation: {
                            create: {}
                        }
                    }
                }
            },
            taskStore: clientTaskStore
        }
    );

    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        let taskId: string | undefined;

        // Check if task creation is requested
        if (request.params.task && extra.taskStore) {
            const createdTask = await extra.taskStore.createTask(
                {
                    ttl: extra.taskRequestedTtl
                },
                extra.requestId,
                request
            );
            taskId = createdTask.taskId;
        }
        const result = {
            action: 'accept',
            content: { username: 'test-user' }
        };
        if (taskId && extra.taskStore) {
            await extra.taskStore.storeTaskResult(taskId, 'completed', result);
        }
        return result;
    });

    const server = new Server(
        {
            name: 'test-server',
            version: '1.0.0'
        },
        {
            capabilities: {
                tasks: {
                    requests: {
                        elicitation: {
                            create: {}
                        }
                    }
                }
            },
            enforceStrictCapabilities: true
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Client supports task creation for elicitation/create and task methods
    expect(server.getClientCapabilities()).toEqual({
        sampling: {},
        elicitation: {},
        tasks: {
            requests: {
                elicitation: {
                    create: {}
                }
            }
        }
    });

    const ElicitResultSchema = z.object({
        action: z.enum(['accept', 'decline', 'cancel']),
        content: z.record(z.unknown()).optional()
    });

    // These should work because client supports tasks
    await expect(
        server.request(
            {
                method: 'elicitation/create',
                params: {
                    message: 'Test',
                    requestedSchema: {
                        type: 'object',
                        properties: { username: { type: 'string' } }
                    }
                }
            },
            ElicitResultSchema,
            { task: { ttl: 60000 } }
        )
    ).resolves.not.toThrow();
    await expect(server.listTasks()).resolves.not.toThrow();

    // Get the task ID from the task list since it's generated automatically
    const taskList = await server.listTasks();
    expect(taskList.tasks.length).toBeGreaterThan(0);
    const taskId = taskList.tasks[0].taskId;
    await expect(server.getTask({ taskId })).resolves.not.toThrow();

    // This should throw because client doesn't support task creation for sampling/createMessage
    await expect(
        server.request(
            {
                method: 'sampling/createMessage',
                params: {
                    messages: [],
                    maxTokens: 10
                }
            },
            z.object({
                model: z.string(),
                role: z.string(),
                content: z.any()
            }),
            { task: { taskId: 'test-task-2', keepAlive: 60000 } }
        )
    ).rejects.toThrow('Client does not support task creation for sampling/createMessage');

    clientTaskStore.cleanup();
});
