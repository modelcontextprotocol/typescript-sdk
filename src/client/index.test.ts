/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-constant-binary-expression */
/* eslint-disable @typescript-eslint/no-unused-expressions */
import { Client } from './index.js';
import { z } from 'zod';
import {
    RequestSchema,
    NotificationSchema,
    ResultSchema,
    LATEST_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    InitializeRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    CallToolRequestSchema,
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    ListRootsRequestSchema,
    ErrorCode
} from '../types.js';
import { Transport } from '../shared/transport.js';
import { Server } from '../server/index.js';
import { InMemoryTransport } from '../inMemory.js';

/***
 * Test: Initialize with Matching Protocol Version
 */
test('should initialize with matching protocol version', async () => {
    const clientTransport: Transport = {
        start: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockImplementation(message => {
            if (message.method === 'initialize') {
                clientTransport.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: LATEST_PROTOCOL_VERSION,
                        capabilities: {},
                        serverInfo: {
                            name: 'test',
                            version: '1.0'
                        },
                        instructions: 'test instructions'
                    }
                });
            }
            return Promise.resolve();
        })
    };

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

    await client.connect(clientTransport);

    // Should have sent initialize with latest version
    expect(clientTransport.send).toHaveBeenCalledWith(
        expect.objectContaining({
            method: 'initialize',
            params: expect.objectContaining({
                protocolVersion: LATEST_PROTOCOL_VERSION
            })
        }),
        expect.objectContaining({
            relatedRequestId: undefined
        })
    );

    // Should have the instructions returned
    expect(client.getInstructions()).toEqual('test instructions');
});

/***
 * Test: Initialize with Supported Older Protocol Version
 */
test('should initialize with supported older protocol version', async () => {
    const OLD_VERSION = SUPPORTED_PROTOCOL_VERSIONS[1];
    const clientTransport: Transport = {
        start: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockImplementation(message => {
            if (message.method === 'initialize') {
                clientTransport.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: OLD_VERSION,
                        capabilities: {},
                        serverInfo: {
                            name: 'test',
                            version: '1.0'
                        }
                    }
                });
            }
            return Promise.resolve();
        })
    };

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

    await client.connect(clientTransport);

    // Connection should succeed with the older version
    expect(client.getServerVersion()).toEqual({
        name: 'test',
        version: '1.0'
    });

    // Expect no instructions
    expect(client.getInstructions()).toBeUndefined();
});

/***
 * Test: Reject Unsupported Protocol Version
 */
test('should reject unsupported protocol version', async () => {
    const clientTransport: Transport = {
        start: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockImplementation(message => {
            if (message.method === 'initialize') {
                clientTransport.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: 'invalid-version',
                        capabilities: {},
                        serverInfo: {
                            name: 'test',
                            version: '1.0'
                        }
                    }
                });
            }
            return Promise.resolve();
        })
    };

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

    await expect(client.connect(clientTransport)).rejects.toThrow("Server's protocol version is not supported: invalid-version");

    expect(clientTransport.close).toHaveBeenCalled();
});

/***
 * Test: Connect New Client to Old Supported Server Version
 */
test('should connect new client to old, supported server version', async () => {
    const OLD_VERSION = SUPPORTED_PROTOCOL_VERSIONS[1];
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {},
                tools: {}
            }
        }
    );

    server.setRequestHandler(InitializeRequestSchema, _request => ({
        protocolVersion: OLD_VERSION,
        capabilities: {
            resources: {},
            tools: {}
        },
        serverInfo: {
            name: 'old server',
            version: '1.0'
        }
    }));

    server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: []
    }));

    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: []
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
        {
            name: 'new client',
            version: '1.0',
            protocolVersion: LATEST_PROTOCOL_VERSION
        },
        {
            capabilities: {
                sampling: {}
            },
            enforceStrictCapabilities: true
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(client.getServerVersion()).toEqual({
        name: 'old server',
        version: '1.0'
    });
});

/***
 * Test: Version Negotiation with Old Client and Newer Server
 */
