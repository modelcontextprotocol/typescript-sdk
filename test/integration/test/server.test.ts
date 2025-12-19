/* eslint-disable @typescript-eslint/no-unused-vars */
import { Client } from '@modelcontextprotocol/client';
import type {
    AnyObjectSchema,
    JsonSchemaType,
    JsonSchemaValidator,
    jsonSchemaValidator,
    LoggingMessageNotification,
    Transport
} from '@modelcontextprotocol/core';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    CreateMessageRequestSchema,
    CreateMessageResultSchema,
    CreateTaskResultSchema,
    ElicitationCompleteNotificationSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    ErrorCode,
    InMemoryTransport,
    LATEST_PROTOCOL_VERSION,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    McpError,
    NotificationSchema,
    RequestSchema,
    ResultSchema,
    SetLevelRequestSchema,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';
import { createMcpExpressApp, InMemoryTaskMessageQueue, InMemoryTaskStore, McpServer, Server } from '@modelcontextprotocol/server';
import supertest from 'supertest';
import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';

describe('Zod v3', () => {
    /*
    Test that custom request/notification/result schemas can be used with the Server class.
    */
    test('should typecheck', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const GetWeatherRequestSchema = (RequestSchema as unknown as z3.ZodObject<any>).extend({
            method: z3.literal('weather/get'),
            params: z3.object({
                city: z3.string()
            })
        }) as AnyObjectSchema;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const GetForecastRequestSchema = (RequestSchema as unknown as z3.ZodObject<any>).extend({
            method: z3.literal('weather/forecast'),
            params: z3.object({
                city: z3.string(),
                days: z3.number()
            })
        }) as AnyObjectSchema;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const WeatherForecastNotificationSchema = (NotificationSchema as unknown as z3.ZodObject<any>).extend({
            method: z3.literal('weather/alert'),
            params: z3.object({
                severity: z3.enum(['warning', 'watch']),
                message: z3.string()
            })
        }) as AnyObjectSchema;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const WeatherRequestSchema = (GetWeatherRequestSchema as unknown as z3.ZodObject<any>).or(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            GetForecastRequestSchema as unknown as z3.ZodObject<any>
        ) as AnyObjectSchema;
        const WeatherNotificationSchema = WeatherForecastNotificationSchema as AnyObjectSchema;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const WeatherResultSchema = (ResultSchema as unknown as z3.ZodObject<any>).extend({
            temperature: z3.number(),
            conditions: z3.string()
        }) as AnyObjectSchema;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type InferSchema<T> = T extends z3.ZodType<infer Output, any, any> ? Output : never;
        type WeatherRequest = InferSchema<typeof WeatherRequestSchema>;
        type WeatherNotification = InferSchema<typeof WeatherNotificationSchema>;
        type WeatherResult = InferSchema<typeof WeatherResultSchema>;

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
            // Type assertion needed for v3/v4 schema mixing
            const params = notification.params as { message: string; severity: 'warning' | 'watch' };
            console.log(`Weather alert: ${params.message}`);
        });
    });
});

