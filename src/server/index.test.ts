/* eslint-disable @typescript-eslint/no-unused-vars */
import { Client } from '../client/index.js';
import { InMemoryTransport } from '../inMemory.js';
import type { Transport } from '../shared/transport.js';
import {
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    ElicitationCompleteNotificationSchema,
    ErrorCode,
    LATEST_PROTOCOL_VERSION,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    type LoggingMessageNotification,
    NotificationSchema,
    RequestSchema,
    ResultSchema,
    SetLevelRequestSchema,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../types.js';
import { Server } from './index.js';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '../validation/types.js';
import type { AnyObjectSchema } from './zod-compat.js';
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
    await expect(server.listRoots()).rejects.toThrow(/^Client does not support/);
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
    ).rejects.toThrow(/^Client does not support/);
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
        receivedModes.push(request.params.mode);
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
        receivedModes.push(request.params.mode);
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

    // Request should be rejected
    await expect(createMessagePromise).rejects.toBe('Cancelled by test');
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