test('should negotiate version when client is old, and newer server supports its version', async () => {
    const OLD_VERSION = SUPPORTED_PROTOCOL_VERSIONS[1];
    const server = new Server(
        {
            name: 'new server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {},
                tools: {}
            }
        }
    );

    server.setRequestHandler(InitializeRequestSchema, _request => ({
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {
            resources: {},
            tools: {}
        },
        serverInfo: {
            name: 'new server',
            version: '1.0'
        }
    }));

    server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: []
    }));

    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: []
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
        {
            name: 'old client',
            version: '1.0',
            protocolVersion: OLD_VERSION
        },
        {
            capabilities: {
                sampling: {}
            },
            enforceStrictCapabilities: true
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(client.getServerVersion()).toEqual({
        name: 'new server',
        version: '1.0'
    });
});

/***
 * Test: Throw when Old Client and Server Version Mismatch
 */
test("should throw when client is old, and server doesn't support its version", async () => {
    const OLD_VERSION = SUPPORTED_PROTOCOL_VERSIONS[1];
    const FUTURE_VERSION = 'FUTURE_VERSION';
    const server = new Server(
        {
            name: 'new server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {},
                tools: {}
            }
        }
    );

    server.setRequestHandler(InitializeRequestSchema, _request => ({
        protocolVersion: FUTURE_VERSION,
        capabilities: {
            resources: {},
            tools: {}
        },
        serverInfo: {
            name: 'new server',
            version: '1.0'
        }
    }));

    server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: []
    }));

    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: []
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
        {
            name: 'old client',
            version: '1.0',
            protocolVersion: OLD_VERSION
        },
        {
            capabilities: {
                sampling: {}
            },
            enforceStrictCapabilities: true
        }
    );

    await Promise.all([
        expect(client.connect(clientTransport)).rejects.toThrow("Server's protocol version is not supported: FUTURE_VERSION"),
        server.connect(serverTransport)
    ]);
});

/***
 * Test: Respect Server Capabilities
 */
test('should respect server capabilities', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {},
                tools: {}
            }
        }
    );

    server.setRequestHandler(InitializeRequestSchema, _request => ({
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {
            resources: {},
            tools: {}
        },
        serverInfo: {
            name: 'test',
            version: '1.0'
        }
    }));

    server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: []
    }));

    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: []
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            },
            enforceStrictCapabilities: true
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Server supports resources and tools, but not prompts
    expect(client.getServerCapabilities()).toEqual({
        resources: {},
        tools: {}
    });

    // These should work
    await expect(client.listResources()).resolves.not.toThrow();
    await expect(client.listTools()).resolves.not.toThrow();

    // These should throw because prompts, logging, and completions are not supported
    await expect(client.listPrompts()).rejects.toThrow('Server does not support prompts');
    await expect(client.setLoggingLevel('error')).rejects.toThrow('Server does not support logging');
    await expect(
        client.complete({
            ref: { type: 'ref/prompt', name: 'test' },
            argument: { name: 'test', value: 'test' }
        })
    ).rejects.toThrow('Server does not support completions');
});

/***
 * Test: Respect Client Notification Capabilities
 */
test('should respect client notification capabilities', async () => {
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
                roots: {
                    listChanged: true
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // This should work because the client has the roots.listChanged capability
    await expect(client.sendRootsListChanged()).resolves.not.toThrow();

    // Create a new client without the roots.listChanged capability
    const clientWithoutCapability = new Client(
        {
            name: 'test client without capability',
            version: '1.0'
        },
        {
            capabilities: {},
            enforceStrictCapabilities: true
        }
    );

    await clientWithoutCapability.connect(clientTransport);

    // This should throw because the client doesn't have the roots.listChanged capability
    await expect(clientWithoutCapability.sendRootsListChanged()).rejects.toThrow(/^Client does not support/);
});

/***
 * Test: Respect Server Notification Capabilities
 */
test('should respect server notification capabilities', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                logging: {},
                resources: {
                    listChanged: true
                }
            }
        }
    );

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // These should work because the server has the corresponding capabilities
    await expect(server.sendLoggingMessage({ level: 'info', data: 'Test' })).resolves.not.toThrow();
    await expect(server.sendResourceListChanged()).resolves.not.toThrow();

    // This should throw because the server doesn't have the tools capability
    await expect(server.sendToolListChanged()).rejects.toThrow('Server does not support notifying of tool list changes');
});

