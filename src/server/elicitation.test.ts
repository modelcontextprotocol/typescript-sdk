import { InMemoryTransport } from '../inMemory.js';
import { Client } from '../client/index.js';
import { Server } from './index.js';
import { ElicitRequestSchema } from '../types.js';

let client: Client;
let server: Server;
let clientTransport: InMemoryTransport;
let serverTransport: InMemoryTransport;

beforeEach(async () => {
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });
});

afterEach(async () => {
    await client.close();
    await server.close();
});

describe('Validation Rules', () => {
    test('should validate content when action is "accept" and content is provided', async () => {
        client.setRequestHandler(ElicitRequestSchema, () => ({
            action: 'accept',
            content: {
                name: 'Jane Smith',
                email: 'jane@example.com'
            }
        }));

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Enter basic info',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    phone: { type: 'string' }, // Optional
                    website: { type: 'string', format: 'uri' } // Optional
                },
                required: ['name', 'email']
            }
        });

        expect(result.action).toBe('accept');
        expect(result.content).toEqual({
            name: 'Jane Smith',
            email: 'jane@example.com'
        });
    });

    test('should NOT validate when action is "decline"', async () => {
        client.setRequestHandler(ElicitRequestSchema, () => ({
            action: 'decline'
            // No content provided, and validation should be skipped
        }));

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Enter your details',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    age: { type: 'number' }
                },
                required: ['name', 'age']
            }
        });

        expect(result.action).toBe('decline');
        expect(result.content).toBeUndefined();
    });

    test('should NOT validate when action is "cancel"', async () => {
        client.setRequestHandler(ElicitRequestSchema, () => ({
            action: 'cancel'
            // No content provided, and validation should be skipped
        }));

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Enter your details',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    age: { type: 'number' }
                },
                required: ['name', 'age']
            }
        });

        expect(result.action).toBe('cancel');
        expect(result.content).toBeUndefined();
    });

    test('should NOT validate when action is "accept" but content is null or undefined', async () => {
        client.setRequestHandler(ElicitRequestSchema, () => ({
            action: 'accept',
            content: undefined
        }));

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Enter your details',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    age: { type: 'number' }
                },
                required: ['name', 'age']
            }
        });

        expect(result.action).toBe('accept');
        expect(result.content).toBeUndefined();
    });

    test('should provide detailed error messages for validation failures', async () => {
        client.setRequestHandler(ElicitRequestSchema, () => ({
            action: 'accept',
            content: {
                name: '', // Too short
                email: 'invalid', // Wrong format
                age: 'thirty', // Wrong type
                score: 150 // Above maximum
            }
        }));

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        try {
            await server.elicitInput({
                message: 'Enter valid data',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', minLength: 1 },
                        email: { type: 'string', format: 'email' },
                        age: { type: 'number', minimum: 0 },
                        score: { type: 'number', maximum: 100 }
                    },
                    required: ['name', 'email', 'age', 'score']
                }
            });
            fail('Should have thrown validation error');
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(Error);
            const errorMessage = (error as Error).message;
            expect(errorMessage).toContain('does not match requested schema');
            // Should contain multiple validation errors
            expect(errorMessage.length).toBeGreaterThan(100);
        }
    });
});