describe('Zod v4', () => {
    test('should typecheck', () => {
        const GetWeatherRequestSchema = RequestSchema.extend({
            method: z4.literal('weather/get'),
            params: z4.object({
                city: z4.string()
            })
        });

        const GetForecastRequestSchema = RequestSchema.extend({
            method: z4.literal('weather/forecast'),
            params: z4.object({
                city: z4.string(),
                days: z4.number()
            })
        });

        const WeatherForecastNotificationSchema = NotificationSchema.extend({
            method: z4.literal('weather/alert'),
            params: z4.object({
                severity: z4.enum(['warning', 'watch']),
                message: z4.string()
            })
        });

        const WeatherRequestSchema = GetWeatherRequestSchema.or(GetForecastRequestSchema);
        const WeatherNotificationSchema = WeatherForecastNotificationSchema;
        const WeatherResultSchema = ResultSchema.extend({
            temperature: z4.number(),
            conditions: z4.string()
        });

        type WeatherRequest = z4.infer<typeof WeatherRequestSchema>;
        type WeatherNotification = z4.infer<typeof WeatherNotificationSchema>;
        type WeatherResult = z4.infer<typeof WeatherResultSchema>;

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
});

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

    // After schema parsing, empty elicitation object should have form capability injected
    expect(server.getClientCapabilities()).toEqual({ elicitation: { form: {} } });

    // This should work because elicitation is supported by the client
    await expect(
        server.elicitInput({
            mode: 'form',
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
    ).rejects.toThrow(/^Client does not support/);
});

test('should use elicitInput with mode: "form" by default for backwards compatibility', async () => {
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

    // After schema parsing, empty elicitation object should have form capability injected
    expect(server.getClientCapabilities()).toEqual({ elicitation: { form: {} } });

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

test('should throw when elicitInput is called without client form capability', async () => {
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
                elicitation: {
                    url: {} // No form mode capability
                }
            }
        }
    );

    client.setRequestHandler(ElicitRequestSchema, () => ({
        action: 'cancel'
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await expect(
        server.elicitInput({
            mode: 'form',
            message: 'Please provide your username',
            requestedSchema: {
                type: 'object',
                properties: {
                    username: {
                        type: 'string'
                    }
                }
            }
        })
    ).rejects.toThrow('Client does not support form elicitation.');
});

test('should throw when elicitInput is called without client URL capability', async () => {
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
                elicitation: {
                    form: {} // No URL mode capability
                }
            }
        }
    );

    client.setRequestHandler(ElicitRequestSchema, () => ({
        action: 'cancel'
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await expect(
        server.elicitInput({
            mode: 'url',
            message: 'Open the authorization URL',
            elicitationId: 'elicitation-001',
            url: 'https://example.com/auth'
        })
    ).rejects.toThrow('Client does not support url elicitation.');
});

test('should include form mode when sending elicitation form requests', async () => {
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
                elicitation: {
                    form: {}
                }
            }
        }
    );

    const receivedModes: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, request => {
        receivedModes.push(request.params.mode ?? '');
        return {
            action: 'accept',
            content: {
                confirmation: true
            }
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await expect(
        server.elicitInput({
            message: 'Confirm action',
            requestedSchema: {
                type: 'object',
                properties: {
                    confirmation: {
                        type: 'boolean'
                    }
                },
                required: ['confirmation']
            }
        })
    ).resolves.toEqual({
        action: 'accept',
        content: {
            confirmation: true
        }
    });

    expect(receivedModes).toEqual(['form']);
});

test('should include url mode when sending elicitation URL requests', async () => {
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
                elicitation: {
                    url: {}
                }
            }
        }
    );

    const receivedModes: string[] = [];
    const receivedIds: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, request => {
        receivedModes.push(request.params.mode ?? '');
        if (request.params.mode === 'url') {
            receivedIds.push(request.params.elicitationId);
        }
        return {
            action: 'decline'
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await expect(
        server.elicitInput({
            mode: 'url',
            message: 'Complete verification',
            elicitationId: 'elicitation-xyz',
            url: 'https://example.com/verify'
        })
    ).resolves.toEqual({
        action: 'decline'
    });

    expect(receivedModes).toEqual(['url']);
    expect(receivedIds).toEqual(['elicitation-xyz']);
});

test('should reject elicitInput when client response violates requested schema', async () => {
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
                elicitation: {
                    form: {}
                }
            }
        }
    );

    client.setRequestHandler(ElicitRequestSchema, () => ({
        action: 'accept',

        // Bad response: missing required field `username`
        content: {}
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await expect(
        server.elicitInput({
            message: 'Please provide your username',
            requestedSchema: {
                type: 'object',
                properties: {
                    username: {
                        type: 'string'
                    }
                },
                required: ['username']
            }
        })
    ).rejects.toThrow('Elicitation response content does not match requested schema');
});

test('should wrap unexpected validator errors during elicitInput', async () => {
    class ThrowingValidator implements jsonSchemaValidator {
        getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
            throw new Error('boom - validator exploded');
        }
    }

    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {},
            jsonSchemaValidator: new ThrowingValidator()
        }
    );

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                elicitation: {
                    form: {}
                }
            }
        }
    );

    client.setRequestHandler(ElicitRequestSchema, () => ({
        action: 'accept',
        content: {
            username: 'ignored'
        }
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await expect(
        server.elicitInput({
            mode: 'form',
            message: 'Provide any data',
            requestedSchema: {
                type: 'object',
                properties: {},
                required: []
            }
        })
    ).rejects.toThrow('MCP error -32603: Error validating elicitation response: boom - validator exploded');
});

test('should forward notification options when using elicitation completion notifier', async () => {
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
                elicitation: {
                    url: {}
                }
            }
        }
    );

    client.setNotificationHandler(ElicitationCompleteNotificationSchema, () => {});

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const notificationSpy = vi.spyOn(server, 'notification');

    const notifier = server.createElicitationCompletionNotifier('elicitation-789', { relatedRequestId: 42 });
    await notifier();

    expect(notificationSpy).toHaveBeenCalledWith(
        {
            method: 'notifications/elicitation/complete',
            params: {
                elicitationId: 'elicitation-789'
            }
        },
        expect.objectContaining({ relatedRequestId: 42 })
    );
});

