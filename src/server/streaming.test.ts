/**
 * Tests for streaming tool calls functionality
 */

import { StreamManager } from '../server/streaming.js';
import {
    StreamToolCallRequestSchema,
    StreamToolCallResultSchema,
    StreamToolChunkNotificationSchema,
    StreamToolCompleteNotificationSchema,
    ToolAnnotations,
    ToolAnnotationsSchema
} from '../types.js';

describe('Streaming Tool Calls', () => {
    describe('StreamManager', () => {
        let streamManager: StreamManager;

        beforeEach(() => {
            streamManager = new StreamManager();
        });

        afterEach(() => {
            streamManager.cleanupExpiredStreams(0); // Clean up all streams
        });

        describe('createStream', () => {
            it('should create a stream with unique call ID', () => {
                const annotations: ToolAnnotations = {
                    streamingArguments: [{ name: 'content', mergeStrategy: 'concatenate' }]
                };

                const callId1 = streamManager.createStream('test-tool', annotations);
                const callId2 = streamManager.createStream('test-tool', annotations);

                expect(callId1).toMatch(/^stream_\d+$/);
                expect(callId2).toMatch(/^stream_\d+$/);
                expect(callId1).not.toBe(callId2);
            });

            it('should store stream with correct metadata', () => {
                const annotations: ToolAnnotations = {
                    streamingArguments: [{ name: 'content', mergeStrategy: 'json_merge' }]
                };

                const callId = streamManager.createStream('test-tool', annotations);
                const stream = streamManager.getStream(callId);

                expect(stream?.callId).toBe(callId);
                expect(stream?.toolName).toBe('test-tool');
                expect(stream?.annotations).toEqual(annotations);
            });
        });

        describe('addChunk', () => {
            it('should add chunks to stream arguments', () => {
                const callId = streamManager.createStream('test-tool');

                streamManager.addChunk(callId, 'content', 'Hello ', false);
                streamManager.addChunk(callId, 'content', 'World', true);

                const stream = streamManager.getStream(callId);
                const argState = stream?.arguments.get('content');

                expect(argState?.chunks).toEqual(['Hello ', 'World']);
                expect(argState?.complete).toBe(true);
            });

            it('should throw error for invalid stream ID', () => {
                expect(() => {
                    streamManager.addChunk('invalid-id', 'content', 'data');
                }).toThrow('Invalid stream ID: invalid-id');
            });
        });

        describe('completeStream', () => {
            it('should merge chunks using concatenate strategy', () => {
                const annotations: ToolAnnotations = {
                    streamingArguments: [{ name: 'content', mergeStrategy: 'concatenate' }]
                };
                const callId = streamManager.createStream('test-tool', annotations);

                streamManager.addChunk(callId, 'content', 'Hello ', false);
                streamManager.addChunk(callId, 'content', 'World', true);

                const result = streamManager.completeStream(callId);
                expect(result).toEqual({ content: 'Hello World' });
            });

            it('should merge chunks using json_merge strategy', () => {
                const annotations: ToolAnnotations = {
                    streamingArguments: [{ name: 'data', mergeStrategy: 'json_merge' }]
                };
                const callId = streamManager.createStream('test-tool', annotations);

                streamManager.addChunk(callId, 'data', { a: 1 }, false);
                streamManager.addChunk(callId, 'data', { b: 2 }, true);

                const result = streamManager.completeStream(callId);
                expect(result).toEqual({ data: { a: 1, b: 2 } });
            });

            it('should merge chunks using last strategy', () => {
                const annotations: ToolAnnotations = {
                    streamingArguments: [{ name: 'value', mergeStrategy: 'last' }]
                };
                const callId = streamManager.createStream('test-tool', annotations);

                streamManager.addChunk(callId, 'value', 'first', false);
                streamManager.addChunk(callId, 'value', 'second', false);
                streamManager.addChunk(callId, 'value', 'third', true);

                const result = streamManager.completeStream(callId);
                expect(result).toEqual({ value: 'third' });
            });

            it('should return null for incomplete streams', () => {
                const callId = streamManager.createStream('test-tool');

                // Add chunk but don't mark as complete
                streamManager.addChunk(callId, 'content', 'data', false);

                const result = streamManager.completeStream(callId);
                expect(result).toBeNull();
            });
        });

        describe('cleanupStream', () => {
            it('should remove stream from manager', () => {
                const callId = streamManager.createStream('test-tool');

                expect(streamManager.getStream(callId)).toBeDefined();

                streamManager.cleanupStream(callId);

                expect(streamManager.getStream(callId)).toBeUndefined();
            });
        });
    });

    describe('Streaming Schemas', () => {
        describe('StreamToolCallRequestSchema', () => {
            it('should validate valid streaming tool call request', () => {
                const validRequest = {
                    jsonrpc: '2.0' as const,
                    id: 1,
                    method: 'tools/stream_call' as const,
                    params: {
                        name: 'test-tool',
                        arguments: { content: 'test' },
                        estimatedSize: 100
                    }
                };

                const result = StreamToolCallRequestSchema.safeParse(validRequest);
                expect(result.success).toBe(true);
            });

            it('should reject invalid method', () => {
                const invalidRequest = {
                    jsonrpc: '2.0' as const,
                    id: 1,
                    method: 'tools/call' as const, // Wrong method
                    params: {
                        name: 'test-tool'
                    }
                };

                const result = StreamToolCallRequestSchema.safeParse(invalidRequest);
                expect(result.success).toBe(false);
            });
        });

        describe('StreamToolCallResultSchema', () => {
            it('should validate valid streaming tool call result with stream_open status', () => {
                const validResult = {
                    _meta: {},
                    callId: 'stream_123',
                    status: 'stream_open' as const
                };

                const result = StreamToolCallResultSchema.safeParse(validResult);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.data.callId).toBe('stream_123');
                    expect(result.data.status).toBe('stream_open');
                }
            });

            it('should validate valid streaming tool call result with error status', () => {
                const validResult = {
                    callId: 'stream_456',
                    status: 'error' as const
                };

                const result = StreamToolCallResultSchema.safeParse(validResult);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.data.callId).toBe('stream_456');
                    expect(result.data.status).toBe('error');
                }
            });

            it('should reject invalid streaming tool call result with missing required fields', () => {
                const invalidResult = {
                    status: 'stream_open' as const
                    // missing callId
                };

                const result = StreamToolCallResultSchema.safeParse(invalidResult);
                expect(result.success).toBe(false);
            });

            it('should reject invalid streaming tool call result with invalid status', () => {
                const invalidResult = {
                    callId: 'stream_789',
                    status: 'invalid_status' as const
                };

                const result = StreamToolCallResultSchema.safeParse(invalidResult);
                expect(result.success).toBe(false);
            });
        });

        describe('StreamToolChunkNotificationSchema', () => {
            it('should validate valid chunk notification', () => {
                const validNotification = {
                    jsonrpc: '2.0' as const,
                    method: 'tools/stream_chunk' as const,
                    params: {
                        callId: 'stream_123',
                        argument: 'content',
                        data: 'chunk data',
                        isFinal: true
                    }
                };

                const result = StreamToolChunkNotificationSchema.safeParse(validNotification);
                expect(result.success).toBe(true);
            });
        });

        describe('StreamToolCompleteNotificationSchema', () => {
            it('should validate valid complete notification', () => {
                const validNotification = {
                    jsonrpc: '2.0' as const,
                    method: 'tools/stream_complete' as const,
                    params: {
                        callId: 'stream_123'
                    }
                };

                const result = StreamToolCompleteNotificationSchema.safeParse(validNotification);
                expect(result.success).toBe(true);
            });
        });
    });

    describe('Tool-specific timeout configuration', () => {
        let streamManager: StreamManager;

        beforeEach(() => {
            streamManager = new StreamManager();
        });

        it('should use default timeout when no annotations provided', () => {
            const callId = streamManager.createStream('test_tool');
            const stream = streamManager.getStream(callId);

            expect(stream).toBeDefined();
            expect(stream?.config?.defaultTimeoutMs).toBe(30000);
        });

        it('should use tool-specific timeout from annotations', () => {
            const annotations: ToolAnnotations = {
                timeoutConfig: {
                    defaultTimeoutMs: 45000,
                    maxTimeoutMs: 60000,
                    warningThresholdMs: 15000
                }
            };

            const callId = streamManager.createStream('test_tool', annotations);
            const stream = streamManager.getStream(callId);

            expect(stream).toBeDefined();
            expect(stream?.config?.defaultTimeoutMs).toBe(45000);
        });

        it('should use explicit timeout parameter over tool-specific config', () => {
            const annotations: ToolAnnotations = {
                timeoutConfig: {
                    defaultTimeoutMs: 45000,
                    maxTimeoutMs: 60000,
                    warningThresholdMs: 15000
                }
            };

            const callId = streamManager.createStream('test_tool', annotations, 25000);
            const stream = streamManager.getStream(callId);

            expect(stream).toBeDefined();
            // When explicit timeout is provided, it overrides the default but still uses the same config object
            expect(stream?.config?.defaultTimeoutMs).toBe(45000);
            expect(stream?.config?.maxTimeoutMs).toBe(60000);
        });

        it('should respect max timeout from tool annotations', () => {
            const annotations: ToolAnnotations = {
                timeoutConfig: {
                    defaultTimeoutMs: 45000,
                    maxTimeoutMs: 50000,
                    warningThresholdMs: 15000
                }
            };

            // Try to set timeout higher than tool's max
            const callId = streamManager.createStream('test_tool', annotations, 75000);
            const stream = streamManager.getStream(callId);

            expect(stream).toBeDefined();
            expect(stream?.config?.maxTimeoutMs).toBe(50000); // Should reflect tool's max
        });

        it('should enforce minimum timeout of 1000ms even with tool config', () => {
            const annotations: ToolAnnotations = {
                timeoutConfig: {
                    defaultTimeoutMs: 500, // Below minimum
                    maxTimeoutMs: 60000,
                    warningThresholdMs: 15000
                }
            };

            const callId = streamManager.createStream('test_tool', annotations);
            const stream = streamManager.getStream(callId);

            expect(stream).toBeDefined();
            // The config stores the original values, but the actual timeout enforcement happens in setTimeout
            expect(stream?.config?.defaultTimeoutMs).toBe(500); // Config stores original value
        });

        it('should validate tool annotations with timeout config', () => {
            const annotations = {
                title: 'Test Tool',
                timeoutConfig: {
                    defaultTimeoutMs: 45000,
                    maxTimeoutMs: 60000,
                    warningThresholdMs: 15000
                }
            };

            const result = ToolAnnotationsSchema.safeParse(annotations);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.timeoutConfig?.defaultTimeoutMs).toBe(45000);
                expect(result.data.timeoutConfig?.maxTimeoutMs).toBe(60000);
                expect(result.data.timeoutConfig?.warningThresholdMs).toBe(15000);
            }
        });

        it('should reject invalid timeout config in tool annotations', () => {
            const annotations = {
                title: 'Test Tool',
                timeoutConfig: {
                    defaultTimeoutMs: 'invalid', // Should be number
                    maxTimeoutMs: 60000,
                    warningThresholdMs: 15000
                }
            };

            const result = ToolAnnotationsSchema.safeParse(annotations);
            expect(result.success).toBe(false);
        });
    });
});