describe('JSON Schema Validation (@cfworker/json-schema)', () => {
    describe('String Schema (MCP Spec)', () => {
        test('should validate basic string type', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { name: 'John Doe' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter your name',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' }
                    },
                    required: ['name']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ name: 'John Doe' });
        });

        test('should validate string with title and description', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { displayName: 'Administrator' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter display name',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        displayName: {
                            type: 'string',
                            title: 'Display Name',
                            description: 'The name to show in the UI'
                        }
                    },
                    required: ['displayName']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ displayName: 'Administrator' });
        });

        test('should validate string length constraints', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { username: 'user123' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter username',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        username: {
                            type: 'string',
                            minLength: 3,
                            maxLength: 20
                        }
                    },
                    required: ['username']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ username: 'user123' });
        });

        test('should reject string that is too short', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { username: 'ab' } // Too short
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await expect(
                server.elicitInput({
                    message: 'Enter username',
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            username: {
                                type: 'string',
                                minLength: 3,
                                maxLength: 20
                            }
                        },
                        required: ['username']
                    }
                })
            ).rejects.toThrow(/does not match requested schema/);
        });

        test('should reject string that is too long', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { username: 'a'.repeat(25) } // Too long
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await expect(
                server.elicitInput({
                    message: 'Enter username',
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            username: {
                                type: 'string',
                                minLength: 3,
                                maxLength: 20
                            }
                        },
                        required: ['username']
                    }
                })
            ).rejects.toThrow(/does not match requested schema/);
        });
    });

    describe('String Format Validation (MCP Spec)', () => {
        test('should validate email format', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { email: 'test@example.com' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter email',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        email: {
                            type: 'string',
                            format: 'email'
                        }
                    },
                    required: ['email']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ email: 'test@example.com' });
        });

        test('should reject invalid email format', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { email: 'invalid-email' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await expect(
                server.elicitInput({
                    message: 'Enter email',
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            email: {
                                type: 'string',
                                format: 'email'
                            }
                        },
                        required: ['email']
                    }
                })
            ).rejects.toThrow(/does not match requested schema/);
        });

        test('should validate URI format', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { website: 'https://example.com' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter website',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        website: {
                            type: 'string',
                            format: 'uri'
                        }
                    },
                    required: ['website']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ website: 'https://example.com' });
        });

        test('should validate date format', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { birthDate: '1990-01-01' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter birth date',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        birthDate: {
                            type: 'string',
                            format: 'date'
                        }
                    },
                    required: ['birthDate']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ birthDate: '1990-01-01' });
        });

        test('should validate date-time format', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { timestamp: '2023-12-01T10:30:00Z' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter timestamp',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        timestamp: {
                            type: 'string',
                            format: 'date-time'
                        }
                    },
                    required: ['timestamp']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ timestamp: '2023-12-01T10:30:00Z' });
        });
    });

    describe('Number Schema (MCP Spec)', () => {
        test('should validate number type', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { price: 19.99 }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter price',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        price: { type: 'number' }
                    },
                    required: ['price']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ price: 19.99 });
        });

        test('should validate integer type', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { count: 42 }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter count',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        count: { type: 'integer' }
                    },
                    required: ['count']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ count: 42 });
        });

        test('should validate number with minimum/maximum constraints', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { age: 25 }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter age',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        age: {
                            type: 'number',
                            minimum: 0,
                            maximum: 120
                        }
                    },
                    required: ['age']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ age: 25 });
        });

        test('should reject number below minimum', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { age: -5 }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await expect(
                server.elicitInput({
                    message: 'Enter age',
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            age: {
                                type: 'number',
                                minimum: 0,
                                maximum: 120
                            }
                        },
                        required: ['age']
                    }
                })
            ).rejects.toThrow(/does not match requested schema/);
        });

        test('should reject number above maximum', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { age: 150 }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await expect(
                server.elicitInput({
                    message: 'Enter age',
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            age: {
                                type: 'number',
                                minimum: 0,
                                maximum: 120
                            }
                        },
                        required: ['age']
                    }
                })
            ).rejects.toThrow(/does not match requested schema/);
        });
    });

    describe('Boolean Schema (MCP Spec)', () => {
        test('should validate boolean type', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { isActive: true }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Set active status',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        isActive: { type: 'boolean' }
                    },
                    required: ['isActive']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ isActive: true });
        });

        test('should validate boolean with default value', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { enableNotifications: false }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enable notifications',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        enableNotifications: {
                            type: 'boolean',
                            title: 'Enable Notifications',
                            description: 'Whether to enable push notifications',
                            default: false
                        }
                    },
                    required: ['enableNotifications']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ enableNotifications: false });
        });

        test('should reject non-boolean value', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { isActive: 'yes' } // Should be boolean
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await expect(
                server.elicitInput({
                    message: 'Set active status',
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            isActive: { type: 'boolean' }
                        },
                        required: ['isActive']
                    }
                })
            ).rejects.toThrow(/does not match requested schema/);
        });
    });

    describe('Enum Schema (MCP Spec)', () => {
        test('should validate standard enum', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { priority: 'high' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Set priority',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        priority: {
                            type: 'string',
                            enum: ['low', 'medium', 'high']
                        }
                    },
                    required: ['priority']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ priority: 'high' });
        });

        test('should validate enum with enumNames (deprecated but supported)', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { level: 'debug' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Set log level',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        level: {
                            type: 'string',
                            title: 'Log Level',
                            description: 'Choose logging level',
                            enum: ['debug', 'info', 'warn', 'error'],
                            enumNames: ['Debug', 'Information', 'Warning', 'Error']
                        }
                    },
                    required: ['level']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ level: 'debug' });
        });

        test('should reject invalid enum value', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { priority: 'urgent' } // Not in enum
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await expect(
                server.elicitInput({
                    message: 'Set priority',
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            priority: {
                                type: 'string',
                                enum: ['low', 'medium', 'high']
                            }
                        },
                        required: ['priority']
                    }
                })
            ).rejects.toThrow(/does not match requested schema/);
        });
    });

    describe('Complex Object Validation', () => {
        test('should validate complex object with multiple property types', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: {
                    name: 'John Doe',
                    email: 'john@example.com',
                    age: 30,
                    isActive: true,
                    role: 'admin',
                    website: 'https://johndoe.com',
                    joinDate: '2023-01-15',
                    lastLogin: '2023-12-01T10:30:00Z',
                    score: 95.5
                }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter user profile',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            title: 'Full Name',
                            minLength: 1,
                            maxLength: 100
                        },
                        email: {
                            type: 'string',
                            format: 'email',
                            title: 'Email Address'
                        },
                        age: {
                            type: 'integer',
                            minimum: 18,
                            maximum: 65,
                            title: 'Age'
                        },
                        isActive: {
                            type: 'boolean',
                            title: 'Active Status',
                            default: true
                        },
                        role: {
                            type: 'string',
                            enum: ['user', 'admin', 'moderator'],
                            title: 'Role'
                        },
                        website: {
                            type: 'string',
                            format: 'uri',
                            title: 'Website URL'
                        },
                        joinDate: {
                            type: 'string',
                            format: 'date',
                            title: 'Join Date'
                        },
                        lastLogin: {
                            type: 'string',
                            format: 'date-time',
                            title: 'Last Login'
                        },
                        score: {
                            type: 'number',
                            minimum: 0,
                            maximum: 100,
                            title: 'Performance Score'
                        }
                    },
                    required: ['name', 'email', 'age', 'isActive', 'role']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({
                name: 'John Doe',
                email: 'john@example.com',
                age: 30,
                isActive: true,
                role: 'admin',
                website: 'https://johndoe.com',
                joinDate: '2023-01-15',
                lastLogin: '2023-12-01T10:30:00Z',
                score: 95.5
            });
        });

        test('should handle optional properties correctly', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: {
                    name: 'Jane Smith',
                    email: 'jane@example.com'
                    // Optional properties not provided
                }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter basic info',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        email: { type: 'string', format: 'email' },
                        phone: { type: 'string' }, // Optional
                        website: { type: 'string', format: 'uri' } // Optional
                    },
                    required: ['name', 'email']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({
                name: 'Jane Smith',
                email: 'jane@example.com'
            });
        });
    });

    describe('JSON Schema 2020-12 Specific Features', () => {
        test('should validate with $schema reference', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { value: 'test' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter value',
                requestedSchema: {
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    properties: {
                        value: { type: 'string' }
                    },
                    required: ['value']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ value: 'test' });
        });

        test('should validate with $id reference', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { data: 'valid' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter data',
                requestedSchema: {
                    $id: 'https://example.com/schemas/test-schema',
                    type: 'object',
                    properties: {
                        data: { type: 'string' }
                    },
                    required: ['data']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ data: 'valid' });
        });

        test('should validate with additionalProperties: false', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: { allowedProp: 'value' }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Enter allowed property',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        allowedProp: { type: 'string' }
                    },
                    additionalProperties: false,
                    required: ['allowedProp']
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({ allowedProp: 'value' });
        });

        test('should reject additional properties when additionalProperties: false', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: {
                    allowedProp: 'value',
                    extraProp: 'not allowed' // Should be rejected
                }
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await expect(
                server.elicitInput({
                    message: 'Enter allowed property only',
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            allowedProp: { type: 'string' }
                        },
                        additionalProperties: false,
                        required: ['allowedProp']
                    }
                })
            ).rejects.toThrow(/does not match requested schema/);
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty object schema', async () => {
            client.setRequestHandler(ElicitRequestSchema, () => ({
                action: 'accept',
                content: {}
            }));

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            const result = await server.elicitInput({
                message: 'Submit empty form',
                requestedSchema: {
                    type: 'object',
                    properties: {}
                }
            });

            expect(result.action).toBe('accept');
            expect(result.content).toEqual({});
        });
    });
});