test('should create notifier that emits elicitation completion notification', async () => {
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
                elicitation: {
                    url: {}
                }
            }
        }
    );

    const receivedIds: string[] = [];
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, notification => {
        receivedIds.push(notification.params.elicitationId);
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const notifier = server.createElicitationCompletionNotifier('elicitation-123');
    await notifier();

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(receivedIds).toEqual(['elicitation-123']);
});

test('should throw when creating notifier if client lacks URL elicitation support', async () => {
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
                elicitation: {
                    form: {}
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(() => server.createElicitationCompletionNotifier('elicitation-123')).toThrow(
        'Client does not support URL elicitation (required for notifications/elicitation/complete)'
    );
});

test('should apply back-compat form capability injection when client sends empty elicitation object', async () => {
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

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Verify that the schema preprocessing injected form capability
    const clientCapabilities = server.getClientCapabilities();
    expect(clientCapabilities).toBeDefined();
    expect(clientCapabilities?.elicitation).toBeDefined();
    expect(clientCapabilities?.elicitation?.form).toBeDefined();
    expect(clientCapabilities?.elicitation?.form).toEqual({});
    expect(clientCapabilities?.elicitation?.url).toBeUndefined();
});

test('should preserve form capability configuration when client enables applyDefaults', async () => {
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

    const client = new Client(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                elicitation: {
                    form: {
                        applyDefaults: true
                    }
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Verify that the schema preprocessing preserved the form capability configuration
    const clientCapabilities = server.getClientCapabilities();
    expect(clientCapabilities).toBeDefined();
    expect(clientCapabilities?.elicitation).toBeDefined();
    expect(clientCapabilities?.elicitation?.form).toBeDefined();
    expect(clientCapabilities?.elicitation?.form).toEqual({ applyDefaults: true });
    expect(clientCapabilities?.elicitation?.url).toBeUndefined();
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
            mode: 'form',
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
            mode: 'form',
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
            mode: 'form',
            message: 'Please provide your name',
            requestedSchema: schema
        })
    ).resolves.toEqual({
        action: 'decline'
    });

    // Test cancel - should not validate
    await expect(
        server.elicitInput({
            mode: 'form',
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

describe('createMessage validation', () => {
    test('should throw when tools are provided without sampling.tools capability', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client(
            { name: 'test client', version: '1.0' },
            { capabilities: { sampling: {} } } // No tools capability
        );

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.createMessage({
                messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
                maxTokens: 100,
                tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
            })
        ).rejects.toThrow('Client does not support sampling tools capability.');
    });

    test('should throw when toolChoice is provided without sampling.tools capability', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client(
            { name: 'test client', version: '1.0' },
            { capabilities: { sampling: {} } } // No tools capability
        );

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.createMessage({
                messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
                maxTokens: 100,
                toolChoice: { mode: 'auto' }
            })
        ).rejects.toThrow('Client does not support sampling tools capability.');
    });

    test('should throw when tool_result is mixed with other content', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.createMessage({
                messages: [
                    { role: 'user', content: { type: 'text', text: 'hello' } },
                    { role: 'assistant', content: { type: 'tool_use', id: 'call_1', name: 'test_tool', input: {} } },
                    {
                        role: 'user',
                        content: [
                            { type: 'tool_result', toolUseId: 'call_1', content: [] },
                            { type: 'text', text: 'mixed content' } // Mixed!
                        ]
                    }
                ],
                maxTokens: 100,
                tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
            })
        ).rejects.toThrow('The last message must contain only tool_result content if any is present');
    });

    test('should throw when tool_result has no matching tool_use in previous message', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // tool_result without previous tool_use
        await expect(
            server.createMessage({
                messages: [
                    { role: 'user', content: { type: 'text', text: 'hello' } },
                    { role: 'user', content: { type: 'tool_result', toolUseId: 'call_1', content: [] } }
                ],
                maxTokens: 100,
                tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
            })
        ).rejects.toThrow('tool_result blocks are not matching any tool_use from the previous message');
    });

    test('should throw when tool_result IDs do not match tool_use IDs', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.createMessage({
                messages: [
                    { role: 'user', content: { type: 'text', text: 'hello' } },
                    { role: 'assistant', content: { type: 'tool_use', id: 'call_1', name: 'test_tool', input: {} } },
                    { role: 'user', content: { type: 'tool_result', toolUseId: 'wrong_id', content: [] } }
                ],
                maxTokens: 100,
                tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
            })
        ).rejects.toThrow('ids of tool_result blocks and tool_use blocks from previous message do not match');
    });

    test('should allow text-only messages with tools (no tool_results)', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.createMessage({
                messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
                maxTokens: 100,
                tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
            })
        ).resolves.toMatchObject({ model: 'test-model' });
    });

    test('should allow valid matching tool_result/tool_use IDs', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.createMessage({
                messages: [
                    { role: 'user', content: { type: 'text', text: 'hello' } },
                    { role: 'assistant', content: { type: 'tool_use', id: 'call_1', name: 'test_tool', input: {} } },
                    { role: 'user', content: { type: 'tool_result', toolUseId: 'call_1', content: [] } }
                ],
                maxTokens: 100,
                tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
            })
        ).resolves.toMatchObject({ model: 'test-model' });
    });

    test('should throw when user sends text instead of tool_result after tool_use', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // User ignores tool_use and sends text instead
        await expect(
            server.createMessage({
                messages: [
                    { role: 'user', content: { type: 'text', text: 'hello' } },
                    { role: 'assistant', content: { type: 'tool_use', id: 'call_1', name: 'test_tool', input: {} } },
                    { role: 'user', content: { type: 'text', text: 'actually nevermind' } }
                ],
                maxTokens: 100,
                tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
            })
        ).rejects.toThrow('ids of tool_result blocks and tool_use blocks from previous message do not match');
    });

    test('should throw when only some tool_results are provided for parallel tool_use', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Parallel tool_use but only one tool_result provided
        await expect(
            server.createMessage({
                messages: [
                    { role: 'user', content: { type: 'text', text: 'hello' } },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'tool_use', id: 'call_1', name: 'tool_a', input: {} },
                            { type: 'tool_use', id: 'call_2', name: 'tool_b', input: {} }
                        ]
                    },
                    { role: 'user', content: { type: 'tool_result', toolUseId: 'call_1', content: [] } }
                ],
                maxTokens: 100,
                tools: [
                    { name: 'tool_a', inputSchema: { type: 'object' } },
                    { name: 'tool_b', inputSchema: { type: 'object' } }
                ]
            })
        ).rejects.toThrow('ids of tool_result blocks and tool_use blocks from previous message do not match');
    });

    test('should validate tool_use/tool_result even without tools in current request', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Previous request returned tool_use, now sending tool_result without tools param
        await expect(
            server.createMessage({
                messages: [
                    { role: 'user', content: { type: 'text', text: 'hello' } },
                    { role: 'assistant', content: { type: 'tool_use', id: 'call_1', name: 'test_tool', input: {} } },
                    { role: 'user', content: { type: 'tool_result', toolUseId: 'wrong_id', content: [] } }
                ],
                maxTokens: 100
                // Note: no tools param - this is a follow-up request after tool execution
            })
        ).rejects.toThrow('ids of tool_result blocks and tool_use blocks from previous message do not match');
    });

    test('should allow valid tool_use/tool_result without tools in current request', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Previous request returned tool_use, now sending matching tool_result without tools param
        await expect(
            server.createMessage({
                messages: [
                    { role: 'user', content: { type: 'text', text: 'hello' } },
                    { role: 'assistant', content: { type: 'tool_use', id: 'call_1', name: 'test_tool', input: {} } },
                    { role: 'user', content: { type: 'tool_result', toolUseId: 'call_1', content: [] } }
                ],
                maxTokens: 100
                // Note: no tools param - this is a follow-up request after tool execution
            })
        ).resolves.toMatchObject({ model: 'test-model' });
    });

    test('should handle empty messages array', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Empty messages array should not crash
        await expect(
            server.createMessage({
                messages: [],
                maxTokens: 100
            })
        ).resolves.toMatchObject({ model: 'test-model' });
    });
});

