import {
    LATEST_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    ResourceLinkSchema,
    ContentBlockSchema,
    PromptMessageSchema,
    CallToolResultSchema,
    CompleteRequestSchema
} from './types.js';

describe('Types', () => {
    test('should have correct latest protocol version', () => {
        expect(LATEST_PROTOCOL_VERSION).toBeDefined();
        expect(LATEST_PROTOCOL_VERSION).toBe('2025-06-18');
    });
    test('should have correct supported protocol versions', () => {
        expect(SUPPORTED_PROTOCOL_VERSIONS).toBeDefined();
        expect(SUPPORTED_PROTOCOL_VERSIONS).toBeInstanceOf(Array);
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(LATEST_PROTOCOL_VERSION);
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-11-05');
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-10-07');
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-03-26');
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
            const textContent = {
                type: 'text',
                text: 'Hello, world!'
            };

            const result = ContentBlockSchema.safeParse(textContent);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('text');
            }
        });

        test('should validate image content', () => {
            const imageContent = {
                type: 'image',
                data: 'aGVsbG8=', // base64 encoded "hello"
                mimeType: 'image/png'
            };

            const result = ContentBlockSchema.safeParse(imageContent);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('image');
            }
        });

        test('should validate audio content', () => {
            const audioContent = {
                type: 'audio',
                data: 'aGVsbG8=', // base64 encoded "hello"
                mimeType: 'audio/mp3'
            };

            const result = ContentBlockSchema.safeParse(audioContent);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('audio');
            }
        });

        test('should validate resource link content', () => {
            const resourceLink = {
                type: 'resource_link',
                uri: 'file:///path/to/file.txt',
                name: 'file.txt',
                mimeType: 'text/plain'
            };

            const result = ContentBlockSchema.safeParse(resourceLink);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('resource_link');
            }
        });

        test('should validate embedded resource content', () => {
            const embeddedResource = {
                type: 'resource',
                resource: {
                    uri: 'file:///path/to/file.txt',
                    mimeType: 'text/plain',
                    text: 'File contents'
                }
            };

            const result = ContentBlockSchema.safeParse(embeddedResource);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.type).toBe('resource');
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
});
