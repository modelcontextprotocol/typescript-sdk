/**
 * Integration tests for Standard Schema support (StandardJSONSchemaV1)
 * Tests ArkType and Valibot schemas with the MCP SDK
 */

import { Client } from '@modelcontextprotocol/client';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/core';
import {
    CallToolResultSchema,
    CompleteResultSchema,
    InMemoryTransport,
    ListPromptsResultSchema,
    ListToolsResultSchema
} from '@modelcontextprotocol/core';
import { completable, McpServer } from '@modelcontextprotocol/server';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import { type } from 'arktype';
import * as v from 'valibot';
import { beforeEach, describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

describe('Standard Schema Support', () => {
    let mcpServer: McpServer;
    let client: Client;

    beforeEach(async () => {
        mcpServer = new McpServer({
            name: 'test server',
            version: '1.0'
        });
        client = new Client({
            name: 'test client',
            version: '1.0'
        });
    });

    async function connectClientAndServer() {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
    }

    describe('ArkType schemas', () => {
        describe('tool registration', () => {
            test('should register tool with ArkType input schema', async () => {
                const inputSchema = type({
                    name: 'string',
                    age: 'number'
                });

                mcpServer.registerTool(
                    'greet',
                    {
                        description: 'Greet a person',
                        inputSchema
                    },
                    async ({ name, age }) => ({
                        content: [{ type: 'text', text: `Hello ${name}, you are ${age} years old` }]
                    })
                );

                await connectClientAndServer();

                const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema);

                expect(result.tools).toHaveLength(1);
                expect(result.tools[0].name).toBe('greet');
                expect(result.tools[0].inputSchema).toMatchObject({
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        age: { type: 'number' }
                    }
                });
                // Check required array contains both fields (order may vary by library)
                expect(result.tools[0].inputSchema.required).toEqual(expect.arrayContaining(['name', 'age']));
            });

            test('should register tool with ArkType input and output schemas', async () => {
                const inputSchema = type({ x: 'number', y: 'number' });
                const outputSchema = type({ result: 'number', operation: 'string' });

                mcpServer.registerTool(
                    'add',
                    {
                        description: 'Add two numbers',
                        inputSchema,
                        outputSchema
                    },
                    async ({ x, y }) => ({
                        content: [{ type: 'text', text: `${x + y}` }],
                        structuredContent: { result: x + y, operation: 'addition' }
                    })
                );

                await connectClientAndServer();

                const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema);

                expect(result.tools[0].outputSchema).toMatchObject({
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    properties: {
                        result: { type: 'number' },
                        operation: { type: 'string' }
                    }
                });
                expect(result.tools[0].outputSchema!.required).toEqual(expect.arrayContaining(['result', 'operation']));
            });
        });

        describe('tool validation', () => {
            test('should validate valid input and execute tool', async () => {
                const inputSchema = type({ value: 'number' });

                mcpServer.registerTool(
                    'double',
                    { inputSchema },
                    async ({ value }) => ({
                        content: [{ type: 'text', text: `${value * 2}` }]
                    })
                );

                await connectClientAndServer();

                const result = await client.request(
                    {
                        method: 'tools/call',
                        params: { name: 'double', arguments: { value: 21 } }
                    },
                    CallToolResultSchema
                );

                expect(result.content[0]).toEqual({ type: 'text', text: '42' });
            });

            test('should return validation error for invalid input type', async () => {
                const inputSchema = type({ value: 'number' });

                mcpServer.registerTool(
                    'double',
                    { inputSchema },
                    async ({ value }) => ({
                        content: [{ type: 'text', text: `${value * 2}` }]
                    })
                );

                await connectClientAndServer();

                const result = await client.request(
                    {
                        method: 'tools/call',
                        params: { name: 'double', arguments: { value: 'not a number' } }
                    },
                    CallToolResultSchema
                );

                expect(result.isError).toBe(true);
                const errorText = (result.content[0] as TextContent).text;
                expect(errorText).toContain('Input validation error');
                expect(errorText).toContain('value');
                expect(errorText).toContain('number');
            });

            test('should return validation error for invalid enum value', async () => {
                const inputSchema = type({
                    operation: "'add' | 'subtract' | 'multiply'"
                });

                mcpServer.registerTool(
                    'calculate',
                    { inputSchema },
                    async ({ operation }) => ({
                        content: [{ type: 'text', text: operation }]
                    })
                );

                await connectClientAndServer();

                const result = await client.request(
                    {
                        method: 'tools/call',
                        params: { name: 'calculate', arguments: { operation: 'divide' } }
                    },
                    CallToolResultSchema
                );

                expect(result.isError).toBe(true);
                const errorText = (result.content[0] as TextContent).text;
                expect(errorText).toContain('Input validation error');
                expect(errorText).toMatch(/add|subtract|multiply/);
            });

            test('should return validation error for missing required field', async () => {
                const inputSchema = type({ name: 'string', age: 'number' });

                mcpServer.registerTool(
                    'greet',
                    { inputSchema },
                    async ({ name, age }) => ({
                        content: [{ type: 'text', text: `Hello ${name}, ${age}` }]
                    })
                );

                await connectClientAndServer();

                const result = await client.request(
                    {
                        method: 'tools/call',
                        params: { name: 'greet', arguments: { name: 'Alice' } }
                    },
                    CallToolResultSchema
                );

                expect(result.isError).toBe(true);
                const errorText = (result.content[0] as TextContent).text;
                expect(errorText).toContain('Input validation error');
                expect(errorText).toContain('age');
            });
        });
    });

    describe('Valibot schemas', () => {
        describe('tool registration', () => {
            test('should register tool with Valibot input schema', async () => {
                const inputSchema = toStandardJsonSchema(
                    v.object({
                        name: v.string(),
                        age: v.number()
                    })
                );

                mcpServer.registerTool(
                    'greet',
                    {
                        description: 'Greet a person',
                        inputSchema
                    },
                    async ({ name, age }) => ({
                        content: [{ type: 'text', text: `Hello ${name}, you are ${age} years old` }]
                    })
                );

                await connectClientAndServer();

                const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema);

                expect(result.tools).toHaveLength(1);
                expect(result.tools[0].name).toBe('greet');
                expect(result.tools[0].inputSchema).toMatchObject({
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        age: { type: 'number' }
                    },
                    required: ['name', 'age']
                });
            });

            test('should register tool with Valibot schema with descriptions', async () => {
                const inputSchema = toStandardJsonSchema(
                    v.object({
                        city: v.pipe(v.string(), v.description('The city name')),
                        country: v.pipe(v.string(), v.description('The country code'))
                    })
                );

                mcpServer.registerTool('weather', { inputSchema }, async () => ({
                    content: [{ type: 'text', text: 'sunny' }]
                }));

                await connectClientAndServer();

                const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema);

                expect(result.tools[0].inputSchema.properties).toMatchObject({
                    city: { type: 'string', description: 'The city name' },
                    country: { type: 'string', description: 'The country code' }
                });
            });
        });

        describe('tool validation', () => {
            test('should validate valid input and execute tool', async () => {
                const inputSchema = toStandardJsonSchema(v.object({ value: v.number() }));

                mcpServer.registerTool(
                    'double',
                    { inputSchema },
                    async ({ value }) => ({
                        content: [{ type: 'text', text: `${value * 2}` }]
                    })
                );

                await connectClientAndServer();

                const result = await client.request(
                    {
                        method: 'tools/call',
                        params: { name: 'double', arguments: { value: 21 } }
                    },
                    CallToolResultSchema
                );

                expect(result.content[0]).toEqual({ type: 'text', text: '42' });
            });

            test('should return validation error for invalid input type', async () => {
                const inputSchema = toStandardJsonSchema(v.object({ value: v.number() }));

                mcpServer.registerTool(
                    'double',
                    { inputSchema },
                    async ({ value }) => ({
                        content: [{ type: 'text', text: `${value * 2}` }]
                    })
                );

                await connectClientAndServer();

                const result = await client.request(
                    {
                        method: 'tools/call',
                        params: { name: 'double', arguments: { value: 'not a number' } }
                    },
                    CallToolResultSchema
                );

                expect(result.isError).toBe(true);
                const errorText = (result.content[0] as TextContent).text;
                expect(errorText).toContain('Input validation error');
                expect(errorText).toContain('number');
            });

            test('should return validation error for invalid picklist value', async () => {
                const inputSchema = toStandardJsonSchema(
                    v.object({
                        operation: v.picklist(['add', 'subtract', 'multiply'])
                    })
                );

                mcpServer.registerTool(
                    'calculate',
                    { inputSchema },
                    async ({ operation }) => ({
                        content: [{ type: 'text', text: operation }]
                    })
                );

                await connectClientAndServer();

                const result = await client.request(
                    {
                        method: 'tools/call',
                        params: { name: 'calculate', arguments: { operation: 'divide' } }
                    },
                    CallToolResultSchema
                );

                expect(result.isError).toBe(true);
                const errorText = (result.content[0] as TextContent).text;
                expect(errorText).toContain('Input validation error');
            });

            test('should validate min/max constraints', async () => {
                const inputSchema = toStandardJsonSchema(
                    v.object({
                        percentage: v.pipe(v.number(), v.minValue(0), v.maxValue(100))
                    })
                );

                mcpServer.registerTool(
                    'setPercentage',
                    { inputSchema },
                    async ({ percentage }) => ({
                        content: [{ type: 'text', text: `${percentage}%` }]
                    })
                );

                await connectClientAndServer();

                // Valid value
                const validResult = await client.request(
                    {
                        method: 'tools/call',
                        params: { name: 'setPercentage', arguments: { percentage: 50 } }
                    },
                    CallToolResultSchema
                );
                expect(validResult.isError).toBeFalsy();

                // Invalid value (too high)
                const invalidResult = await client.request(
                    {
                        method: 'tools/call',
                        params: { name: 'setPercentage', arguments: { percentage: 150 } }
                    },
                    CallToolResultSchema
                );
                expect(invalidResult.isError).toBe(true);
                const errorText = (invalidResult.content[0] as TextContent).text;
                expect(errorText).toContain('Input validation error');
            });
        });
    });

    describe('Mixed schema libraries', () => {
        test('should support tools with different schema libraries in same server', async () => {
            // Zod tool
            mcpServer.registerTool(
                'zod-tool',
                { inputSchema: z.object({ value: z.string() }) },
                async ({ value }) => ({ content: [{ type: 'text', text: `zod: ${value}` }] })
            );

            // ArkType tool
            mcpServer.registerTool(
                'arktype-tool',
                { inputSchema: type({ value: 'string' }) },
                async ({ value }) => ({ content: [{ type: 'text', text: `arktype: ${value}` }] })
            );

            // Valibot tool
            mcpServer.registerTool(
                'valibot-tool',
                { inputSchema: toStandardJsonSchema(v.object({ value: v.string() })) },
                async ({ value }) => ({ content: [{ type: 'text', text: `valibot: ${value}` }] })
            );

            await connectClientAndServer();

            const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
            expect(tools.tools).toHaveLength(3);

            // Call each tool
            const zodResult = await client.request(
                { method: 'tools/call', params: { name: 'zod-tool', arguments: { value: 'test' } } },
                CallToolResultSchema
            );
            expect((zodResult.content[0] as TextContent).text).toBe('zod: test');

            const arktypeResult = await client.request(
                { method: 'tools/call', params: { name: 'arktype-tool', arguments: { value: 'test' } } },
                CallToolResultSchema
            );
            expect((arktypeResult.content[0] as TextContent).text).toBe('arktype: test');

            const valibotResult = await client.request(
                { method: 'tools/call', params: { name: 'valibot-tool', arguments: { value: 'test' } } },
                CallToolResultSchema
            );
            expect((valibotResult.content[0] as TextContent).text).toBe('valibot: test');
        });
    });

    describe('Prompt completions with Zod completable', () => {
        // Note: completable() is currently Zod-specific
        // These tests verify that Zod schemas with completable still work

        test('should support completion with Zod completable schemas', async () => {
            mcpServer.registerPrompt(
                'greeting',
                {
                    argsSchema: z.object({
                        name: completable(z.string(), value =>
                            ['Alice', 'Bob', 'Charlie'].filter(n => n.toLowerCase().startsWith(value.toLowerCase()))
                        )
                    })
                },
                async ({ name }) => ({
                    messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }]
                })
            );

            await connectClientAndServer();

            // Test completion
            const result = await client.request(
                {
                    method: 'completion/complete',
                    params: {
                        ref: { type: 'ref/prompt', name: 'greeting' },
                        argument: { name: 'name', value: 'a' }
                    }
                },
                CompleteResultSchema
            );

            expect(result.completion.values).toEqual(['Alice']);
        });

        test('should return all completions when prefix is empty', async () => {
            mcpServer.registerPrompt(
                'greeting',
                {
                    argsSchema: z.object({
                        name: completable(z.string(), () => ['Alice', 'Bob', 'Charlie'])
                    })
                },
                async ({ name }) => ({
                    messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }]
                })
            );

            await connectClientAndServer();

            const result = await client.request(
                {
                    method: 'completion/complete',
                    params: {
                        ref: { type: 'ref/prompt', name: 'greeting' },
                        argument: { name: 'name', value: '' }
                    }
                },
                CompleteResultSchema
            );

            expect(result.completion.values).toEqual(['Alice', 'Bob', 'Charlie']);
            expect(result.completion.total).toBe(3);
        });
    });

    describe('Error message quality', () => {
        test('ArkType should provide descriptive error messages', async () => {
            const inputSchema = type({
                email: 'string',
                age: 'number',
                status: "'active' | 'inactive'"
            });

            mcpServer.registerTool('test', { inputSchema }, async () => ({
                content: [{ type: 'text', text: 'ok' }]
            }));

            await connectClientAndServer();

            const result = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'test',
                        arguments: {
                            email: 123,
                            age: 'not a number',
                            status: 'unknown'
                        }
                    }
                },
                CallToolResultSchema
            );

            expect(result.isError).toBe(true);
            const errorText = (result.content[0] as TextContent).text;

            // Check that error mentions the specific issues
            expect(errorText).toContain('Input validation error');
            // ArkType should mention type mismatches
            expect(errorText).toMatch(/email|age|status/i);
        });

        test('Valibot should provide descriptive error messages', async () => {
            const inputSchema = toStandardJsonSchema(
                v.object({
                    email: v.string(),
                    age: v.number(),
                    status: v.picklist(['active', 'inactive'])
                })
            );

            mcpServer.registerTool('test', { inputSchema }, async () => ({
                content: [{ type: 'text', text: 'ok' }]
            }));

            await connectClientAndServer();

            const result = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'test',
                        arguments: {
                            email: 123,
                            age: 'not a number',
                            status: 'unknown'
                        }
                    }
                },
                CallToolResultSchema
            );

            expect(result.isError).toBe(true);
            const errorText = (result.content[0] as TextContent).text;

            // Check that error mentions the specific issues
            expect(errorText).toContain('Input validation error');
            // Valibot should provide "Invalid type" messages
            expect(errorText).toContain('Invalid type');
        });

        test('Zod should provide descriptive error messages', async () => {
            const inputSchema = z.object({
                email: z.string(),
                age: z.number(),
                status: z.enum(['active', 'inactive'])
            });

            mcpServer.registerTool('test', { inputSchema }, async () => ({
                content: [{ type: 'text', text: 'ok' }]
            }));

            await connectClientAndServer();

            const result = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'test',
                        arguments: {
                            email: 123,
                            age: 'not a number',
                            status: 'unknown'
                        }
                    }
                },
                CallToolResultSchema
            );

            expect(result.isError).toBe(true);
            const errorText = (result.content[0] as TextContent).text;

            // Check that error mentions the specific issues
            expect(errorText).toContain('Input validation error');
        });
    });

    describe('Type inference', () => {
        test('ArkType callback should receive correctly typed arguments', async () => {
            const inputSchema = type({
                name: 'string',
                count: 'number',
                enabled: 'boolean'
            });

            // This test verifies TypeScript compilation succeeds with correct types
            mcpServer.registerTool(
                'typed-tool',
                { inputSchema },
                async ({ name, count, enabled }) => {
                    // TypeScript should infer these types correctly
                    const _name: string = name;
                    const _count: number = count;
                    const _enabled: boolean = enabled;

                    return {
                        content: [{ type: 'text', text: `${_name}: ${_count}, enabled: ${_enabled}` }]
                    };
                }
            );

            await connectClientAndServer();

            const result = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'typed-tool',
                        arguments: { name: 'test', count: 42, enabled: true }
                    }
                },
                CallToolResultSchema
            );

            expect((result.content[0] as TextContent).text).toBe('test: 42, enabled: true');
        });

        test('Valibot callback should receive correctly typed arguments', async () => {
            const inputSchema = toStandardJsonSchema(
                v.object({
                    name: v.string(),
                    count: v.number(),
                    enabled: v.boolean()
                })
            );

            mcpServer.registerTool(
                'typed-tool',
                { inputSchema },
                async ({ name, count, enabled }) => {
                    // TypeScript should infer these types correctly
                    const _name: string = name;
                    const _count: number = count;
                    const _enabled: boolean = enabled;

                    return {
                        content: [{ type: 'text', text: `${_name}: ${_count}, enabled: ${_enabled}` }]
                    };
                }
            );

            await connectClientAndServer();

            const result = await client.request(
                {
                    method: 'tools/call',
                    params: {
                        name: 'typed-tool',
                        arguments: { name: 'test', count: 42, enabled: true }
                    }
                },
                CallToolResultSchema
            );

            expect((result.content[0] as TextContent).text).toBe('test: 42, enabled: true');
        });
    });
});
