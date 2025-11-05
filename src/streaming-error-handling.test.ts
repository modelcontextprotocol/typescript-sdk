/**
 * Comprehensive Streaming Error Handling Tests
 * Tests timeout, validation, cancellation, and real-world failure scenarios
 */

import { StreamManager, StreamValidationError } from './server/streaming.js';
import { McpServer } from './server/mcp.js';
import { Client } from './client/index.js';
import { InMemoryTransport } from './inMemory.js';
import { z } from 'zod';

describe('Streaming Error Handling', () => {
    describe('StreamManager Timeout Management', () => {
        let streamManager: StreamManager;

        beforeEach(() => {
            jest.useFakeTimers();
            streamManager = new StreamManager();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        afterEach(() => {
            // Clean up any remaining streams
            const streams = streamManager.listStreams();
            streams.forEach((stream: { callId: string }) => {
                streamManager.cleanupStream(stream.callId);
            });
        });

        test('should create stream with default timeout', () => {
            const callId = streamManager.createStream('test_tool');
            const stream = streamManager.getStream(callId);

            expect(stream).toBeDefined();
            expect(stream?.status).toBe('active');
            expect(stream?.config?.defaultTimeoutMs).toBe(30000);
        });

        test('should handle timeout warning', () => {
            const callId = streamManager.createStream('test_tool');

            // Set up warning handler
            const warningHandler = jest.fn();
            streamManager.onStreamWarning = warningHandler;

            // Fast forward time past warning threshold
            jest.advanceTimersByTime(10000);

            expect(warningHandler).toHaveBeenCalledWith(callId, {
                elapsed: 10000,
                threshold: 10000
            });

            const stream = streamManager.getStream(callId);
            expect(stream?.status).toBe('warning');
        });

        test('should handle hard timeout', () => {
            const callId = streamManager.createStream('test_tool');

            // Set up timeout handler
            const timeoutHandler = jest.fn();
            streamManager.onStreamTimeout = timeoutHandler;

            // Fast forward time past hard timeout
            jest.advanceTimersByTime(30000);

            expect(timeoutHandler).toHaveBeenCalledWith(callId, {
                elapsed: 30000,
                lastActivity: 30000,
                chunksReceived: 0
            });

            // Stream should be cleaned up
            expect(streamManager.getStream(callId)).toBeUndefined();
        });
    });

    describe('Progressive Validation', () => {
        let streamManager: StreamManager;

        beforeEach(() => {
            streamManager = new StreamManager();
        });

        test('should validate concatenate strategy chunks', () => {
            const callId = streamManager.createStream('test_tool', {
                streamingArguments: [{ name: 'message', mergeStrategy: 'concatenate' }]
            });

            // Valid chunk
            expect(() => {
                streamManager.addChunk(callId, 'message', 'Hello');
            }).not.toThrow();

            // Invalid chunk
            expect(() => {
                streamManager.addChunk(callId, 'message', { invalid: 'object' });
            }).toThrow(StreamValidationError);
        });

        test('should validate json_merge strategy chunks', () => {
            const callId = streamManager.createStream('test_tool', {
                streamingArguments: [{ name: 'data', mergeStrategy: 'json_merge' }]
            });

            // Valid chunk
            expect(() => {
                streamManager.addChunk(callId, 'data', { key: 'value' });
            }).not.toThrow();

            // Invalid chunk
            expect(() => {
                streamManager.addChunk(callId, 'data', 'string value');
            }).toThrow(StreamValidationError);
        });

        test('should allow any data for last strategy', () => {
            const callId = streamManager.createStream('test_tool', {
                streamingArguments: [{ name: 'data', mergeStrategy: 'last' }]
            });

            // Any data type should be valid
            expect(() => {
                streamManager.addChunk(callId, 'data', 'string');
                streamManager.addChunk(callId, 'data', { object: 'data' });
                streamManager.addChunk(callId, 'data', 123);
            }).not.toThrow();
        });
    });

    describe('Mid-Stream Error Reporting', () => {
        let server: McpServer;
        let client: Client;
        let errorNotifications: { method: string; params?: unknown }[] = [];

        beforeEach(async () => {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

            client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

            // Set up error notification handler
            client.fallbackNotificationHandler = async (notification: { method: string; params?: unknown }) => {
                if (notification.method === 'notifications/tools/stream_error') {
                    errorNotifications.push(notification);
                }
            };

            // Register tools BEFORE connecting
            server.tool(
                'validate_test',
                'Tool for testing validation',
                { data: z.string() },
                {
                    streamingArguments: [{ name: 'data', mergeStrategy: 'concatenate' }]
                },
                async () => ({ content: [{ type: 'text', text: 'success' }] })
            );

            await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        });

        afterEach(async () => {
            try {
                await client.close();
                await server.close();
            } catch {
                // Ignore cleanup errors
            }
            errorNotifications = [];
        });

        test('should report validation errors immediately', async () => {
            const streamResult = await client.streamTool({ name: 'validate_test' });

            // Send invalid chunk
            await client.sendStreamChunk(streamResult.callId, 'data', { invalid: 'object' });

            // Wait for error notification
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(errorNotifications).toHaveLength(1);
            const notification = errorNotifications[0];
            expect(notification).toHaveProperty('params');
            const params = notification.params as { error: { code: number; message: string; context: { argumentName: string } } };
            expect(params.error.code).toBe(-32602); // InvalidParams
            expect(params.error.message).toContain('Validation failed');
            expect(params.error.context.argumentName).toBe('data');
        });

        test('should provide recoverability information', async () => {
            const streamResult = await client.streamTool({ name: 'validate_test' });

            // Send invalid chunk (recoverable since not final)
            await client.sendStreamChunk(streamResult.callId, 'data', { invalid: 'object' });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(errorNotifications).toHaveLength(1);
            const notification = errorNotifications[0];
            expect(notification).toHaveProperty('params');
            const params = notification.params as { recoverable: boolean; retryPossible: boolean };
            expect(params.recoverable).toBe(true);
            expect(params.retryPossible).toBe(false);
        });
    });

    describe('Real-World Scenarios', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should handle LLM timeout simulation', () => {
            const streamManager = new StreamManager();

            // Simulate LLM timeout scenario
            const callId = streamManager.createStream('llm_tool');

            // Simulate some chunks being sent
            streamManager.addChunk(callId, 'prompt', 'Initial prompt');

            // Simulate long delay (LLM processing)
            jest.advanceTimersByTime(10000);

            // Stream should still be active but with warning
            const stream = streamManager.getStream(callId);
            expect(stream?.status).toBe('warning');
        });

        test('should handle network connection loss', () => {
            const streamManager = new StreamManager();

            const callId = streamManager.createStream('network_tool');

            // Simulate connection loss by not updating activity
            jest.advanceTimersByTime(30000);

            // Should timeout due to inactivity
            const stream = streamManager.getStream(callId);
            expect(stream).toBeUndefined(); // Should be cleaned up
        });

        test('should handle malformed LLM responses', () => {
            const streamManager = new StreamManager();

            const callId = streamManager.createStream('llm_response_tool', {
                streamingArguments: [
                    { name: 'response', mergeStrategy: 'concatenate' },
                    { name: 'metadata', mergeStrategy: 'json_merge' }
                ]
            });

            // Simulate malformed JSON chunks
            expect(() => {
                streamManager.addChunk(callId, 'response', 'incomplete json {');
            }).not.toThrow(); // String is valid for concatenate

            expect(() => {
                streamManager.addChunk(callId, 'metadata', 'not a json object');
            }).toThrow(StreamValidationError);
        });
    });

    describe('Stream Cancellation', () => {
        let streamManager: StreamManager;

        beforeEach(() => {
            streamManager = new StreamManager();
        });

        test('should handle manual cancellation', () => {
            const callId = streamManager.createStream('cancel_test');

            // Simulate cancellation
            streamManager.cleanupStream(callId);

            expect(streamManager.getStream(callId)).toBeUndefined();
        });

        test('should clean up timeouts on cancellation', done => {
            const callId = streamManager.createStream('cancel_test');

            // Set up timeout handler that should not be called
            streamManager.onStreamTimeout = () => {
                fail('Timeout should not be called after cancellation');
            };

            // Cancel quickly
            setTimeout(() => {
                streamManager.cleanupStream(callId);

                // Wait to ensure timeout doesn't fire
                setTimeout(() => {
                    done();
                }, 100);
            }, 10);
        });
    });

    describe('Resource Management', () => {
        let streamManager: StreamManager;

        beforeEach(() => {
            streamManager = new StreamManager();
        });

        test('should clean up all resources', () => {
            const callIds = [streamManager.createStream('test1'), streamManager.createStream('test2'), streamManager.createStream('test3')];

            expect(streamManager.listStreams()).toHaveLength(3);

            // Clean up all streams
            callIds.forEach(callId => {
                streamManager.cleanupStream(callId);
            });

            expect(streamManager.listStreams()).toHaveLength(0);
        });

        test('should handle cleanup of non-existent stream gracefully', () => {
            expect(() => {
                streamManager.cleanupStream('non_existent');
            }).not.toThrow();
        });
    });
});
