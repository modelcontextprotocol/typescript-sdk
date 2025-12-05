import {
    LATEST_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    ResourceLinkSchema,
    ContentBlockSchema,
    PromptMessageSchema,
    CallToolResultSchema,
    CompleteRequestSchema,
    ToolSchema,
    ToolUseContentSchema,
    ToolResultContentSchema,
    ToolChoiceSchema,
    SamplingMessageSchema,
    CreateMessageRequestSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    ClientCapabilitiesSchema
} from '../src/types.js';

describe('Types', () => {
    test('should have correct latest protocol version', () => {
        expect(LATEST_PROTOCOL_VERSION).toBeDefined();
        expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    });
    test('should have correct supported protocol versions', () => {
        expect(SUPPORTED_PROTOCOL_VERSIONS).toBeDefined();
        expect(SUPPORTED_PROTOCOL_VERSIONS).toBeInstanceOf(Array);
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(LATEST_PROTOCOL_VERSION);
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-06-18');
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-03-26');
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-11-05');
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-10-07');
    });

    describe('ResourceLink', () => {
        test('should validate a minimal ResourceLink', () => {
            const resourceLink = {
                type: 'resource_link',
                uri: 'file:///path/to/file.txt',
                name: 'file.txt'
            };

            const result = ResourceLinkSchema.safeParse(resourceLink);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('resource_link');
                expect(result.data.uri).toBe('file:///path/to/file.txt');
                expect(result.data.name).toBe('file.txt');
            }
        });

        test('should validate a ResourceLink with all optional fields', () => {
            const resourceLink = {
                type: 'resource_link',
                uri: 'https://example.com/resource',
                name: 'Example Resource',
                title: 'A comprehensive example resource',
                description: 'This resource demonstrates all fields',
                mimeType: 'text/plain',
                _meta: { custom: 'metadata' }
            };

            const result = ResourceLinkSchema.safeParse(resourceLink);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.title).toBe('A comprehensive example resource');
                expect(result.data.description).toBe('This resource demonstrates all fields');
                expect(result.data.mimeType).toBe('text/plain');
                expect(result.data._meta).toEqual({ custom: 'metadata' });
            }
        });

        test('should fail validation for invalid type', () => {
            const invalidResourceLink = {
                type: 'invalid_type',
                uri: 'file:///path/to/file.txt',
                name: 'file.txt'
            };

            const result = ResourceLinkSchema.safeParse(invalidResourceLink);
            expect(result.success).toBe(false);
        });

        test('should fail validation for missing required fields', () => {
            const invalidResourceLink = {
                type: 'resource_link',
                uri: 'file:///path/to/file.txt'
                // missing name
            };

            const result = ResourceLinkSchema.safeParse(invalidResourceLink);
            expect(result.success).toBe(false);
        });
    });

    describe('ContentBlock', () => {
        test('should validate text content', () => {
            const mockDate = new Date().toISOString();
            const textContent = {
                type: 'text',
                text: 'Hello, world!',
                annotations: {
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: mockDate
                }
            };

            const result = ContentBlockSchema.safeParse(textContent);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('text');
                expect(result.data.annotations).toEqual({
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: mockDate
                });
            }
        });

        test('should validate image content', () => {
            const mockDate = new Date().toISOString();
            const imageContent = {
                type: 'image',
                data: 'aGVsbG8=', // base64 encoded "hello"
                mimeType: 'image/png',
                annotations: {
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: mockDate
                }
            };

            const result = ContentBlockSchema.safeParse(imageContent);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('image');
                expect(result.data.annotations).toEqual({
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: mockDate
                });
            }
        });

        test('should validate audio content', () => {
            const mockDate = new Date().toISOString();
            const audioContent = {
                type: 'audio',
                data: 'aGVsbG8=', // base64 encoded "hello"
                mimeType: 'audio/mp3',
                annotations: {
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: mockDate
                }
            };

            const result = ContentBlockSchema.safeParse(audioContent);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('audio');
                expect(result.data.annotations).toEqual({
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: mockDate
                });
            }
        });

        test('should validate resource link content', () => {
            const mockDate = new Date().toISOString();
            const resourceLink = {
                type: 'resource_link',
                uri: 'file:///path/to/file.txt',
                name: 'file.txt',
                mimeType: 'text/plain',
                annotations: {
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: new Date().toISOString()
                }
            };

            const result = ContentBlockSchema.safeParse(resourceLink);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('resource_link');
                expect(result.data.annotations).toEqual({
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: mockDate
                });
            }
        });

        test('should validate embedded resource content', () => {
            const mockDate = new Date().toISOString();
            const embeddedResource = {
                type: 'resource',
                resource: {
                    uri: 'file:///path/to/file.txt',
                    mimeType: 'text/plain',
                    text: 'File contents'
                },
                annotations: {
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: mockDate
                }
            };

            const result = ContentBlockSchema.safeParse(embeddedResource);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('resource');
                expect(result.data.annotations).toEqual({
                    audience: ['user'],
                    priority: 0.5,
                    lastModified: mockDate
                });
            }
        });
    });

    describe('PromptMessage with ContentBlock', () => {
        test('should validate prompt message with resource link', () => {
            const promptMessage = {
                role: 'assistant',
                content: {
                    type: 'resource_link',
                    uri: 'file:///project/src/main.rs',
                    name: 'main.rs',
                    description: 'Primary application entry point',
                    mimeType: 'text/x-rust'
                }
            };

            const result = PromptMessageSchema.safeParse(promptMessage);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.content.type).toBe('resource_link');
            }
        });
    });

    describe('CallToolResult with ContentBlock', () => {
        test('should validate tool result with resource links', () => {
            const toolResult = {
                content: [
                    {
                        type: 'text',
                        text: 'Found the following files:'
                    },
                    {
                        type: 'resource_link',
                        uri: 'file:///project/src/main.rs',
                        name: 'main.rs',
                        description: 'Primary application entry point',
                        mimeType: 'text/x-rust'
                    },
                    {
                        type: 'resource_link',
                        uri: 'file:///project/src/lib.rs',
                        name: 'lib.rs',
                        description: 'Library exports',
                        mimeType: 'text/x-rust'
                    }
                ]
            };

            const result = CallToolResultSchema.safeParse(toolResult);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.content).toHaveLength(3);
                expect(result.data.content[0].type).toBe('text');
                expect(result.data.content[1].type).toBe('resource_link');
                expect(result.data.content[2].type).toBe('resource_link');
            }
        });

        test('should validate empty content array with default', () => {
            const toolResult = {};

            const result = CallToolResultSchema.safeParse(toolResult);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.content).toEqual([]);
            }
        });
    });

    describe('CompleteRequest', () => {
        test('should validate a CompleteRequest without resolved field', () => {
            const request = {
                method: 'completion/complete',
                params: {
                    ref: { type: 'ref/prompt', name: 'greeting' },
                    argument: { name: 'name', value: 'A' }
                }
            };

            const result = CompleteRequestSchema.safeParse(request);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.method).toBe('completion/complete');
                expect(result.data.params.ref.type).toBe('ref/prompt');
                expect(result.data.params.context).toBeUndefined();
            }
        });

        test('should validate a CompleteRequest with resolved field', () => {
            const request = {
                method: 'completion/complete',
                params: {
                    ref: { type: 'ref/resource', uri: 'github://repos/{owner}/{repo}' },
                    argument: { name: 'repo', value: 't' },
                    context: {
                        arguments: {
                            '{owner}': 'microsoft'
                        }
                    }
                }
            };

            const result = CompleteRequestSchema.safeParse(request);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.params.context?.arguments).toEqual({
                    '{owner}': 'microsoft'
                });
            }
        });

        test('should validate a CompleteRequest with empty resolved field', () => {
            const request = {
                method: 'completion/complete',
                params: {
                    ref: { type: 'ref/prompt', name: 'test' },
                    argument: { name: 'arg', value: '' },
                    context: {
                        arguments: {}
                    }
                }
            };

            const result = CompleteRequestSchema.safeParse(request);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.params.context?.arguments).toEqual({});
            }
        });

        test('should validate a CompleteRequest with multiple resolved variables', () => {
            const request = {
                method: 'completion/complete',
                params: {
                    ref: { type: 'ref/resource', uri: 'api://v1/{tenant}/{resource}/{id}' },
                    argument: { name: 'id', value: '123' },
                    context: {
                        arguments: {
                            '{tenant}': 'acme-corp',
                            '{resource}': 'users'
                        }
                    }
                }
            };

            const result = CompleteRequestSchema.safeParse(request);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.params.context?.arguments).toEqual({
                    '{tenant}': 'acme-corp',
                    '{resource}': 'users'
                });
            }
        });
    });

    describe('ToolSchema - JSON Schema 2020-12 support', () => {
        test('should accept inputSchema with $schema field', () => {
            const tool = {
                name: 'test',
                inputSchema: {
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    properties: { name: { type: 'string' } }
                }
            };
            const result = ToolSchema.safeParse(tool);
            expect(result.success).toBe(true);
        });

        test('should accept inputSchema with additionalProperties', () => {
            const tool = {
                name: 'test',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    additionalProperties: false
                }
            };
            const result = ToolSchema.safeParse(tool);
            expect(result.success).toBe(true);
        });

        test('should accept inputSchema with composition keywords', () => {
            const tool = {
                name: 'test',
                inputSchema: {
                    type: 'object',
                    allOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'number' } } }]
                }
            };
            const result = ToolSchema.safeParse(tool);
            expect(result.success).toBe(true);
        });

        test('should accept inputSchema with $ref and $defs', () => {
            const tool = {
                name: 'test',
                inputSchema: {
                    type: 'object',
                    properties: { user: { $ref: '#/$defs/User' } },
                    $defs: {
                        User: { type: 'object', properties: { name: { type: 'string' } } }
                    }
                }
            };
            const result = ToolSchema.safeParse(tool);
            expect(result.success).toBe(true);
        });

        test('should accept inputSchema with metadata keywords', () => {
            const tool = {
                name: 'test',
                inputSchema: {
                    type: 'object',
                    title: 'User Input',
                    description: 'Input parameters for user creation',
                    deprecated: false,
                    examples: [{ name: 'John' }],
                    properties: { name: { type: 'string' } }
                }
            };
            const result = ToolSchema.safeParse(tool);
            expect(result.success).toBe(true);
        });

        test('should accept outputSchema with full JSON Schema features', () => {
            const tool = {
                name: 'test',
                inputSchema: { type: 'object' },
                outputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        tags: { type: 'array' }
                    },
                    required: ['id'],
                    additionalProperties: false,
                    minProperties: 1
                }
            };
            const result = ToolSchema.safeParse(tool);
            expect(result.success).toBe(true);
        });

        test('should still require type: object at root for inputSchema', () => {
            const tool = {
                name: 'test',
                inputSchema: {
                    type: 'string'
                }
            };
            const result = ToolSchema.safeParse(tool);
            expect(result.success).toBe(false);
        });

        test('should still require type: object at root for outputSchema', () => {
            const tool = {
                name: 'test',
                inputSchema: { type: 'object' },
                outputSchema: {
                    type: 'array'
                }
            };
            const result = ToolSchema.safeParse(tool);
            expect(result.success).toBe(false);
        });

        test('should accept simple minimal schema (backward compatibility)', () => {
            const tool = {
                name: 'test',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name']
                }
            };
            const result = ToolSchema.safeParse(tool);
            expect(result.success).toBe(true);
        });
    });

    describe('ToolUseContent', () => {
        test('should validate a tool call content', () => {
            const toolCall = {
                type: 'tool_use',
                id: 'call_123',
                name: 'get_weather',
                input: { city: 'San Francisco', units: 'celsius' }
            };

            const result = ToolUseContentSchema.safeParse(toolCall);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('tool_use');
                expect(result.data.id).toBe('call_123');
                expect(result.data.name).toBe('get_weather');
                expect(result.data.input).toEqual({ city: 'San Francisco', units: 'celsius' });
            }
        });

        test('should validate tool call with _meta', () => {
            const toolCall = {
                type: 'tool_use',
                id: 'call_456',
                name: 'search',
                input: { query: 'test' },
                _meta: { custom: 'data' }
            };

            const result = ToolUseContentSchema.safeParse(toolCall);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data._meta).toEqual({ custom: 'data' });
            }
        });

        test('should fail validation for missing required fields', () => {
            const invalidToolCall = {
                type: 'tool_use',
                name: 'test'
                // missing id and input
            };

            const result = ToolUseContentSchema.safeParse(invalidToolCall);
            expect(result.success).toBe(false);
        });
    });

    describe('ToolResultContent', () => {
        test('should validate a tool result content', () => {
            const toolResult = {
                type: 'tool_result',
                toolUseId: 'call_123',
                structuredContent: { temperature: 72, condition: 'sunny' }
            };

            const result = ToolResultContentSchema.safeParse(toolResult);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('tool_result');
                expect(result.data.toolUseId).toBe('call_123');
                expect(result.data.structuredContent).toEqual({ temperature: 72, condition: 'sunny' });
            }
        });

        test('should validate tool result with error in content', () => {
            const toolResult = {
                type: 'tool_result',
                toolUseId: 'call_456',
                structuredContent: { error: 'API_ERROR', message: 'Service unavailable' },
                isError: true
            };

            const result = ToolResultContentSchema.safeParse(toolResult);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.structuredContent).toEqual({ error: 'API_ERROR', message: 'Service unavailable' });
                expect(result.data.isError).toBe(true);
            }
        });

        test('should fail validation for missing required fields', () => {
            const invalidToolResult = {
                type: 'tool_result',
                content: { data: 'test' }
                // missing toolUseId
            };

            const result = ToolResultContentSchema.safeParse(invalidToolResult);
            expect(result.success).toBe(false);
        });
    });

    describe('ToolChoice', () => {
        test('should validate tool choice with mode auto', () => {
            const toolChoice = {
                mode: 'auto'
            };

            const result = ToolChoiceSchema.safeParse(toolChoice);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.mode).toBe('auto');
            }
        });

        test('should validate tool choice with mode required', () => {
            const toolChoice = {
                mode: 'required'
            };

            const result = ToolChoiceSchema.safeParse(toolChoice);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.mode).toBe('required');
            }
        });

        test('should validate empty tool choice', () => {
            const toolChoice = {};

            const result = ToolChoiceSchema.safeParse(toolChoice);
            expect(result.success).toBe(true);
        });

        test('should fail validation for invalid mode', () => {
            const invalidToolChoice = {
                mode: 'invalid'
            };

            const result = ToolChoiceSchema.safeParse(invalidToolChoice);
            expect(result.success).toBe(false);
        });
    });

    describe('SamplingMessage content types', () => {
        test('should validate user message with text', () => {
            const userMessage = {
                role: 'user',
                content: { type: 'text', text: "What's the weather?" }
            };

            const result = SamplingMessageSchema.safeParse(userMessage);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.role).toBe('user');
                if (!Array.isArray(result.data.content)) {
                    expect(result.data.content.type).toBe('text');
                }
            }
        });

        test('should validate user message with tool result', () => {
            const userMessage = {
                role: 'user',
                content: {
                    type: 'tool_result',
                    toolUseId: 'call_123',
                    content: []
                }
            };

            const result = SamplingMessageSchema.safeParse(userMessage);
            expect(result.success).toBe(true);
            if (result.success && !Array.isArray(result.data.content)) {
                expect(result.data.content.type).toBe('tool_result');
            }
        });

        test('should validate assistant message with text', () => {
            const assistantMessage = {
                role: 'assistant',
                content: { type: 'text', text: "I'll check the weather for you." }
            };

            const result = SamplingMessageSchema.safeParse(assistantMessage);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.role).toBe('assistant');
            }
        });

        test('should validate assistant message with tool call', () => {
            const assistantMessage = {
                role: 'assistant',
                content: {
                    type: 'tool_use',
                    id: 'call_123',
                    name: 'get_weather',
                    input: { city: 'SF' }
                }
            };

            const result = SamplingMessageSchema.safeParse(assistantMessage);
            expect(result.success).toBe(true);
            if (result.success && !Array.isArray(result.data.content)) {
                expect(result.data.content.type).toBe('tool_use');
            }
        });

        test('should validate any content type for any role', () => {
            // The simplified schema allows any content type for any role
            const assistantWithToolResult = {
                role: 'assistant',
                content: {
                    type: 'tool_result',
                    toolUseId: 'call_123',
                    content: []
                }
            };

            const result1 = SamplingMessageSchema.safeParse(assistantWithToolResult);
            expect(result1.success).toBe(true);

            const userWithToolUse = {
                role: 'user',
                content: {
                    type: 'tool_use',
                    id: 'call_123',
                    name: 'test',
                    input: {}
                }
            };

            const result2 = SamplingMessageSchema.safeParse(userWithToolUse);
            expect(result2.success).toBe(true);
        });
    });

    describe('SamplingMessage', () => {
        test('should validate user message via discriminated union', () => {
            const message = {
                role: 'user',
                content: { type: 'text', text: 'Hello' }
            };

            const result = SamplingMessageSchema.safeParse(message);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.role).toBe('user');
            }
        });

        test('should validate assistant message via discriminated union', () => {
            const message = {
                role: 'assistant',
                content: { type: 'text', text: 'Hi there!' }
            };

            const result = SamplingMessageSchema.safeParse(message);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.role).toBe('assistant');
            }
        });
    });

    describe('CreateMessageRequest', () => {
        test('should validate request without tools', () => {
            const request = {
                method: 'sampling/createMessage',
                params: {
                    messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
                    maxTokens: 1000
                }
            };

            const result = CreateMessageRequestSchema.safeParse(request);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.params.tools).toBeUndefined();
            }
        });

        test('should validate request with tools', () => {
            const request = {
                method: 'sampling/createMessage',
                params: {
                    messages: [{ role: 'user', content: { type: 'text', text: "What's the weather?" } }],
                    maxTokens: 1000,
                    tools: [
                        {
                            name: 'get_weather',
                            description: 'Get weather for a location',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    location: { type: 'string' }
                                },
                                required: ['location']
                            }
                        }
                    ],
                    toolChoice: {
                        mode: 'auto'
                    }
                }
            };

            const result = CreateMessageRequestSchema.safeParse(request);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.params.tools).toHaveLength(1);
                expect(result.data.params.toolChoice?.mode).toBe('auto');
            }
        });

        test('should validate request with includeContext (soft-deprecated)', () => {
            const request = {
                method: 'sampling/createMessage',
                params: {
                    messages: [{ role: 'user', content: { type: 'text', text: 'Help' } }],
                    maxTokens: 1000,
                    includeContext: 'thisServer'
                }
            };

            const result = CreateMessageRequestSchema.safeParse(request);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.params.includeContext).toBe('thisServer');
            }
        });
    });

    describe('CreateMessageResult', () => {
        test('should validate result with text content', () => {
            const result = {
                model: 'claude-3-5-sonnet-20241022',
                role: 'assistant',
                content: { type: 'text', text: "Here's the answer." },
                stopReason: 'endTurn'
            };

            const parseResult = CreateMessageResultSchema.safeParse(result);
            expect(parseResult.success).toBe(true);
            if (parseResult.success) {
                expect(parseResult.data.role).toBe('assistant');
                expect(parseResult.data.stopReason).toBe('endTurn');
            }
        });

        test('should validate result with tool call (using WithTools schema)', () => {
            const result = {
                model: 'claude-3-5-sonnet-20241022',
                role: 'assistant',
                content: {
                    type: 'tool_use',
                    id: 'call_123',
                    name: 'get_weather',
                    input: { city: 'SF' }
                },
                stopReason: 'toolUse'
            };

            // Tool call results use CreateMessageResultWithToolsSchema
            const parseResult = CreateMessageResultWithToolsSchema.safeParse(result);
            expect(parseResult.success).toBe(true);
            if (parseResult.success) {
                expect(parseResult.data.stopReason).toBe('toolUse');
                const content = parseResult.data.content;
                expect(Array.isArray(content)).toBe(false);
                if (!Array.isArray(content)) {
                    expect(content.type).toBe('tool_use');
                }
            }

            // Basic CreateMessageResultSchema should NOT accept tool_use content
            const basicResult = CreateMessageResultSchema.safeParse(result);
            expect(basicResult.success).toBe(false);
        });

        test('should validate result with array content (using WithTools schema)', () => {
            const result = {
                model: 'claude-3-5-sonnet-20241022',
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me check the weather.' },
                    {
                        type: 'tool_use',
                        id: 'call_123',
                        name: 'get_weather',
                        input: { city: 'SF' }
                    }
                ],
                stopReason: 'toolUse'
            };

            // Array content uses CreateMessageResultWithToolsSchema
            const parseResult = CreateMessageResultWithToolsSchema.safeParse(result);
            expect(parseResult.success).toBe(true);
            if (parseResult.success) {
                expect(parseResult.data.stopReason).toBe('toolUse');
                const content = parseResult.data.content;
                expect(Array.isArray(content)).toBe(true);
                if (Array.isArray(content)) {
                    expect(content).toHaveLength(2);
                    expect(content[0].type).toBe('text');
                    expect(content[1].type).toBe('tool_use');
                }
            }

            // Basic CreateMessageResultSchema should NOT accept array content
            const basicResult = CreateMessageResultSchema.safeParse(result);
            expect(basicResult.success).toBe(false);
        });

        test('should validate all new stop reasons', () => {
            const stopReasons = ['endTurn', 'stopSequence', 'maxTokens', 'toolUse', 'refusal', 'other'];

            stopReasons.forEach(stopReason => {
                const result = {
                    model: 'test',
                    role: 'assistant',
                    content: { type: 'text', text: 'test' },
                    stopReason
                };

                const parseResult = CreateMessageResultSchema.safeParse(result);
                expect(parseResult.success).toBe(true);
            });
        });

        test('should allow custom stop reason string', () => {
            const result = {
                model: 'test',
                role: 'assistant',
                content: { type: 'text', text: 'test' },
                stopReason: 'custom_provider_reason'
            };

            const parseResult = CreateMessageResultSchema.safeParse(result);
            expect(parseResult.success).toBe(true);
        });
    });

    describe('ClientCapabilities with sampling', () => {
        test('should validate capabilities with sampling.tools', () => {
            const capabilities = {
                sampling: {
                    tools: {}
                }
            };

            const result = ClientCapabilitiesSchema.safeParse(capabilities);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.sampling?.tools).toBeDefined();
            }
        });

        test('should validate capabilities with sampling.context', () => {
            const capabilities = {
                sampling: {
                    context: {}
                }
            };

            const result = ClientCapabilitiesSchema.safeParse(capabilities);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.sampling?.context).toBeDefined();
            }
        });

        test('should validate capabilities with both', () => {
            const capabilities = {
                sampling: {
                    context: {},
                    tools: {}
                }
            };

            const result = ClientCapabilitiesSchema.safeParse(capabilities);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.sampling?.context).toBeDefined();
                expect(result.data.sampling?.tools).toBeDefined();
            }
        });
    });
});