/***
 * Test: Only Allow setRequestHandler for Declared Capabilities
 */
test('should only allow setRequestHandler for declared capabilities', () => {
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

    // This should work because sampling is a declared capability
    expect(() => {
        client.setRequestHandler(CreateMessageRequestSchema, () => ({
            model: 'test-model',
            role: 'assistant',
            content: {
                type: 'text',
                text: 'Test response'
            }
        }));
    }).not.toThrow();

    // This should throw because roots listing is not a declared capability
    expect(() => {
        client.setRequestHandler(ListRootsRequestSchema, () => ({}));
    }).toThrow('Client does not support roots capability');
});

test('should allow setRequestHandler for declared elicitation capability', () => {
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

    // This should work because elicitation is a declared capability
    expect(() => {
        client.setRequestHandler(ElicitRequestSchema, () => ({
            action: 'accept',
            content: {
                username: 'test-user',
                confirmed: true
            }
        }));
    }).not.toThrow();

    // This should throw because sampling is not a declared capability
    expect(() => {
        client.setRequestHandler(CreateMessageRequestSchema, () => ({
            model: 'test-model',
            role: 'assistant',
            content: {
                type: 'text',
                text: 'Test response'
            }
        }));
    }).toThrow('Client does not support sampling capability');
});

/***
 * Test: Type Checking
 * Test that custom request/notification/result schemas can be used with the Client class.
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

    // Create a typed Client for weather data
    const weatherClient = new Client<WeatherRequest, WeatherNotification, WeatherResult>(
        {
            name: 'WeatherClient',
            version: '1.0.0'
        },
        {
            capabilities: {
                sampling: {}
            }
        }
    );

    // Typecheck that only valid weather requests/notifications/results are allowed
    false &&
        weatherClient.request(
            {
                method: 'weather/get',
                params: {
                    city: 'Seattle'
                }
            },
            WeatherResultSchema
        );

    false &&
        weatherClient.notification({
            method: 'weather/alert',
            params: {
                severity: 'warning',
                message: 'Storm approaching'
            }
        });
});

/***
 * Test: Handle Client Cancelling a Request
 */
test('should handle client cancelling a request', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {}
            }
        }
    );

    // Set up server to delay responding to listResources
    server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return {
            resources: []
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Set up abort controller
    const controller = new AbortController();

    // Issue request but cancel it immediately
    const listResourcesPromise = client.listResources(undefined, {
        signal: controller.signal
    });
    controller.abort('Cancelled by test');

    // Request should be rejected
    await expect(listResourcesPromise).rejects.toBe('Cancelled by test');
});

/***
 * Test: Handle Request Timeout
 */
test('should handle request timeout', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {}
            }
        }
    );

    // Set up server with a delayed response
    server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
        const timer = new Promise(resolve => {
            const timeout = setTimeout(resolve, 100);
            extra.signal.addEventListener('abort', () => clearTimeout(timeout));
        });

        await timer;
        return {
            resources: []
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Request with 0 msec timeout should fail immediately
    await expect(client.listResources(undefined, { timeout: 0 })).rejects.toMatchObject({
        code: ErrorCode.RequestTimeout
    });
});