describe('createMessage backwards compatibility', () => {
    test('createMessage without tools returns single content (backwards compat)', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

        // Mock client returns single text content
        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Hello from LLM' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Call createMessage WITHOUT tools
        const result = await server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
            maxTokens: 100
        });

        // Backwards compat: result.content should be single (not array)
        expect(result.model).toBe('test-model');
        expect(Array.isArray(result.content)).toBe(false);
        expect(result.content.type).toBe('text');
        if (result.content.type === 'text') {
            expect(result.content.text).toBe('Hello from LLM');
        }
    });

    test('createMessage with tools accepts request and returns result', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        // Mock client returns text content (tool_use schema validation is tested in types.test.ts)
        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'I will use the weather tool' },
            stopReason: 'endTurn'
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Call createMessage WITH tools - verifies the overload works
        const result = await server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
            maxTokens: 100,
            tools: [{ name: 'get_weather', inputSchema: { type: 'object' } }]
        });

        // Verify result is returned correctly
        expect(result.model).toBe('test-model');
        expect(result.content).toMatchObject({ type: 'text', text: 'I will use the weather tool' });
        expect(result.content).not.toBeInstanceOf(Array);
    });
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

describe('createMcpExpressApp', () => {
    test('should create an Express app', () => {
        const app = createMcpExpressApp();
        expect(app).toBeDefined();
    });

    test('should parse JSON bodies', async () => {
        const app = createMcpExpressApp({ host: '0.0.0.0' }); // Disable host validation for this test
        app.post('/test', (req, res) => {
            res.json({ received: req.body });
        });

        const response = await supertest(app).post('/test').send({ hello: 'world' }).set('Content-Type', 'application/json');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ received: { hello: 'world' } });
    });

    test('should reject requests with invalid Host header by default', async () => {
        const app = createMcpExpressApp();
        app.post('/test', (_req, res) => {
            res.json({ success: true });
        });

        const response = await supertest(app).post('/test').set('Host', 'evil.com:3000').send({});

        expect(response.status).toBe(403);
        expect(response.body).toEqual({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Invalid Host: evil.com'
            },
            id: null
        });
    });

    test('should allow requests with localhost Host header', async () => {
        const app = createMcpExpressApp();
        app.post('/test', (_req, res) => {
            res.json({ success: true });
        });

        const response = await supertest(app).post('/test').set('Host', 'localhost:3000').send({});

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
    });

    test('should allow requests with 127.0.0.1 Host header', async () => {
        const app = createMcpExpressApp();
        app.post('/test', (_req, res) => {
            res.json({ success: true });
        });

        const response = await supertest(app).post('/test').set('Host', '127.0.0.1:3000').send({});

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
    });

    test('should not apply host validation when host is 0.0.0.0', async () => {
        const app = createMcpExpressApp({ host: '0.0.0.0' });
        app.post('/test', (_req, res) => {
            res.json({ success: true });
        });

        // Should allow any host when bound to 0.0.0.0
        const response = await supertest(app).post('/test').set('Host', 'any-host.com:3000').send({});

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
    });

    test('should apply host validation when host is explicitly localhost', async () => {
        const app = createMcpExpressApp({ host: 'localhost' });
        app.post('/test', (_req, res) => {
            res.json({ success: true });
        });

        // Should reject non-localhost hosts
        const response = await supertest(app).post('/test').set('Host', 'evil.com:3000').send({});

        expect(response.status).toBe(403);
    });

    test('should allow requests with IPv6 localhost Host header', async () => {
        const app = createMcpExpressApp();
        app.post('/test', (_req, res) => {
            res.json({ success: true });
        });

        const response = await supertest(app).post('/test').set('Host', '[::1]:3000').send({});

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
    });

    test('should apply host validation when host is ::1 (IPv6 localhost)', async () => {
        const app = createMcpExpressApp({ host: '::1' });
        app.post('/test', (_req, res) => {
            res.json({ success: true });
        });

        // Should reject non-localhost hosts
        const response = await supertest(app).post('/test').set('Host', 'evil.com:3000').send({});

        expect(response.status).toBe(403);
    });

    test('should warn when binding to 0.0.0.0', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        createMcpExpressApp({ host: '0.0.0.0' });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('0.0.0.0'));
        warnSpy.mockRestore();
    });

    test('should warn when binding to :: (IPv6 all interfaces)', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        createMcpExpressApp({ host: '::' });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('::'));
        warnSpy.mockRestore();
    });

    test('should use custom allowedHosts when provided', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local', 'localhost'] });
        app.post('/test', (_req, res) => {
            res.json({ success: true });
        });

        // Should not warn when allowedHosts is provided
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();

        // Should allow myapp.local
        const allowedResponse = await supertest(app).post('/test').set('Host', 'myapp.local:3000').send({});
        expect(allowedResponse.status).toBe(200);

        // Should reject other hosts
        const rejectedResponse = await supertest(app).post('/test').set('Host', 'evil.com:3000').send({});
        expect(rejectedResponse.status).toBe(403);
    });

    test('should override default localhost validation when allowedHosts is provided', async () => {
        // Even though host is localhost, we're using custom allowedHosts
        const app = createMcpExpressApp({ host: 'localhost', allowedHosts: ['custom.local'] });
        app.post('/test', (_req, res) => {
            res.json({ success: true });
        });

        // Should reject localhost since it's not in allowedHosts
        const response = await supertest(app).post('/test').set('Host', 'localhost:3000').send({});
        expect(response.status).toBe(403);

        // Should allow custom.local
        const allowedResponse = await supertest(app).post('/test').set('Host', 'custom.local:3000').send({});
        expect(allowedResponse.status).toBe(200);
    });
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
        server.experimental.tasks.registerToolTask(
            'test-tool',
            {
                description: 'A test tool',
                inputSchema: {}
            },
            {
                async createTask(_args, extra) {
                    const task = await extra.taskStore.createTask({
                        ttl: extra.taskRequestedTtl
                    });

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

        // Use callToolStream to create a task and capture the task ID
        let taskId: string | undefined;
        const stream = client.experimental.tasks.callToolStream({ name: 'test-tool', arguments: {} }, CallToolResultSchema, {
            task: {
                ttl: 60000
            }
        });

        for await (const message of stream) {
            if (message.type === 'taskCreated') {
                taskId = message.task.taskId;
            }
        }

        expect(taskId).toBeDefined();

        // Wait for the task to complete
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify we can retrieve the task
        const task = await client.experimental.tasks.getTask(taskId!);
        expect(task).toBeDefined();
        expect(task.status).toBe('completed');

        // Verify we can retrieve the result
        const result = await client.experimental.tasks.getTaskResult(taskId!, CallToolResultSchema);
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
        await expect(client.experimental.tasks.getTask('non-existent')).rejects.toThrow('Method not found');
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
        let capturedElicitRequest: z4.infer<typeof ElicitRequestSchema> | null = null;

        // Set up client elicitation handler
        client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
            let taskId: string | undefined;

            // Check if task creation is requested
            if (request.params.task && extra.taskStore) {
                const createdTask = await extra.taskStore.createTask({
                    ttl: extra.taskRequestedTtl
                });
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
        server.experimental.tasks.registerToolTask(
            'collect-info',
            {
                description: 'Collects user info via elicitation',
                inputSchema: {}
            },
            {
                async createTask(_args, extra) {
                    const task = await extra.taskStore.createTask({
                        ttl: extra.taskRequestedTtl
                    });

                    // Perform async work that makes a nested request
                    (async () => {
                        // During tool execution, make a nested request to the client using extra.sendRequest
                        const elicitResult = await extra.sendRequest(
                            {
                                method: 'elicitation/create',
                                params: {
                                    mode: 'form',
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

        // Call tool WITH task creation using callToolStream to capture task ID
        let taskId: string | undefined;
        const stream = client.experimental.tasks.callToolStream({ name: 'collect-info', arguments: {} }, CallToolResultSchema, {
            task: {
                ttl: 60000
            }
        });

        for await (const message of stream) {
            if (message.type === 'taskCreated') {
                taskId = message.task.taskId;
            }
        }

        expect(taskId).toBeDefined();

        // Wait for completion
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify the nested elicitation request was made (related-task metadata is no longer automatically attached)
        expect(capturedElicitRequest).toBeDefined();

        // Verify tool result was correct
        const result = await client.experimental.tasks.getTaskResult(taskId!, CallToolResultSchema);
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
                const result = {
                    action: 'accept',
                    content: { username: 'server-test-user', confirmed: true }
                };

                // Check if task creation is requested
                if (request.params.task && extra.taskStore) {
                    const task = await extra.taskStore.createTask({
                        ttl: extra.taskRequestedTtl
                    });
                    await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
                    // Return CreateTaskResult when task creation is requested
                    return { task };
                }

                // Return ElicitResult for non-task requests
                return result;
            });

            const server = new Server({
                name: 'test-server',
                version: '1.0.0'
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Server creates task on client via elicitation
            const createTaskResult = await server.request(
                {
                    method: 'elicitation/create',
                    params: {
                        mode: 'form',
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
                CreateTaskResultSchema,
                { task: { ttl: 60000 } }
            );

            // Verify CreateTaskResult structure
            expect(createTaskResult.task).toBeDefined();
            expect(createTaskResult.task.taskId).toBeDefined();
            const taskId = createTaskResult.task.taskId;

            // Verify task was created
            const task = await server.experimental.tasks.getTask(taskId);
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
                const result = {
                    action: 'accept',
                    content: { username: 'list-user' }
                };

                // Check if task creation is requested
                if (request.params.task && extra.taskStore) {
                    const task = await extra.taskStore.createTask({
                        ttl: extra.taskRequestedTtl
                    });
                    await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
                    // Return CreateTaskResult when task creation is requested
                    return { task };
                }

                // Return ElicitResult for non-task requests
                return result;
            });

            const server = new Server({
                name: 'test-server',
                version: '1.0.0'
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Create task
            const createTaskResult = await server.request(
                {
                    method: 'elicitation/create',
                    params: {
                        mode: 'form',
                        message: 'Provide info',
                        requestedSchema: {
                            type: 'object',
                            properties: { username: { type: 'string' } }
                        }
                    }
                },
                CreateTaskResultSchema,
                { task: { ttl: 60000 } }
            );

            // Verify CreateTaskResult structure
            expect(createTaskResult.task).toBeDefined();
            expect(createTaskResult.task.taskId).toBeDefined();
            const taskId = createTaskResult.task.taskId;

            // Query task
            const task = await server.experimental.tasks.getTask(taskId);
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
                const result = {
                    action: 'accept',
                    content: { username: 'result-user', confirmed: true }
                };

                // Check if task creation is requested
                if (request.params.task && extra.taskStore) {
                    const task = await extra.taskStore.createTask({
                        ttl: extra.taskRequestedTtl
                    });
                    await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
                    // Return CreateTaskResult when task creation is requested
                    return { task };
                }

                // Return ElicitResult for non-task requests
                return result;
            });

            const server = new Server({
                name: 'test-server',
                version: '1.0.0'
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Create task
            const createTaskResult = await server.request(
                {
                    method: 'elicitation/create',
                    params: {
                        mode: 'form',
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
                CreateTaskResultSchema,
                { task: { ttl: 60000 } }
            );

            // Verify CreateTaskResult structure
            expect(createTaskResult.task).toBeDefined();
            expect(createTaskResult.task.taskId).toBeDefined();
            const taskId = createTaskResult.task.taskId;

            // Query result
            const result = await server.experimental.tasks.getTaskResult(taskId, ElicitResultSchema);
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
                const result = {
                    action: 'accept',
                    content: { username: 'list-user' }
                };

                // Check if task creation is requested
                if (request.params.task && extra.taskStore) {
                    const task = await extra.taskStore.createTask({
                        ttl: extra.taskRequestedTtl
                    });
                    await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
                    // Return CreateTaskResult when task creation is requested
                    return { task };
                }

                // Return ElicitResult for non-task requests
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
            const createdTaskIds: string[] = [];
            for (let i = 0; i < 2; i++) {
                const createTaskResult = await server.request(
                    {
                        method: 'elicitation/create',
                        params: {
                            mode: 'form',
                            message: 'Provide info',
                            requestedSchema: {
                                type: 'object',
                                properties: { username: { type: 'string' } }
                            }
                        }
                    },
                    CreateTaskResultSchema,
                    { task: { ttl: 60000 } }
                );

                // Verify CreateTaskResult structure and capture taskId
                expect(createTaskResult.task).toBeDefined();
                expect(createTaskResult.task.taskId).toBeDefined();
                createdTaskIds.push(createTaskResult.task.taskId);
            }

            // Query task list
            const taskList = await server.experimental.tasks.listTasks();
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
        server.experimental.tasks.registerToolTask(
            'async-tool',
            {
                description: 'An async test tool',
                inputSchema: {
                    delay: z4.number().optional().default(10),
                    taskNum: z4.number().optional()
                }
            },
            {
                async createTask({ delay, taskNum }, extra) {
                    const task = await extra.taskStore.createTask({
                        ttl: extra.taskRequestedTtl
                    });

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
        const taskList = await client.experimental.tasks.listTasks();
        expect(taskList.tasks.length).toBeGreaterThanOrEqual(4);
        const taskIds = taskList.tasks.map(t => t.taskId);

        // Verify all tasks completed successfully
        for (let i = 0; i < taskIds.length; i++) {
            const task = await client.experimental.tasks.getTask(taskIds[i]!);
            expect(task.status).toBe('completed');
            expect(task.taskId).toBe(taskIds[i]!);

            const result = await client.experimental.tasks.getTaskResult(taskIds[i]!, CallToolResultSchema);
            expect(result.content).toEqual([{ type: 'text', text: `Completed task ${i + 1}` }]);
        }

        // Verify listTasks returns all tasks
        const finalTaskList = await client.experimental.tasks.listTasks();
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
            await expect(client.experimental.tasks.getTask('non-existent-task')).rejects.toThrow();
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
            await expect(server.experimental.tasks.getTask('non-existent-task')).rejects.toThrow();
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
        const result = {
            action: 'accept',
            content: { username: 'test-user' }
        };

        // Check if task creation is requested
        if (request.params.task && extra.taskStore) {
            const task = await extra.taskStore.createTask({
                ttl: extra.taskRequestedTtl
            });
            await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
            // Return CreateTaskResult when task creation is requested
            return { task };
        }

        // Return ElicitResult for non-task requests
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
        elicitation: {
            form: {}
        },
        tasks: {
            requests: {
                elicitation: {
                    create: {}
                }
            }
        }
    });

    // These should work because client supports tasks
    const createTaskResult = await server.request(
        {
            method: 'elicitation/create',
            params: {
                mode: 'form',
                message: 'Test',
                requestedSchema: {
                    type: 'object',
                    properties: { username: { type: 'string' } }
                }
            }
        },
        CreateTaskResultSchema,
        { task: { ttl: 60000 } }
    );

    // Verify CreateTaskResult structure
    expect(createTaskResult.task).toBeDefined();
    expect(createTaskResult.task.taskId).toBeDefined();
    const taskId = createTaskResult.task.taskId;

    await expect(server.experimental.tasks.listTasks()).resolves.not.toThrow();
    await expect(server.experimental.tasks.getTask(taskId)).resolves.not.toThrow();

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
            CreateMessageResultSchema,
            { task: { taskId: 'test-task-2', keepAlive: 60000 } }
        )
    ).rejects.toThrow('Client does not support task creation for sampling/createMessage');

    clientTaskStore.cleanup();
});