describe('outputSchema validation', () => {
    /***
     * Test: Validate structuredContent Against outputSchema
     */
    test('should validate structuredContent against outputSchema', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler(InitializeRequestSchema, async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'test-tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            result: { type: 'string' },
                            count: { type: 'number' }
                        },
                        required: ['result', 'count'],
                        additionalProperties: false
                    }
                }
            ]
        }));

        server.setRequestHandler(CallToolRequestSchema, async request => {
            if (request.params.name === 'test-tool') {
                return {
                    structuredContent: { result: 'success', count: 42 }
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should validate successfully
        const result = await client.callTool({ name: 'test-tool' });
        expect(result.structuredContent).toEqual({ result: 'success', count: 42 });
    });

    /***
     * Test: Throw Error when structuredContent Does Not Match Schema
     */
    test('should throw error when structuredContent does not match schema', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler(InitializeRequestSchema, async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'test-tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            result: { type: 'string' },
                            count: { type: 'number' }
                        },
                        required: ['result', 'count'],
                        additionalProperties: false
                    }
                }
            ]
        }));

        server.setRequestHandler(CallToolRequestSchema, async request => {
            if (request.params.name === 'test-tool') {
                // Return invalid structured content (count is string instead of number)
                return {
                    structuredContent: { result: 'success', count: 'not a number' }
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should throw validation error
        await expect(client.callTool({ name: 'test-tool' })).rejects.toThrow(/Structured content does not match the tool's output schema/);
    });

    /***
     * Test: Throw Error when Tool with outputSchema Returns No structuredContent
     */
    test('should throw error when tool with outputSchema returns no structuredContent', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler(InitializeRequestSchema, async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'test-tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            result: { type: 'string' }
                        },
                        required: ['result']
                    }
                }
            ]
        }));

        server.setRequestHandler(CallToolRequestSchema, async request => {
            if (request.params.name === 'test-tool') {
                // Return content instead of structuredContent
                return {
                    content: [{ type: 'text', text: 'This should be structured content' }]
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should throw error
        await expect(client.callTool({ name: 'test-tool' })).rejects.toThrow(
            /Tool test-tool has an output schema but did not return structured content/
        );
    });

    /***
     * Test: Handle Tools Without outputSchema Normally
     */
    test('should handle tools without outputSchema normally', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler(InitializeRequestSchema, async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'test-tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                    // No outputSchema
                }
            ]
        }));

        server.setRequestHandler(CallToolRequestSchema, async request => {
            if (request.params.name === 'test-tool') {
                // Return regular content
                return {
                    content: [{ type: 'text', text: 'Normal response' }]
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should work normally without validation
        const result = await client.callTool({ name: 'test-tool' });
        expect(result.content).toEqual([{ type: 'text', text: 'Normal response' }]);
    });

    /***
     * Test: Handle Complex JSON Schema Validation
     */
    test('should handle complex JSON schema validation', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler(InitializeRequestSchema, async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'complex-tool',
                    description: 'A tool with complex schema',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', minLength: 3 },
                            age: { type: 'integer', minimum: 0, maximum: 120 },
                            active: { type: 'boolean' },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                                minItems: 1
                            },
                            metadata: {
                                type: 'object',
                                properties: {
                                    created: { type: 'string' }
                                },
                                required: ['created']
                            }
                        },
                        required: ['name', 'age', 'active', 'tags', 'metadata'],
                        additionalProperties: false
                    }
                }
            ]
        }));

        server.setRequestHandler(CallToolRequestSchema, async request => {
            if (request.params.name === 'complex-tool') {
                return {
                    structuredContent: {
                        name: 'John Doe',
                        age: 30,
                        active: true,
                        tags: ['user', 'admin'],
                        metadata: {
                            created: '2023-01-01T00:00:00Z'
                        }
                    }
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should validate successfully
        const result = await client.callTool({ name: 'complex-tool' });
        expect(result.structuredContent).toBeDefined();
        const structuredContent = result.structuredContent as { name: string; age: number };
        expect(structuredContent.name).toBe('John Doe');
        expect(structuredContent.age).toBe(30);
    });

    /***
     * Test: Fail Validation with Additional Properties When Not Allowed
     */
    test('should fail validation with additional properties when not allowed', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler(InitializeRequestSchema, async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'strict-tool',
                    description: 'A tool with strict schema',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' }
                        },
                        required: ['name'],
                        additionalProperties: false
                    }
                }
            ]
        }));

        server.setRequestHandler(CallToolRequestSchema, async request => {
            if (request.params.name === 'strict-tool') {
                // Return structured content with extra property
                return {
                    structuredContent: {
                        name: 'John',
                        extraField: 'not allowed'
                    }
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should throw validation error due to additional property
        await expect(client.callTool({ name: 'strict-tool' })).rejects.toThrow(
            /Structured content does not match the tool's output schema/
        );
    });
});
