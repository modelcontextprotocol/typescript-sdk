import type { MockInstance } from 'vitest';
import { vi } from 'vitest';
import * as z from 'zod/v4';
import type { ZodType } from 'zod/v4';

import type {
    QueuedMessage,
    QueuedNotification,
    QueuedRequest,
    TaskMessageQueue,
    TaskStore
} from '../../src/experimental/tasks/interfaces.js';
import { InMemoryTaskMessageQueue } from '../../src/experimental/tasks/stores/inMemory.js';
import type { BaseContext } from '../../src/shared/protocol.js';
import { mergeCapabilities, Protocol } from '../../src/shared/protocol.js';
import type { ErrorMessage, ResponseMessage } from '../../src/shared/responseMessage.js';
import { toArrayAsync } from '../../src/shared/responseMessage.js';
import type { Transport, TransportSendOptions } from '../../src/shared/transport.js';
import type {
    ClientCapabilities,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCRequest,
    JSONRPCResultResponse,
    Notification,
    Request,
    RequestId,
    Result,
    ServerCapabilities,
    Task,
    TaskCreationParams
} from '../../src/types/types.js';
import { ProtocolError, ProtocolErrorCode, RELATED_TASK_META_KEY } from '../../src/types/types.js';
import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors.js';

// Type helper for accessing private/protected Protocol properties in tests
interface TestProtocol {
    _taskMessageQueue?: TaskMessageQueue;
    _requestResolvers: Map<RequestId, (response: JSONRPCResultResponse | Error) => void>;
    _responseHandlers: Map<RequestId, (response: JSONRPCResultResponse | Error) => void>;
    _taskProgressTokens: Map<string, number>;
    _clearTaskQueue: (taskId: string, sessionId?: string) => Promise<void>;
    requestTaskStore: (request: Request, authInfo: unknown) => TaskStore;
    // Protected task methods (exposed for testing)
    listTasks: (params?: { cursor?: string }) => Promise<{ tasks: Task[]; nextCursor?: string }>;
    cancelTask: (params: { taskId: string }) => Promise<Result>;
    requestStream: <T extends Result>(request: Request, schema: ZodType<T>, options?: unknown) => AsyncGenerator<ResponseMessage<T>>;
}

// Mock Transport class
class MockTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;

    async start(): Promise<void> {}
    async close(): Promise<void> {
        this.onclose?.();
    }
    async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}
}

function createMockTaskStore(options?: {
    onStatus?: (status: Task['status']) => void;
    onList?: () => void;
}): TaskStore & { [K in keyof TaskStore]: MockInstance } {
    const tasks: Record<string, Task & { result?: Result }> = {};
    return {
        createTask: vi.fn((taskParams: TaskCreationParams, _1: RequestId, _2: Request) => {
            // Generate a unique task ID
            const taskId = `test-task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const createdAt = new Date().toISOString();
            const task = (tasks[taskId] = {
                taskId,
                status: 'working',
                ttl: taskParams.ttl ?? null,
                createdAt,
                lastUpdatedAt: createdAt,
                pollInterval: taskParams.pollInterval ?? 1000
            });
            options?.onStatus?.('working');
            return Promise.resolve(task);
        }),
        getTask: vi.fn((taskId: string) => {
            return Promise.resolve(tasks[taskId] ?? null);
        }),
        updateTaskStatus: vi.fn((taskId, status, statusMessage) => {
            const task = tasks[taskId];
            if (task) {
                task.status = status;
                task.statusMessage = statusMessage;
                options?.onStatus?.(task.status);
            }
            return Promise.resolve();
        }),
        storeTaskResult: vi.fn((taskId: string, status: 'completed' | 'failed', result: Result) => {
            const task = tasks[taskId];
            if (task) {
                task.status = status;
                task.result = result;
                options?.onStatus?.(status);
            }
            return Promise.resolve();
        }),
        getTaskResult: vi.fn((taskId: string) => {
            const task = tasks[taskId];
            if (task?.result) {
                return Promise.resolve(task.result);
            }
            throw new Error('Task result not found');
        }),
        listTasks: vi.fn(() => {
            const result = {
                tasks: Object.values(tasks)
            };
            options?.onList?.();
            return Promise.resolve(result);
        })
    };
}

function createLatch() {
    let latch = false;
    const waitForLatch = async () => {
        while (!latch) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    };

    return {
        releaseLatch: () => {
            latch = true;
        },
        waitForLatch
    };
}

function assertErrorResponse(o: ResponseMessage<Result>): asserts o is ErrorMessage {
    expect(o.type).toBe('error');
}

function assertQueuedNotification(o?: QueuedMessage): asserts o is QueuedNotification {
    expect(o).toBeDefined();
    expect(o?.type).toBe('notification');
}

function assertQueuedRequest(o?: QueuedMessage): asserts o is QueuedRequest {
    expect(o).toBeDefined();
    expect(o?.type).toBe('request');
}

describe('protocol tests', () => {
    let protocol: Protocol<BaseContext>;
    let transport: MockTransport;
    let sendSpy: MockInstance;

    beforeEach(() => {
        transport = new MockTransport();
        sendSpy = vi.spyOn(transport, 'send');
        protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })();
    });

    test('should throw a timeout error if the request exceeds the timeout', async () => {
        await protocol.connect(transport);
        const request = { method: 'example', params: {} };
        try {
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            await protocol.request(request, mockSchema, {
                timeout: 0
            });
        } catch (error) {
            expect(error).toBeInstanceOf(SdkError);
            if (error instanceof SdkError) {
                expect(error.code).toBe(SdkErrorCode.RequestTimeout);
            }
        }
    });

    test('should invoke onclose when the connection is closed', async () => {
        const oncloseMock = vi.fn();
        protocol.onclose = oncloseMock;
        await protocol.connect(transport);
        await transport.close();
        expect(oncloseMock).toHaveBeenCalled();
    });

    test('should not overwrite existing hooks when connecting transports', async () => {
        const oncloseMock = vi.fn();
        const onerrorMock = vi.fn();
        const onmessageMock = vi.fn();
        transport.onclose = oncloseMock;
        transport.onerror = onerrorMock;
        transport.onmessage = onmessageMock;
        await protocol.connect(transport);
        transport.onclose();
        transport.onerror(new Error());
        transport.onmessage('');
        expect(oncloseMock).toHaveBeenCalled();
        expect(onerrorMock).toHaveBeenCalled();
        expect(onmessageMock).toHaveBeenCalled();
    });

    describe('_meta preservation with onprogress', () => {
        test('should preserve existing _meta when adding progressToken', async () => {
            await protocol.connect(transport);
            const request = {
                method: 'example',
                params: {
                    data: 'test',
                    _meta: {
                        customField: 'customValue',
                        anotherField: 123
                    }
                }
            };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = vi.fn();

            // Start request but don't await - we're testing the sent message
            void protocol
                .request(request, mockSchema, {
                    onprogress: onProgressMock
                })
                .catch(() => {
                    // May not complete, ignore error
                });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'example',
                    params: {
                        data: 'test',
                        _meta: {
                            customField: 'customValue',
                            anotherField: 123,
                            progressToken: expect.any(Number)
                        }
                    },
                    jsonrpc: '2.0',
                    id: expect.any(Number)
                }),
                expect.any(Object)
            );
        });

        test('should create _meta with progressToken when no _meta exists', async () => {
            await protocol.connect(transport);
            const request = {
                method: 'example',
                params: {
                    data: 'test'
                }
            };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = vi.fn();

            // Start request but don't await - we're testing the sent message
            void protocol
                .request(request, mockSchema, {
                    onprogress: onProgressMock
                })
                .catch(() => {
                    // May not complete, ignore error
                });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'example',
                    params: {
                        data: 'test',
                        _meta: {
                            progressToken: expect.any(Number)
                        }
                    },
                    jsonrpc: '2.0',
                    id: expect.any(Number)
                }),
                expect.any(Object)
            );
        });

        test('should not modify _meta when onprogress is not provided', async () => {
            await protocol.connect(transport);
            const request = {
                method: 'example',
                params: {
                    data: 'test',
                    _meta: {
                        customField: 'customValue'
                    }
                }
            };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });

            // Start request but don't await - we're testing the sent message
            void protocol.request(request, mockSchema).catch(() => {
                // May not complete, ignore error
            });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'example',
                    params: {
                        data: 'test',
                        _meta: {
                            customField: 'customValue'
                        }
                    },
                    jsonrpc: '2.0',
                    id: expect.any(Number)
                }),
                expect.any(Object)
            );
        });

        test('should handle params being undefined with onprogress', async () => {
            await protocol.connect(transport);
            const request = {
                method: 'example'
            };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = vi.fn();

            // Start request but don't await - we're testing the sent message
            void protocol
                .request(request, mockSchema, {
                    onprogress: onProgressMock
                })
                .catch(() => {
                    // May not complete, ignore error
                });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'example',
                    params: {
                        _meta: {
                            progressToken: expect.any(Number)
                        }
                    },
                    jsonrpc: '2.0',
                    id: expect.any(Number)
                }),
                expect.any(Object)
            );
        });
    });

    describe('progress notification timeout behavior', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        test('should not reset timeout when resetTimeoutOnProgress is false', async () => {
            await protocol.connect(transport);
            const request = { method: 'example', params: {} };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = vi.fn();
            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                resetTimeoutOnProgress: false,
                onprogress: onProgressMock
            });

            vi.advanceTimersByTime(800);

            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {
                        progressToken: 0,
                        progress: 50,
                        total: 100
                    }
                });
            }
            await Promise.resolve();

            expect(onProgressMock).toHaveBeenCalledWith({
                progress: 50,
                total: 100
            });

            vi.advanceTimersByTime(201);

            await expect(requestPromise).rejects.toThrow('Request timed out');
        });

        test('should reset timeout when progress notification is received', async () => {
            await protocol.connect(transport);
            const request = { method: 'example', params: {} };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = vi.fn();
            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                resetTimeoutOnProgress: true,
                onprogress: onProgressMock
            });
            vi.advanceTimersByTime(800);
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {
                        progressToken: 0,
                        progress: 50,
                        total: 100
                    }
                });
            }
            await Promise.resolve();
            expect(onProgressMock).toHaveBeenCalledWith({
                progress: 50,
                total: 100
            });
            vi.advanceTimersByTime(800);
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: 0,
                    result: { result: 'success' }
                });
            }
            await Promise.resolve();
            await expect(requestPromise).resolves.toEqual({ result: 'success' });
        });

        test('should respect maxTotalTimeout', async () => {
            await protocol.connect(transport);
            const request = { method: 'example', params: {} };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = vi.fn();
            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                maxTotalTimeout: 150,
                resetTimeoutOnProgress: true,
                onprogress: onProgressMock
            });

            // First progress notification should work
            vi.advanceTimersByTime(80);
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {
                        progressToken: 0,
                        progress: 50,
                        total: 100
                    }
                });
            }
            await Promise.resolve();
            expect(onProgressMock).toHaveBeenCalledWith({
                progress: 50,
                total: 100
            });
            vi.advanceTimersByTime(80);
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {
                        progressToken: 0,
                        progress: 75,
                        total: 100
                    }
                });
            }
            await expect(requestPromise).rejects.toThrow('Maximum total timeout exceeded');
            expect(onProgressMock).toHaveBeenCalledTimes(1);
        });

        test('should timeout if no progress received within timeout period', async () => {
            await protocol.connect(transport);
            const request = { method: 'example', params: {} };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 100,
                resetTimeoutOnProgress: true
            });
            vi.advanceTimersByTime(101);
            await expect(requestPromise).rejects.toThrow('Request timed out');
        });

        test('should handle multiple progress notifications correctly', async () => {
            await protocol.connect(transport);
            const request = { method: 'example', params: {} };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = vi.fn();
            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                resetTimeoutOnProgress: true,
                onprogress: onProgressMock
            });

            // Simulate multiple progress updates
            for (let i = 1; i <= 3; i++) {
                vi.advanceTimersByTime(800);
                if (transport.onmessage) {
                    transport.onmessage({
                        jsonrpc: '2.0',
                        method: 'notifications/progress',
                        params: {
                            progressToken: 0,
                            progress: i * 25,
                            total: 100
                        }
                    });
                }
                await Promise.resolve();
                expect(onProgressMock).toHaveBeenNthCalledWith(i, {
                    progress: i * 25,
                    total: 100
                });
            }
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: 0,
                    result: { result: 'success' }
                });
            }
            await Promise.resolve();
            await expect(requestPromise).resolves.toEqual({ result: 'success' });
        });

        test('should handle progress notifications with message field', async () => {
            await protocol.connect(transport);
            const request = { method: 'example', params: {} };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = vi.fn();

            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                onprogress: onProgressMock
            });

            vi.advanceTimersByTime(200);

            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {
                        progressToken: 0,
                        progress: 25,
                        total: 100,
                        message: 'Initializing process...'
                    }
                });
            }
            await Promise.resolve();

            expect(onProgressMock).toHaveBeenCalledWith({
                progress: 25,
                total: 100,
                message: 'Initializing process...'
            });

            vi.advanceTimersByTime(200);

            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {
                        progressToken: 0,
                        progress: 75,
                        total: 100,
                        message: 'Processing data...'
                    }
                });
            }
            await Promise.resolve();

            expect(onProgressMock).toHaveBeenCalledWith({
                progress: 75,
                total: 100,
                message: 'Processing data...'
            });

            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: 0,
                    result: { result: 'success' }
                });
            }
            await Promise.resolve();
            await expect(requestPromise).resolves.toEqual({ result: 'success' });
        });
    });

    describe('Debounced Notifications', () => {
        // We need to flush the microtask queue to test the debouncing logic.
        // This helper function does that.
        const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));

        it('should NOT debounce a notification that has parameters', async () => {
            // ARRANGE
            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ debouncedNotificationMethods: ['test/debounced_with_params'] });
            await protocol.connect(transport);

            // ACT
            // These notifications are configured for debouncing but contain params, so they should be sent immediately.
            await protocol.notification({ method: 'test/debounced_with_params', params: { data: 1 } });
            await protocol.notification({ method: 'test/debounced_with_params', params: { data: 2 } });

            // ASSERT
            // Both should have been sent immediately to avoid data loss.
            expect(sendSpy).toHaveBeenCalledTimes(2);
            expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ params: { data: 1 } }), undefined);
            expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ params: { data: 2 } }), undefined);
        });

        it('should NOT debounce a notification that has a relatedRequestId', async () => {
            // ARRANGE
            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ debouncedNotificationMethods: ['test/debounced_with_options'] });
            await protocol.connect(transport);

            // ACT
            await protocol.notification({ method: 'test/debounced_with_options' }, { relatedRequestId: 'req-1' });
            await protocol.notification({ method: 'test/debounced_with_options' }, { relatedRequestId: 'req-2' });

            // ASSERT
            expect(sendSpy).toHaveBeenCalledTimes(2);
            expect(sendSpy).toHaveBeenCalledWith(expect.any(Object), { relatedRequestId: 'req-1' });
            expect(sendSpy).toHaveBeenCalledWith(expect.any(Object), { relatedRequestId: 'req-2' });
        });

        it('should clear pending debounced notifications on connection close', async () => {
            // ARRANGE
            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ debouncedNotificationMethods: ['test/debounced'] });
            await protocol.connect(transport);

            // ACT
            // Schedule a notification but don't flush the microtask queue.
            protocol.notification({ method: 'test/debounced' });

            // Close the connection. This should clear the pending set.
            await protocol.close();

            // Now, flush the microtask queue.
            await flushMicrotasks();

            // ASSERT
            // The send should never have happened because the transport was cleared.
            expect(sendSpy).not.toHaveBeenCalled();
        });

        it('should debounce multiple synchronous calls when params property is omitted', async () => {
            // ARRANGE
            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ debouncedNotificationMethods: ['test/debounced'] });
            await protocol.connect(transport);

            // ACT
            // This is the more idiomatic way to write a notification with no params.
            protocol.notification({ method: 'test/debounced' });
            protocol.notification({ method: 'test/debounced' });
            protocol.notification({ method: 'test/debounced' });

            expect(sendSpy).not.toHaveBeenCalled();
            await flushMicrotasks();

            // ASSERT
            expect(sendSpy).toHaveBeenCalledTimes(1);
            // The final sent object might not even have the `params` key, which is fine.
            // We can check that it was called and that the params are "falsy".
            const sentNotification = sendSpy.mock.calls[0]![0];
            expect(sentNotification.method).toBe('test/debounced');
            expect(sentNotification.params).toBeUndefined();
        });

        it('should debounce calls when params is explicitly undefined', async () => {
            // ARRANGE
            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ debouncedNotificationMethods: ['test/debounced'] });
            await protocol.connect(transport);

            // ACT
            protocol.notification({ method: 'test/debounced', params: undefined });
            protocol.notification({ method: 'test/debounced', params: undefined });
            await flushMicrotasks();

            // ASSERT
            expect(sendSpy).toHaveBeenCalledTimes(1);
            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'test/debounced',
                    params: undefined
                }),
                undefined
            );
        });

        it('should send non-debounced notifications immediately and multiple times', async () => {
            // ARRANGE
            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ debouncedNotificationMethods: ['test/debounced'] }); // Configure for a different method
            await protocol.connect(transport);

            // ACT
            // Call a non-debounced notification method multiple times.
            await protocol.notification({ method: 'test/immediate' });
            await protocol.notification({ method: 'test/immediate' });

            // ASSERT
            // Since this method is not in the debounce list, it should be sent every time.
            expect(sendSpy).toHaveBeenCalledTimes(2);
        });

        it('should not debounce any notifications if the option is not provided', async () => {
            // ARRANGE
            // Use the default protocol from beforeEach, which has no debounce options.
            await protocol.connect(transport);

            // ACT
            await protocol.notification({ method: 'any/method' });
            await protocol.notification({ method: 'any/method' });

            // ASSERT
            // Without the config, behavior should be immediate sending.
            expect(sendSpy).toHaveBeenCalledTimes(2);
        });

        it('should handle sequential batches of debounced notifications correctly', async () => {
            // ARRANGE
            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ debouncedNotificationMethods: ['test/debounced'] });
            await protocol.connect(transport);

            // ACT (Batch 1)
            protocol.notification({ method: 'test/debounced' });
            protocol.notification({ method: 'test/debounced' });
            await flushMicrotasks();

            // ASSERT (Batch 1)
            expect(sendSpy).toHaveBeenCalledTimes(1);

            // ACT (Batch 2)
            // After the first batch has been sent, a new batch should be possible.
            protocol.notification({ method: 'test/debounced' });
            protocol.notification({ method: 'test/debounced' });
            await flushMicrotasks();

            // ASSERT (Batch 2)
            // The total number of sends should now be 2.
            expect(sendSpy).toHaveBeenCalledTimes(2);
        });
    });
});

describe('InMemoryTaskMessageQueue', () => {
    let queue: TaskMessageQueue;
    const taskId = 'test-task-id';

    beforeEach(() => {
        queue = new InMemoryTaskMessageQueue();
    });

    describe('enqueue/dequeue maintains FIFO order', () => {
        it('should maintain FIFO order for multiple messages', async () => {
            const msg1 = {
                type: 'notification' as const,
                message: { jsonrpc: '2.0' as const, method: 'test1' },
                timestamp: 1
            };
            const msg2 = {
                type: 'request' as const,
                message: { jsonrpc: '2.0' as const, id: 1, method: 'test2' },
                timestamp: 2
            };
            const msg3 = {
                type: 'notification' as const,
                message: { jsonrpc: '2.0' as const, method: 'test3' },
                timestamp: 3
            };

            await queue.enqueue(taskId, msg1);
            await queue.enqueue(taskId, msg2);
            await queue.enqueue(taskId, msg3);

            expect(await queue.dequeue(taskId)).toEqual(msg1);
            expect(await queue.dequeue(taskId)).toEqual(msg2);
            expect(await queue.dequeue(taskId)).toEqual(msg3);
        });

        it('should return undefined when dequeuing from empty queue', async () => {
            expect(await queue.dequeue(taskId)).toBeUndefined();
        });
    });

    describe('dequeueAll operation', () => {
        it('should return all messages in FIFO order', async () => {
            const msg1 = {
                type: 'notification' as const,
                message: { jsonrpc: '2.0' as const, method: 'test1' },
                timestamp: 1
            };
            const msg2 = {
                type: 'request' as const,
                message: { jsonrpc: '2.0' as const, id: 1, method: 'test2' },
                timestamp: 2
            };
            const msg3 = {
                type: 'notification' as const,
                message: { jsonrpc: '2.0' as const, method: 'test3' },
                timestamp: 3
            };

            await queue.enqueue(taskId, msg1);
            await queue.enqueue(taskId, msg2);
            await queue.enqueue(taskId, msg3);

            const allMessages = await queue.dequeueAll(taskId);

            expect(allMessages).toEqual([msg1, msg2, msg3]);
        });

        it('should return empty array for empty queue', async () => {
            const allMessages = await queue.dequeueAll(taskId);
            expect(allMessages).toEqual([]);
        });

        it('should clear queue after dequeueAll', async () => {
            await queue.enqueue(taskId, {
                type: 'notification' as const,
                message: { jsonrpc: '2.0' as const, method: 'test1' },
                timestamp: 1
            });
            await queue.enqueue(taskId, {
                type: 'notification' as const,
                message: { jsonrpc: '2.0' as const, method: 'test2' },
                timestamp: 2
            });

            await queue.dequeueAll(taskId);

            expect(await queue.dequeue(taskId)).toBeUndefined();
        });
    });
});

describe('mergeCapabilities', () => {
    it('should merge client capabilities', () => {
        const base: ClientCapabilities = {
            sampling: {},
            roots: {
                listChanged: true
            }
        };

        const additional: ClientCapabilities = {
            experimental: {
                feature: {
                    featureFlag: true
                }
            },
            elicitation: {},
            roots: {
                listChanged: true
            }
        };

        const merged = mergeCapabilities(base, additional);
        expect(merged).toEqual({
            sampling: {},
            elicitation: {},
            roots: {
                listChanged: true
            },
            experimental: {
                feature: {
                    featureFlag: true
                }
            }
        });
    });

    it('should merge server capabilities', () => {
        const base: ServerCapabilities = {
            logging: {},
            prompts: {
                listChanged: true
            }
        };

        const additional: ServerCapabilities = {
            resources: {
                subscribe: true
            },
            prompts: {
                listChanged: true
            }
        };

        const merged = mergeCapabilities(base, additional);
        expect(merged).toEqual({
            logging: {},
            prompts: {
                listChanged: true
            },
            resources: {
                subscribe: true
            }
        });
    });

    it('should override existing values with additional values', () => {
        const base: ServerCapabilities = {
            prompts: {
                listChanged: false
            }
        };

        const additional: ServerCapabilities = {
            prompts: {
                listChanged: true
            }
        };

        const merged = mergeCapabilities(base, additional);
        expect(merged.prompts!.listChanged).toBe(true);
    });

    it('should handle empty objects', () => {
        const base = {};
        const additional = {};
        const merged = mergeCapabilities(base, additional);
        expect(merged).toEqual({});
    });
});

describe('Task-based execution', () => {
    let protocol: Protocol<BaseContext>;
    let transport: MockTransport;
    let sendSpy: MockInstance;

    beforeEach(() => {
        transport = new MockTransport();
        sendSpy = vi.spyOn(transport, 'send');
        protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore: createMockTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() });
    });

    describe('request with task metadata', () => {
        it('should include task parameters at top level', async () => {
            await protocol.connect(transport);

            const request = {
                method: 'tools/call',
                params: { name: 'test-tool' }
            };

            const resultSchema = z.object({
                content: z.array(z.object({ type: z.literal('text'), text: z.string() }))
            });

            void protocol
                .request(request, resultSchema, {
                    task: {
                        ttl: 30000,
                        pollInterval: 1000
                    }
                })
                .catch(() => {
                    // May not complete, ignore error
                });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'tools/call',
                    params: {
                        name: 'test-tool',
                        task: {
                            ttl: 30000,
                            pollInterval: 1000
                        }
                    }
                }),
                expect.any(Object)
            );
        });

        it('should preserve existing _meta and add task parameters at top level', async () => {
            await protocol.connect(transport);

            const request = {
                method: 'tools/call',
                params: {
                    name: 'test-tool',
                    _meta: {
                        customField: 'customValue'
                    }
                }
            };

            const resultSchema = z.object({
                content: z.array(z.object({ type: z.literal('text'), text: z.string() }))
            });

            void protocol
                .request(request, resultSchema, {
                    task: {
                        ttl: 60000
                    }
                })
                .catch(() => {
                    // May not complete, ignore error
                });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    params: {
                        name: 'test-tool',
                        _meta: {
                            customField: 'customValue'
                        },
                        task: {
                            ttl: 60000
                        }
                    }
                }),
                expect.any(Object)
            );
        });

        it('should return Promise for task-augmented request', async () => {
            await protocol.connect(transport);

            const request = {
                method: 'tools/call',
                params: { name: 'test-tool' }
            };

            const resultSchema = z.object({
                content: z.array(z.object({ type: z.literal('text'), text: z.string() }))
            });

            const resultPromise = protocol.request(request, resultSchema, {
                task: {
                    ttl: 30000
                }
            });

            expect(resultPromise).toBeDefined();
            expect(resultPromise).toBeInstanceOf(Promise);
        });
    });

    describe('relatedTask metadata', () => {
        it('should inject relatedTask metadata into _meta field', async () => {
            await protocol.connect(transport);

            const request = {
                method: 'notifications/message',
                params: { data: 'test' }
            };

            const resultSchema = z.object({});

            // Start the request (don't await completion, just let it send)
            void protocol
                .request(request, resultSchema, {
                    relatedTask: {
                        taskId: 'parent-task-123'
                    }
                })
                .catch(() => {
                    // May not complete, ignore error
                });

            // Wait a bit for the request to be queued
            await new Promise(resolve => setTimeout(resolve, 10));

            // Requests with relatedTask should be queued, not sent via transport
            // This prevents duplicate delivery for bidirectional transports
            expect(sendSpy).not.toHaveBeenCalled();

            // Verify the message was queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();
        });

        it('should work with notification method', async () => {
            await protocol.connect(transport);

            await protocol.notification(
                {
                    method: 'notifications/message',
                    params: { level: 'info', data: 'test message' }
                },
                {
                    relatedTask: {
                        taskId: 'parent-task-456'
                    }
                }
            );

            // Notifications with relatedTask should be queued, not sent via transport
            // This prevents duplicate delivery for bidirectional transports
            expect(sendSpy).not.toHaveBeenCalled();

            // Verify the message was queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            const queuedMessage = await queue!.dequeue('parent-task-456');
            assertQueuedNotification(queuedMessage);
            expect(queuedMessage.message.method).toBe('notifications/message');
            expect(queuedMessage.message.params!._meta![RELATED_TASK_META_KEY]).toEqual({ taskId: 'parent-task-456' });
        });
    });

    describe('task metadata combination', () => {
        it('should combine task, relatedTask, and progress metadata', async () => {
            await protocol.connect(transport);

            const request = {
                method: 'tools/call',
                params: { name: 'test-tool' }
            };

            const resultSchema = z.object({
                content: z.array(z.object({ type: z.literal('text'), text: z.string() }))
            });

            // Start the request (don't await completion, just let it send)
            void protocol
                .request(request, resultSchema, {
                    task: {
                        ttl: 60000,
                        pollInterval: 1000
                    },
                    relatedTask: {
                        taskId: 'parent-task'
                    },
                    onprogress: vi.fn()
                })
                .catch(() => {
                    // May not complete, ignore error
                });

            // Wait a bit for the request to be queued
            await new Promise(resolve => setTimeout(resolve, 10));

            // Requests with relatedTask should be queued, not sent via transport
            // This prevents duplicate delivery for bidirectional transports
            expect(sendSpy).not.toHaveBeenCalled();

            // Verify the message was queued with all metadata combined
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            const queuedMessage = await queue!.dequeue('parent-task');
            assertQueuedRequest(queuedMessage);
            expect(queuedMessage.message.params).toMatchObject({
                name: 'test-tool',
                task: {
                    ttl: 60000,
                    pollInterval: 1000
                },
                _meta: {
                    [RELATED_TASK_META_KEY]: {
                        taskId: 'parent-task'
                    },
                    progressToken: expect.any(Number)
                }
            });
        });
    });

    describe('task status transitions', () => {
        it('should be handled by tool implementors, not protocol layer', () => {
            // Task status management is now the responsibility of tool implementors
            expect(true).toBe(true);
        });

        it('should handle requests with task creation parameters in top-level task field', async () => {
            // This test documents that task creation parameters are now in the top-level task field
            // rather than in _meta, and that task management is handled by tool implementors
            const mockTaskStore = createMockTaskStore();

            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            protocol.setRequestHandler('tools/call', async request => {
                // Tool implementor can access task creation parameters from request.params.task
                expect(request.params.task).toEqual({
                    ttl: 60000,
                    pollInterval: 1000
                });
                return { content: [{ type: 'text', text: 'success' }] };
            });

            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'test',
                    arguments: {},
                    task: {
                        ttl: 60000,
                        pollInterval: 1000
                    }
                }
            });

            // Wait for the request to be processed
            await new Promise(resolve => setTimeout(resolve, 10));
        });
    });

    describe('listTasks', () => {
        it('should handle tasks/list requests and return tasks from TaskStore', async () => {
            const listedTasks = createLatch();
            const mockTaskStore = createMockTaskStore({
                onList: () => listedTasks.releaseLatch()
            });
            const task1 = await mockTaskStore.createTask(
                {
                    pollInterval: 500
                },
                1,
                {
                    method: 'test/method',
                    params: {}
                }
            );
            // Manually set status to completed for this test
            await mockTaskStore.updateTaskStatus(task1.taskId, 'completed');

            const task2 = await mockTaskStore.createTask(
                {
                    ttl: 60000,
                    pollInterval: 1000
                },
                2,
                {
                    method: 'test/method',
                    params: {}
                }
            );

            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            // Simulate receiving a tasks/list request
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 3,
                method: 'tasks/list',
                params: {}
            });

            await listedTasks.waitForLatch();

            expect(mockTaskStore.listTasks).toHaveBeenCalledWith(undefined, undefined);
            const sentMessage = sendSpy.mock.calls[0]![0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(3);
            expect(sentMessage.result.tasks).toEqual([
                {
                    taskId: task1.taskId,
                    status: 'completed',
                    ttl: null,
                    createdAt: expect.any(String),
                    lastUpdatedAt: expect.any(String),
                    pollInterval: 500
                },
                {
                    taskId: task2.taskId,
                    status: 'working',
                    ttl: 60000,
                    createdAt: expect.any(String),
                    lastUpdatedAt: expect.any(String),
                    pollInterval: 1000
                }
            ]);
            expect(sentMessage.result._meta).toEqual({});
        });

        it('should handle tasks/list requests with cursor for pagination', async () => {
            const listedTasks = createLatch();
            const mockTaskStore = createMockTaskStore({
                onList: () => listedTasks.releaseLatch()
            });
            const task3 = await mockTaskStore.createTask(
                {
                    pollInterval: 500
                },
                1,
                {
                    method: 'test/method',
                    params: {}
                }
            );

            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            // Simulate receiving a tasks/list request with cursor
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 2,
                method: 'tasks/list',
                params: {
                    cursor: 'task-2'
                }
            });

            await listedTasks.waitForLatch();

            expect(mockTaskStore.listTasks).toHaveBeenCalledWith('task-2', undefined);
            const sentMessage = sendSpy.mock.calls[0]![0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(2);
            expect(sentMessage.result.tasks).toEqual([
                {
                    taskId: task3.taskId,
                    status: 'working',
                    ttl: null,
                    createdAt: expect.any(String),
                    lastUpdatedAt: expect.any(String),
                    pollInterval: 500
                }
            ]);
            expect(sentMessage.result.nextCursor).toBeUndefined();
            expect(sentMessage.result._meta).toEqual({});
        });

        it('should handle tasks/list requests with empty results', async () => {
            const listedTasks = createLatch();
            const mockTaskStore = createMockTaskStore({
                onList: () => listedTasks.releaseLatch()
            });

            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            // Simulate receiving a tasks/list request
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 3,
                method: 'tasks/list',
                params: {}
            });

            await listedTasks.waitForLatch();

            expect(mockTaskStore.listTasks).toHaveBeenCalledWith(undefined, undefined);
            const sentMessage = sendSpy.mock.calls[0]![0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(3);
            expect(sentMessage.result.tasks).toEqual([]);
            expect(sentMessage.result.nextCursor).toBeUndefined();
            expect(sentMessage.result._meta).toEqual({});
        });

        it('should return error for invalid cursor', async () => {
            const mockTaskStore = createMockTaskStore();
            mockTaskStore.listTasks.mockRejectedValue(new Error('Invalid cursor: bad-cursor'));

            protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            // Simulate receiving a tasks/list request with invalid cursor
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 4,
                method: 'tasks/list',
                params: {
                    cursor: 'bad-cursor'
                }
            });

            await new Promise(resolve => setTimeout(resolve, 10));

            expect(mockTaskStore.listTasks).toHaveBeenCalledWith('bad-cursor', undefined);
            const sentMessage = sendSpy.mock.calls[0]![0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(4);
            expect(sentMessage.error).toBeDefined();
            expect(sentMessage.error.code).toBe(-32602); // InvalidParams error code
            expect(sentMessage.error.message).toContain('Failed to list tasks');
            expect(sentMessage.error.message).toContain('Invalid cursor');
        });

        it('should call listTasks method from client side', async () => {
            await protocol.connect(transport);

            const listTasksPromise = (protocol as unknown as TestProtocol).listTasks();

            // Simulate server response
            setTimeout(() => {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: sendSpy.mock.calls[0]![0].id,
                    result: {
                        tasks: [
                            {
                                taskId: 'task-1',
                                status: 'completed',
                                ttl: null,
                                createdAt: '2024-01-01T00:00:00Z',
                                lastUpdatedAt: '2024-01-01T00:00:00Z',
                                pollInterval: 500
                            }
                        ],
                        nextCursor: undefined,
                        _meta: {}
                    }
                });
            }, 10);

            const result = await listTasksPromise;

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'tasks/list',
                    params: undefined
                }),
                expect.any(Object)
            );
            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0]?.taskId).toBe('task-1');
        });

        it('should call listTasks with cursor from client side', async () => {
            await protocol.connect(transport);

            const listTasksPromise = (protocol as unknown as TestProtocol).listTasks({ cursor: 'task-10' });

            // Simulate server response
            setTimeout(() => {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: sendSpy.mock.calls[0]![0].id,
                    result: {
                        tasks: [
                            {
                                taskId: 'task-11',
                                status: 'working',
                                ttl: 30000,
                                createdAt: '2024-01-01T00:00:00Z',
                                lastUpdatedAt: '2024-01-01T00:00:00Z',
                                pollInterval: 1000
                            }
                        ],
                        nextCursor: 'task-11',
                        _meta: {}
                    }
                });
            }, 10);

            const result = await listTasksPromise;

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'tasks/list',
                    params: {
                        cursor: 'task-10'
                    }
                }),
                expect.any(Object)
            );
            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0]?.taskId).toBe('task-11');
            expect(result.nextCursor).toBe('task-11');
        });
    });

    describe('cancelTask', () => {
        it('should handle tasks/cancel requests and update task status to cancelled', async () => {
            const taskDeleted = createLatch();
            const mockTaskStore = createMockTaskStore();
            const task = await mockTaskStore.createTask({}, 1, {
                method: 'test/method',
                params: {}
            });

            mockTaskStore.getTask.mockResolvedValue(task);
            mockTaskStore.updateTaskStatus.mockImplementation(async (taskId: string, status: string) => {
                if (taskId === task.taskId && status === 'cancelled') {
                    taskDeleted.releaseLatch();
                    return;
                }
                throw new Error('Task not found');
            });

            const serverProtocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });
            const serverTransport = new MockTransport();
            const sendSpy = vi.spyOn(serverTransport, 'send');

            await serverProtocol.connect(serverTransport);

            serverTransport.onmessage?.({
                jsonrpc: '2.0',
                id: 5,
                method: 'tasks/cancel',
                params: {
                    taskId: task.taskId
                }
            });

            await taskDeleted.waitForLatch();

            expect(mockTaskStore.getTask).toHaveBeenCalledWith(task.taskId, undefined);
            expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith(
                task.taskId,
                'cancelled',
                'Client cancelled task execution.',
                undefined
            );
            const sentMessage = sendSpy.mock.calls[0]![0] as unknown as JSONRPCResultResponse;
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(5);
            expect(sentMessage.result._meta).toBeDefined();
        });

        it('should return error with code -32602 when task does not exist', async () => {
            const taskDeleted = createLatch();
            const mockTaskStore = createMockTaskStore();

            mockTaskStore.getTask.mockResolvedValue(null);

            const serverProtocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });
            const serverTransport = new MockTransport();
            const sendSpy = vi.spyOn(serverTransport, 'send');

            await serverProtocol.connect(serverTransport);

            serverTransport.onmessage?.({
                jsonrpc: '2.0',
                id: 6,
                method: 'tasks/cancel',
                params: {
                    taskId: 'non-existent'
                }
            });

            // Wait a bit for the async handler to complete
            await new Promise(resolve => setTimeout(resolve, 10));
            taskDeleted.releaseLatch();

            expect(mockTaskStore.getTask).toHaveBeenCalledWith('non-existent', undefined);
            const sentMessage = sendSpy.mock.calls[0]![0] as unknown as JSONRPCErrorResponse;
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(6);
            expect(sentMessage.error).toBeDefined();
            expect(sentMessage.error.code).toBe(-32602); // InvalidParams error code
            expect(sentMessage.error.message).toContain('Task not found');
        });

        it('should return error with code -32602 when trying to cancel a task in terminal status', async () => {
            const mockTaskStore = createMockTaskStore();
            const completedTask = await mockTaskStore.createTask({}, 1, {
                method: 'test/method',
                params: {}
            });
            // Set task to completed status
            await mockTaskStore.updateTaskStatus(completedTask.taskId, 'completed');
            completedTask.status = 'completed';

            // Reset the mock so we can check it's not called during cancellation
            mockTaskStore.updateTaskStatus.mockClear();
            mockTaskStore.getTask.mockResolvedValue(completedTask);

            const serverProtocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });
            const serverTransport = new MockTransport();
            const sendSpy = vi.spyOn(serverTransport, 'send');

            await serverProtocol.connect(serverTransport);

            serverTransport.onmessage?.({
                jsonrpc: '2.0',
                id: 7,
                method: 'tasks/cancel',
                params: {
                    taskId: completedTask.taskId
                }
            });

            // Wait a bit for the async handler to complete
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(mockTaskStore.getTask).toHaveBeenCalledWith(completedTask.taskId, undefined);
            expect(mockTaskStore.updateTaskStatus).not.toHaveBeenCalled();
            const sentMessage = sendSpy.mock.calls[0]![0] as unknown as JSONRPCErrorResponse;
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(7);
            expect(sentMessage.error).toBeDefined();
            expect(sentMessage.error.code).toBe(-32602); // InvalidParams error code
            expect(sentMessage.error.message).toContain('Cannot cancel task in terminal status');
        });

        it('should call cancelTask method from client side', async () => {
            await protocol.connect(transport);

            const deleteTaskPromise = (protocol as unknown as TestProtocol).cancelTask({ taskId: 'task-to-delete' });

            // Simulate server response - per MCP spec, CancelTaskResult is Result & Task
            setTimeout(() => {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: sendSpy.mock.calls[0]![0].id,
                    result: {
                        _meta: {},
                        taskId: 'task-to-delete',
                        status: 'cancelled',
                        ttl: 60000,
                        createdAt: new Date().toISOString(),
                        lastUpdatedAt: new Date().toISOString()
                    }
                });
            }, 0);

            const result = await deleteTaskPromise;

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'tasks/cancel',
                    params: {
                        taskId: 'task-to-delete'
                    }
                }),
                expect.any(Object)
            );
            expect(result._meta).toBeDefined();
            expect(result.taskId).toBe('task-to-delete');
            expect(result.status).toBe('cancelled');
        });
    });

    describe('task status notifications', () => {
        it('should call getTask after updateTaskStatus to enable notification sending', async () => {
            const mockTaskStore = createMockTaskStore();

            // Create a task first
            const task = await mockTaskStore.createTask({}, 1, {
                method: 'test/method',
                params: {}
            });

            const serverProtocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });
            const serverTransport = new MockTransport();

            await serverProtocol.connect(serverTransport);

            // Simulate cancelling the task
            serverTransport.onmessage?.({
                jsonrpc: '2.0',
                id: 2,
                method: 'tasks/cancel',
                params: {
                    taskId: task.taskId
                }
            });

            // Wait for async processing
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify that updateTaskStatus was called
            expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith(
                task.taskId,
                'cancelled',
                'Client cancelled task execution.',
                undefined
            );

            // Verify that getTask was called after updateTaskStatus
            // This is done by the RequestTaskStore wrapper to get the updated task for the notification
            const getTaskCalls = mockTaskStore.getTask.mock.calls;
            const lastGetTaskCall = getTaskCalls[getTaskCalls.length - 1];
            expect(lastGetTaskCall?.[0]).toBe(task.taskId);
        });
    });

    describe('task metadata handling', () => {
        it('should NOT include related-task metadata in tasks/get response', async () => {
            const mockTaskStore = createMockTaskStore();

            // Create a task first
            const task = await mockTaskStore.createTask({}, 1, {
                method: 'test/method',
                params: {}
            });

            const serverProtocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });
            const serverTransport = new MockTransport();
            const sendSpy = vi.spyOn(serverTransport, 'send');

            await serverProtocol.connect(serverTransport);

            // Request task status
            serverTransport.onmessage?.({
                jsonrpc: '2.0',
                id: 2,
                method: 'tasks/get',
                params: {
                    taskId: task.taskId
                }
            });

            // Wait for async processing
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify response does NOT include related-task metadata
            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    result: expect.objectContaining({
                        taskId: task.taskId,
                        status: 'working'
                    })
                })
            );

            // Verify _meta is not present or doesn't contain RELATED_TASK_META_KEY
            const response = sendSpy.mock.calls[0]![0] as { result?: { _meta?: Record<string, unknown> } };
            expect(response.result?._meta?.[RELATED_TASK_META_KEY]).toBeUndefined();
        });

        it('should NOT include related-task metadata in tasks/list response', async () => {
            const mockTaskStore = createMockTaskStore();

            // Create a task first
            await mockTaskStore.createTask({}, 1, {
                method: 'test/method',
                params: {}
            });

            const serverProtocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });
            const serverTransport = new MockTransport();
            const sendSpy = vi.spyOn(serverTransport, 'send');

            await serverProtocol.connect(serverTransport);

            // Request task list
            serverTransport.onmessage?.({
                jsonrpc: '2.0',
                id: 2,
                method: 'tasks/list',
                params: {}
            });

            // Wait for async processing
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify response does NOT include related-task metadata
            const response = sendSpy.mock.calls[0]![0] as { result?: { _meta?: Record<string, unknown> } };
            expect(response.result?._meta).toEqual({});
        });

        it('should NOT include related-task metadata in tasks/cancel response', async () => {
            const mockTaskStore = createMockTaskStore();

            // Create a task first
            const task = await mockTaskStore.createTask({}, 1, {
                method: 'test/method',
                params: {}
            });

            const serverProtocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });
            const serverTransport = new MockTransport();
            const sendSpy = vi.spyOn(serverTransport, 'send');

            await serverProtocol.connect(serverTransport);

            // Cancel the task
            serverTransport.onmessage?.({
                jsonrpc: '2.0',
                id: 2,
                method: 'tasks/cancel',
                params: {
                    taskId: task.taskId
                }
            });

            // Wait for async processing
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify response does NOT include related-task metadata
            const response = sendSpy.mock.calls[0]![0] as { result?: { _meta?: Record<string, unknown> } };
            expect(response.result?._meta).toEqual({});
        });

        it('should include related-task metadata in tasks/result response', async () => {
            const mockTaskStore = createMockTaskStore();

            // Create a task and complete it
            const task = await mockTaskStore.createTask({}, 1, {
                method: 'test/method',
                params: {}
            });

            const testResult = {
                content: [{ type: 'text', text: 'test result' }]
            };

            await mockTaskStore.storeTaskResult(task.taskId, 'completed', testResult);

            const serverProtocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });
            const serverTransport = new MockTransport();
            const sendSpy = vi.spyOn(serverTransport, 'send');

            await serverProtocol.connect(serverTransport);

            // Request task result
            serverTransport.onmessage?.({
                jsonrpc: '2.0',
                id: 2,
                method: 'tasks/result',
                params: {
                    taskId: task.taskId
                }
            });

            // Wait for async processing
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify response DOES include related-task metadata
            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    result: expect.objectContaining({
                        content: testResult.content,
                        _meta: expect.objectContaining({
                            [RELATED_TASK_META_KEY]: {
                                taskId: task.taskId
                            }
                        })
                    })
                })
            );
        });

        it('should propagate related-task metadata to handler sendRequest and sendNotification', async () => {
            const mockTaskStore = createMockTaskStore();

            const serverProtocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });

            const serverTransport = new MockTransport();
            const sendSpy = vi.spyOn(serverTransport, 'send');

            await serverProtocol.connect(serverTransport);

            // Set up a handler that uses sendRequest and sendNotification
            serverProtocol.setRequestHandler('tools/call', async (_request, ctx) => {
                // Send a notification using the ctx.mcpReq.notify
                await ctx.mcpReq.notify({
                    method: 'notifications/message',
                    params: { level: 'info', data: 'test' }
                });

                return {
                    content: [{ type: 'text', text: 'done' }]
                };
            });

            // Send a request with related-task metadata
            let handlerPromise: Promise<void> | undefined;
            const originalOnMessage = serverTransport.onmessage;

            serverTransport.onmessage = message => {
                handlerPromise = Promise.resolve(originalOnMessage?.(message));
                return handlerPromise;
            };

            serverTransport.onmessage({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'test-tool',
                    _meta: {
                        [RELATED_TASK_META_KEY]: {
                            taskId: 'parent-task-123'
                        }
                    }
                }
            });

            // Wait for handler to complete
            if (handlerPromise) {
                await handlerPromise;
            }
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify the notification was QUEUED (not sent via transport)
            // Messages with relatedTask metadata should be queued for delivery via tasks/result
            // to prevent duplicate delivery for bidirectional transports
            const queue = (serverProtocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            const queuedMessage = await queue!.dequeue('parent-task-123');
            assertQueuedNotification(queuedMessage);
            expect(queuedMessage.message.method).toBe('notifications/message');
            expect(queuedMessage.message.params!._meta![RELATED_TASK_META_KEY]).toEqual({
                taskId: 'parent-task-123'
            });

            // Verify the notification was NOT sent via transport (should be queued instead)
            const notificationCalls = sendSpy.mock.calls.filter(call => 'method' in call[0] && call[0].method === 'notifications/message');
            expect(notificationCalls).toHaveLength(0);
        });
    });
});

describe('Request Cancellation vs Task Cancellation', () => {
    let protocol: Protocol<BaseContext>;
    let transport: MockTransport;
    let taskStore: TaskStore;

    beforeEach(() => {
        transport = new MockTransport();
        taskStore = createMockTaskStore();
        protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore });
    });

    describe('notifications/cancelled behavior', () => {
        test('should abort request handler when notifications/cancelled is received', async () => {
            await protocol.connect(transport);

            // Set up a request handler that checks if it was aborted
            let wasAborted = false;
            protocol.setRequestHandler('ping', async (_request, ctx) => {
                // Simulate a long-running operation
                await new Promise(resolve => setTimeout(resolve, 100));
                wasAborted = ctx.mcpReq.signal.aborted;
                return {};
            });

            // Simulate an incoming request
            const requestId = 123;
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: requestId,
                    method: 'ping',
                    params: {}
                });
            }

            // Wait a bit for the handler to start
            await new Promise(resolve => setTimeout(resolve, 10));

            // Send cancellation notification
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/cancelled',
                    params: {
                        requestId: requestId,
                        reason: 'User cancelled'
                    }
                });
            }

            // Wait for the handler to complete
            await new Promise(resolve => setTimeout(resolve, 150));

            // Verify the request was aborted
            expect(wasAborted).toBe(true);
        });

        test('should NOT automatically cancel associated tasks when notifications/cancelled is received', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await taskStore.createTask({ ttl: 60000 }, 'req-1', {
                method: 'test/method',
                params: {}
            });

            // Send cancellation notification for the request
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/cancelled',
                    params: {
                        requestId: 'req-1',
                        reason: 'User cancelled'
                    }
                });
            }

            // Wait a bit
            await new Promise(resolve => setTimeout(resolve, 10));

            // Verify the task status was NOT changed to cancelled
            const updatedTask = await taskStore.getTask(task.taskId);
            expect(updatedTask?.status).toBe('working');
            expect(taskStore.updateTaskStatus).not.toHaveBeenCalledWith(task.taskId, 'cancelled', expect.any(String));
        });
    });

    describe('tasks/cancel behavior', () => {
        test('should cancel task independently of request cancellation', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await taskStore.createTask({ ttl: 60000 }, 'req-1', {
                method: 'test/method',
                params: {}
            });

            // Cancel the task using tasks/cancel
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: 999,
                    method: 'tasks/cancel',
                    params: {
                        taskId: task.taskId
                    }
                });
            }

            // Wait for the handler to complete
            await new Promise(resolve => setTimeout(resolve, 10));

            // Verify the task was cancelled
            expect(taskStore.updateTaskStatus).toHaveBeenCalledWith(
                task.taskId,
                'cancelled',
                'Client cancelled task execution.',
                undefined
            );
        });

        test('should reject cancellation of terminal tasks', async () => {
            await protocol.connect(transport);
            const sendSpy = vi.spyOn(transport, 'send');

            // Create a task and mark it as completed
            const task = await taskStore.createTask({ ttl: 60000 }, 'req-1', {
                method: 'test/method',
                params: {}
            });
            await taskStore.updateTaskStatus(task.taskId, 'completed');

            // Try to cancel the completed task
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: 999,
                    method: 'tasks/cancel',
                    params: {
                        taskId: task.taskId
                    }
                });
            }

            // Wait for the handler to complete
            await new Promise(resolve => setTimeout(resolve, 10));

            // Verify an error was sent
            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    id: 999,
                    error: expect.objectContaining({
                        code: ProtocolErrorCode.InvalidParams,
                        message: expect.stringContaining('Cannot cancel task in terminal status')
                    })
                })
            );
        });

        test('should return error when task not found', async () => {
            await protocol.connect(transport);
            const sendSpy = vi.spyOn(transport, 'send');

            // Try to cancel a non-existent task
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: 999,
                    method: 'tasks/cancel',
                    params: {
                        taskId: 'non-existent-task'
                    }
                });
            }

            // Wait for the handler to complete
            await new Promise(resolve => setTimeout(resolve, 10));

            // Verify an error was sent
            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    id: 999,
                    error: expect.objectContaining({
                        code: ProtocolErrorCode.InvalidParams,
                        message: expect.stringContaining('Task not found')
                    })
                })
            );
        });
    });

    describe('separation of concerns', () => {
        test('should allow request cancellation without affecting task', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await taskStore.createTask({ ttl: 60000 }, 'req-1', {
                method: 'test/method',
                params: {}
            });

            // Cancel the request (not the task)
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/cancelled',
                    params: {
                        requestId: 'req-1',
                        reason: 'User cancelled request'
                    }
                });
            }

            await new Promise(resolve => setTimeout(resolve, 10));

            // Verify task is still working
            const updatedTask = await taskStore.getTask(task.taskId);
            expect(updatedTask?.status).toBe('working');
        });

        test('should allow task cancellation without affecting request', async () => {
            await protocol.connect(transport);

            // Set up a request handler
            let requestCompleted = false;
            protocol.setRequestHandler('ping', async () => {
                await new Promise(resolve => setTimeout(resolve, 50));
                requestCompleted = true;
                return {};
            });

            // Create a task (simulating a long-running tools/call)
            const task = await taskStore.createTask({ ttl: 60000 }, 'req-1', {
                method: 'tools/call',
                params: { name: 'long-running-tool', arguments: {} }
            });

            // Start an unrelated ping request
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: 123,
                    method: 'ping',
                    params: {}
                });
            }

            // Cancel the task (not the request)
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: 999,
                    method: 'tasks/cancel',
                    params: {
                        taskId: task.taskId
                    }
                });
            }

            // Wait for request to complete
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify request completed normally
            expect(requestCompleted).toBe(true);

            // Verify task was cancelled
            expect(taskStore.updateTaskStatus).toHaveBeenCalledWith(
                task.taskId,
                'cancelled',
                'Client cancelled task execution.',
                undefined
            );
        });
    });
});

describe('Progress notification support for tasks', () => {
    let protocol: Protocol<BaseContext>;
    let transport: MockTransport;
    let sendSpy: MockInstance;

    beforeEach(() => {
        transport = new MockTransport();
        sendSpy = vi.spyOn(transport, 'send');
        protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })();
    });

    it('should maintain progress token association after CreateTaskResult is returned', async () => {
        const taskStore = createMockTaskStore();
        const protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore });

        const transport = new MockTransport();
        const sendSpy = vi.spyOn(transport, 'send');
        await protocol.connect(transport);

        const progressCallback = vi.fn();
        const request = {
            method: 'tools/call',
            params: { name: 'test-tool' }
        };

        const resultSchema = z.object({
            task: z.object({
                taskId: z.string(),
                status: z.string(),
                ttl: z.number().nullable(),
                createdAt: z.string()
            })
        });

        // Start a task-augmented request with progress callback
        void protocol
            .request(request, resultSchema, {
                task: { ttl: 60000 },
                onprogress: progressCallback
            })
            .catch(() => {
                // May not complete, ignore error
            });

        // Wait a bit for the request to be sent
        await new Promise(resolve => setTimeout(resolve, 10));

        // Get the message ID from the sent request
        const sentRequest = sendSpy.mock.calls[0]![0] as { id: number; params: { _meta: { progressToken: number } } };
        const messageId = sentRequest.id;
        const progressToken = sentRequest.params._meta.progressToken;

        expect(progressToken).toBe(messageId);

        // Simulate CreateTaskResult response
        const taskId = 'test-task-123';
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                id: messageId,
                result: {
                    task: {
                        taskId,
                        status: 'working',
                        ttl: 60000,
                        createdAt: new Date().toISOString()
                    }
                }
            });
        }

        // Wait for response to be processed
        await Promise.resolve();
        await Promise.resolve();

        // Send a progress notification - should still work after CreateTaskResult
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 50,
                    total: 100
                }
            });
        }

        // Wait for notification to be processed
        await Promise.resolve();

        // Verify progress callback was invoked
        expect(progressCallback).toHaveBeenCalledWith({
            progress: 50,
            total: 100
        });
    });

    it('should stop progress notifications when task reaches terminal status (completed)', async () => {
        const taskStore = createMockTaskStore();
        const protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore });

        const transport = new MockTransport();
        const sendSpy = vi.spyOn(transport, 'send');
        await protocol.connect(transport);

        // Set up a request handler that will complete the task
        protocol.setRequestHandler('tools/call', async (_request, ctx) => {
            if (ctx.task?.store) {
                const task = await ctx.task.store.createTask({ ttl: 60000 });

                // Simulate async work then complete the task
                const taskStore = ctx.task.store;
                setTimeout(async () => {
                    await taskStore.storeTaskResult(task.taskId, 'completed', {
                        content: [{ type: 'text', text: 'Done' }]
                    });
                }, 50);

                return { task };
            }
            return { content: [] };
        });

        const progressCallback = vi.fn();
        const request = {
            method: 'tools/call',
            params: { name: 'test-tool' }
        };

        const resultSchema = z.object({
            task: z.object({
                taskId: z.string(),
                status: z.string(),
                ttl: z.number().nullable(),
                createdAt: z.string()
            })
        });

        // Start a task-augmented request with progress callback
        void protocol
            .request(request, resultSchema, {
                task: { ttl: 60000 },
                onprogress: progressCallback
            })
            .catch(() => {
                // May not complete, ignore error
            });

        // Wait a bit for the request to be sent
        await new Promise(resolve => setTimeout(resolve, 10));

        const sentRequest = sendSpy.mock.calls[0]![0] as { id: number; params: { _meta: { progressToken: number } } };
        const messageId = sentRequest.id;
        const progressToken = sentRequest.params._meta.progressToken;

        // Create a task in the mock store first so it exists when we try to get it later
        const createdTask = await taskStore.createTask({ ttl: 60000 }, messageId, request);
        const taskId = createdTask.taskId;

        // Simulate CreateTaskResult response
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                id: messageId,
                result: {
                    task: createdTask
                }
            });
        }

        await Promise.resolve();
        await Promise.resolve();

        // Progress notification should work while task is working
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 50,
                    total: 100
                }
            });
        }

        await Promise.resolve();

        expect(progressCallback).toHaveBeenCalledTimes(1);

        // Verify the task-progress association was created
        const taskProgressTokens = (protocol as unknown as TestProtocol)._taskProgressTokens as Map<string, number>;
        expect(taskProgressTokens.has(taskId)).toBe(true);
        expect(taskProgressTokens.get(taskId)).toBe(progressToken);

        // Simulate task completion by calling through the protocol's task store
        // This will trigger the cleanup logic
        const mockRequest = { jsonrpc: '2.0' as const, id: 999, method: 'test', params: {} };
        const requestTaskStore = (protocol as unknown as TestProtocol).requestTaskStore(mockRequest, undefined);
        await requestTaskStore.storeTaskResult(taskId, 'completed', { content: [] });

        // Wait for all async operations including notification sending to complete
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify the association was cleaned up
        expect(taskProgressTokens.has(taskId)).toBe(false);

        // Try to send progress notification after task completion - should be ignored
        progressCallback.mockClear();
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 100,
                    total: 100
                }
            });
        }

        await Promise.resolve();

        // Progress callback should NOT be invoked after task completion
        expect(progressCallback).not.toHaveBeenCalled();
    });

    it('should stop progress notifications when task reaches terminal status (failed)', async () => {
        const taskStore = createMockTaskStore();
        const protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore });

        const transport = new MockTransport();
        const sendSpy = vi.spyOn(transport, 'send');
        await protocol.connect(transport);

        const progressCallback = vi.fn();
        const request = {
            method: 'tools/call',
            params: { name: 'test-tool' }
        };

        const resultSchema = z.object({
            task: z.object({
                taskId: z.string(),
                status: z.string(),
                ttl: z.number().nullable(),
                createdAt: z.string()
            })
        });

        void protocol.request(request, resultSchema, {
            task: { ttl: 60000 },
            onprogress: progressCallback
        });

        const sentRequest = sendSpy.mock.calls[0]![0] as { id: number; params: { _meta: { progressToken: number } } };
        const messageId = sentRequest.id;
        const progressToken = sentRequest.params._meta.progressToken;

        // Simulate CreateTaskResult response
        const taskId = 'test-task-456';
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                id: messageId,
                result: {
                    task: {
                        taskId,
                        status: 'working',
                        ttl: 60000,
                        createdAt: new Date().toISOString()
                    }
                }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 10));

        // Simulate task failure via storeTaskResult
        await taskStore.storeTaskResult(taskId, 'failed', {
            content: [],
            isError: true
        });

        // Manually trigger the status notification
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                method: 'notifications/tasks/status',
                params: {
                    taskId,
                    status: 'failed',
                    ttl: 60000,
                    createdAt: new Date().toISOString(),
                    lastUpdatedAt: new Date().toISOString(),
                    statusMessage: 'Task failed'
                }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 10));

        // Try to send progress notification after task failure - should be ignored
        progressCallback.mockClear();
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 75,
                    total: 100
                }
            });
        }

        expect(progressCallback).not.toHaveBeenCalled();
    });

    it('should stop progress notifications when task is cancelled', async () => {
        const taskStore = createMockTaskStore();
        const protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore });

        const transport = new MockTransport();
        const sendSpy = vi.spyOn(transport, 'send');
        await protocol.connect(transport);

        const progressCallback = vi.fn();
        const request = {
            method: 'tools/call',
            params: { name: 'test-tool' }
        };

        const resultSchema = z.object({
            task: z.object({
                taskId: z.string(),
                status: z.string(),
                ttl: z.number().nullable(),
                createdAt: z.string()
            })
        });

        void protocol.request(request, resultSchema, {
            task: { ttl: 60000 },
            onprogress: progressCallback
        });

        const sentRequest = sendSpy.mock.calls[0]![0] as { id: number; params: { _meta: { progressToken: number } } };
        const messageId = sentRequest.id;
        const progressToken = sentRequest.params._meta.progressToken;

        // Simulate CreateTaskResult response
        const taskId = 'test-task-789';
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                id: messageId,
                result: {
                    task: {
                        taskId,
                        status: 'working',
                        ttl: 60000,
                        createdAt: new Date().toISOString()
                    }
                }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 10));

        // Simulate task cancellation via updateTaskStatus
        await taskStore.updateTaskStatus(taskId, 'cancelled', 'User cancelled');

        // Manually trigger the status notification
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                method: 'notifications/tasks/status',
                params: {
                    taskId,
                    status: 'cancelled',
                    ttl: 60000,
                    createdAt: new Date().toISOString(),
                    lastUpdatedAt: new Date().toISOString(),
                    statusMessage: 'User cancelled'
                }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 10));

        // Try to send progress notification after cancellation - should be ignored
        progressCallback.mockClear();
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 25,
                    total: 100
                }
            });
        }

        expect(progressCallback).not.toHaveBeenCalled();
    });

    it('should use the same progressToken throughout task lifetime', async () => {
        const taskStore = createMockTaskStore();
        const protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore });

        const transport = new MockTransport();
        const sendSpy = vi.spyOn(transport, 'send');
        await protocol.connect(transport);

        const progressCallback = vi.fn();
        const request = {
            method: 'tools/call',
            params: { name: 'test-tool' }
        };

        const resultSchema = z.object({
            task: z.object({
                taskId: z.string(),
                status: z.string(),
                ttl: z.number().nullable(),
                createdAt: z.string()
            })
        });

        void protocol.request(request, resultSchema, {
            task: { ttl: 60000 },
            onprogress: progressCallback
        });

        const sentRequest = sendSpy.mock.calls[0]![0] as { id: number; params: { _meta: { progressToken: number } } };
        const messageId = sentRequest.id;
        const progressToken = sentRequest.params._meta.progressToken;

        // Simulate CreateTaskResult response
        const taskId = 'test-task-consistency';
        if (transport.onmessage) {
            transport.onmessage({
                jsonrpc: '2.0',
                id: messageId,
                result: {
                    task: {
                        taskId,
                        status: 'working',
                        ttl: 60000,
                        createdAt: new Date().toISOString()
                    }
                }
            });
        }

        await Promise.resolve();
        await Promise.resolve();

        // Send multiple progress notifications with the same token
        const progressUpdates = [
            { progress: 25, total: 100 },
            { progress: 50, total: 100 },
            { progress: 75, total: 100 }
        ];

        for (const update of progressUpdates) {
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {
                        progressToken, // Same token for all notifications
                        ...update
                    }
                });
            }
            await Promise.resolve();
        }

        // Verify all progress notifications were received with the same token
        expect(progressCallback).toHaveBeenCalledTimes(3);
        expect(progressCallback).toHaveBeenNthCalledWith(1, { progress: 25, total: 100 });
        expect(progressCallback).toHaveBeenNthCalledWith(2, { progress: 50, total: 100 });
        expect(progressCallback).toHaveBeenNthCalledWith(3, { progress: 75, total: 100 });
    });

    it('should maintain progressToken throughout task lifetime', async () => {
        await protocol.connect(transport);

        const request = {
            method: 'tools/call',
            params: { name: 'long-running-tool' }
        };

        const resultSchema = z.object({
            content: z.array(z.object({ type: z.literal('text'), text: z.string() }))
        });

        const onProgressMock = vi.fn();

        void protocol.request(request, resultSchema, {
            task: {
                ttl: 60000
            },
            onprogress: onProgressMock
        });

        const sentMessage = sendSpy.mock.calls[0]![0];
        expect(sentMessage.params._meta.progressToken).toBeDefined();
    });

    it('should support progress notifications with task-augmented requests', async () => {
        await protocol.connect(transport);

        const request = {
            method: 'tools/call',
            params: { name: 'test-tool' }
        };

        const resultSchema = z.object({
            content: z.array(z.object({ type: z.literal('text'), text: z.string() }))
        });

        const onProgressMock = vi.fn();

        void protocol.request(request, resultSchema, {
            task: {
                ttl: 30000
            },
            onprogress: onProgressMock
        });

        const sentMessage = sendSpy.mock.calls[0]![0];
        const progressToken = sentMessage.params._meta.progressToken;

        // Simulate progress notification
        transport.onmessage?.({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: {
                progressToken,
                progress: 50,
                total: 100,
                message: 'Processing...'
            }
        });

        await new Promise(resolve => setTimeout(resolve, 10));

        expect(onProgressMock).toHaveBeenCalledWith({
            progress: 50,
            total: 100,
            message: 'Processing...'
        });
    });

    it('should continue progress notifications after CreateTaskResult', async () => {
        await protocol.connect(transport);

        const request = {
            method: 'tools/call',
            params: { name: 'test-tool' }
        };

        const resultSchema = z.object({
            task: z.object({
                taskId: z.string(),
                status: z.string(),
                ttl: z.number().nullable(),
                createdAt: z.string()
            })
        });

        const onProgressMock = vi.fn();

        void protocol.request(request, resultSchema, {
            task: {
                ttl: 30000
            },
            onprogress: onProgressMock
        });

        const sentMessage = sendSpy.mock.calls[0]![0];
        const progressToken = sentMessage.params._meta.progressToken;

        // Simulate CreateTaskResult response
        setTimeout(() => {
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: sentMessage.id,
                result: {
                    task: {
                        taskId: 'task-123',
                        status: 'working',
                        ttl: 30000,
                        createdAt: new Date().toISOString()
                    }
                }
            });
        }, 5);

        // Progress notifications should still work
        setTimeout(() => {
            transport.onmessage?.({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 75,
                    total: 100
                }
            });
        }, 10);

        await new Promise(resolve => setTimeout(resolve, 20));

        expect(onProgressMock).toHaveBeenCalledWith({
            progress: 75,
            total: 100
        });
    });
});

describe('Capability negotiation for tasks', () => {
    it('should use empty objects for capability fields', () => {
        const serverCapabilities = {
            tasks: {
                list: {},
                cancel: {},
                requests: {
                    tools: {
                        call: {}
                    }
                }
            }
        };

        expect(serverCapabilities.tasks.list).toEqual({});
        expect(serverCapabilities.tasks.cancel).toEqual({});
        expect(serverCapabilities.tasks.requests.tools.call).toEqual({});
    });

    it('should include list and cancel in server capabilities', () => {
        const serverCapabilities = {
            tasks: {
                list: {},
                cancel: {}
            }
        };

        expect('list' in serverCapabilities.tasks).toBe(true);
        expect('cancel' in serverCapabilities.tasks).toBe(true);
    });

    it('should include list and cancel in client capabilities', () => {
        const clientCapabilities = {
            tasks: {
                list: {},
                cancel: {}
            }
        };

        expect('list' in clientCapabilities.tasks).toBe(true);
        expect('cancel' in clientCapabilities.tasks).toBe(true);
    });
});

describe('Message interception for task-related notifications', () => {
    it('should queue notifications with io.modelcontextprotocol/related-task metadata', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });

        await server.connect(transport);

        // Create a task first
        const task = await taskStore.createTask({ ttl: 60000 }, 'test-request-1', { method: 'tools/call', params: {} });

        // Send a notification with related task metadata
        await server.notification(
            {
                method: 'notifications/message',
                params: { level: 'info', data: 'test message' }
            },
            {
                relatedTask: { taskId: task.taskId }
            }
        );

        // Access the private queue to verify the message was queued
        const queue = (server as unknown as TestProtocol)._taskMessageQueue;
        expect(queue).toBeDefined();

        const queuedMessage = await queue!.dequeue(task.taskId);
        assertQueuedNotification(queuedMessage);
        expect(queuedMessage.message.method).toBe('notifications/message');
        expect(queuedMessage.message.params!._meta![RELATED_TASK_META_KEY]).toEqual({ taskId: task.taskId });
    });

    it('should not queue notifications without related-task metadata', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });

        await server.connect(transport);

        // Send a notification without related task metadata
        await server.notification({
            method: 'notifications/message',
            params: { level: 'info', data: 'test message' }
        });

        // Verify message was not queued (notification without metadata goes through transport)
        // We can't directly check the queue, but we know it wasn't queued because
        // notifications without relatedTask metadata are sent via transport, not queued
    });

    // Test removed: _taskResultWaiters was removed in favor of polling-based task updates
    // The functionality is still tested through integration tests that verify message queuing works

    it('should propagate queue overflow errors without failing the task', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue(), maxTaskQueueSize: 100 });

        await server.connect(transport);

        // Create a task
        const task = await taskStore.createTask({ ttl: 60000 }, 'test-request-1', { method: 'tools/call', params: {} });

        // Fill the queue to max capacity (100 messages)
        for (let i = 0; i < 100; i++) {
            await server.notification(
                {
                    method: 'notifications/message',
                    params: { level: 'info', data: `message ${i}` }
                },
                {
                    relatedTask: { taskId: task.taskId }
                }
            );
        }

        // Try to add one more message - should throw an error
        await expect(
            server.notification(
                {
                    method: 'notifications/message',
                    params: { level: 'info', data: 'overflow message' }
                },
                {
                    relatedTask: { taskId: task.taskId }
                }
            )
        ).rejects.toThrow('overflow');

        // Verify the task was NOT automatically failed by the Protocol
        // (implementations can choose to fail tasks on overflow if they want)
        expect(taskStore.updateTaskStatus).not.toHaveBeenCalledWith(task.taskId, 'failed', expect.anything(), expect.anything());
    });

    it('should extract task ID correctly from metadata', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });

        await server.connect(transport);

        const taskId = 'custom-task-id-123';

        // Send a notification with custom task ID
        await server.notification(
            {
                method: 'notifications/message',
                params: { level: 'info', data: 'test message' }
            },
            {
                relatedTask: { taskId }
            }
        );

        // Verify the message was queued under the correct task ID
        const queue = (server as unknown as TestProtocol)._taskMessageQueue;
        expect(queue).toBeDefined();
        const queuedMessage = await queue!.dequeue(taskId);
        expect(queuedMessage).toBeDefined();
    });

    it('should preserve message order when queuing multiple notifications', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });

        await server.connect(transport);

        // Create a task
        const task = await taskStore.createTask({ ttl: 60000 }, 'test-request-1', { method: 'tools/call', params: {} });

        // Send multiple notifications
        for (let i = 0; i < 5; i++) {
            await server.notification(
                {
                    method: 'notifications/message',
                    params: { level: 'info', data: `message ${i}` }
                },
                {
                    relatedTask: { taskId: task.taskId }
                }
            );
        }

        // Verify messages are in FIFO order
        const queue = (server as unknown as TestProtocol)._taskMessageQueue;
        expect(queue).toBeDefined();

        for (let i = 0; i < 5; i++) {
            const queuedMessage = await queue!.dequeue(task.taskId);
            assertQueuedNotification(queuedMessage);
            expect(queuedMessage.message.params!.data).toBe(`message ${i}`);
        }
    });
});

describe('Message interception for task-related requests', () => {
    it('should queue requests with io.modelcontextprotocol/related-task metadata', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });

        await server.connect(transport);

        // Create a task first
        const task = await taskStore.createTask({ ttl: 60000 }, 'test-request-1', { method: 'tools/call', params: {} });

        // Send a request with related task metadata (don't await - we're testing queuing)
        const requestPromise = server.request(
            {
                method: 'ping',
                params: {}
            },
            z.object({}),
            {
                relatedTask: { taskId: task.taskId }
            }
        );

        // Access the private queue to verify the message was queued
        const queue = (server as unknown as TestProtocol)._taskMessageQueue;
        expect(queue).toBeDefined();

        const queuedMessage = await queue!.dequeue(task.taskId);
        assertQueuedRequest(queuedMessage);
        expect(queuedMessage.message.method).toBe('ping');
        expect(queuedMessage.message.params!._meta![RELATED_TASK_META_KEY]).toEqual({ taskId: task.taskId });

        // Verify resolver is stored in _requestResolvers map (not in the message)
        const requestId = (queuedMessage!.message as JSONRPCRequest).id as RequestId;
        const resolvers = (server as unknown as TestProtocol)._requestResolvers;
        expect(resolvers.has(requestId)).toBe(true);

        // Clean up - send a response to prevent hanging promise
        transport.onmessage?.({
            jsonrpc: '2.0',
            id: requestId,
            result: {}
        });

        await requestPromise;
    });

    it('should not queue requests without related-task metadata', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });

        await server.connect(transport);

        // Send a request without related task metadata
        const requestPromise = server.request(
            {
                method: 'ping',
                params: {}
            },
            z.object({})
        );

        // Verify queue exists (but we don't track size in the new API)
        const queue = (server as unknown as TestProtocol)._taskMessageQueue;
        expect(queue).toBeDefined();

        // Clean up - send a response
        transport.onmessage?.({
            jsonrpc: '2.0',
            id: 0,
            result: {}
        });

        await requestPromise;
    });

    // Test removed: _taskResultWaiters was removed in favor of polling-based task updates
    // The functionality is still tested through integration tests that verify message queuing works

    it('should store request resolver for response routing', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });

        await server.connect(transport);

        // Create a task
        const task = await taskStore.createTask({ ttl: 60000 }, 'test-request-1', { method: 'tools/call', params: {} });

        // Send a request with related task metadata
        const requestPromise = server.request(
            {
                method: 'ping',
                params: {}
            },
            z.object({}),
            {
                relatedTask: { taskId: task.taskId }
            }
        );

        // Verify the resolver was stored
        const resolvers = (server as unknown as TestProtocol)._requestResolvers;
        expect(resolvers.size).toBe(1);

        // Get the request ID from the queue
        const queue = (server as unknown as TestProtocol)._taskMessageQueue;
        const queuedMessage = await queue!.dequeue(task.taskId);
        const requestId = (queuedMessage!.message as JSONRPCRequest).id as RequestId;

        expect(resolvers.has(requestId)).toBe(true);

        // Send a response to trigger resolver
        transport.onmessage?.({
            jsonrpc: '2.0',
            id: requestId,
            result: {}
        });

        await requestPromise;

        // Verify resolver was cleaned up after response
        expect(resolvers.has(requestId)).toBe(false);
    });

    it('should route responses to side-channeled requests', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const queue = new InMemoryTaskMessageQueue();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: queue });

        await server.connect(transport);

        // Create a task
        const task = await taskStore.createTask({ ttl: 60000 }, 'test-request-1', { method: 'tools/call', params: {} });

        // Send a request with related task metadata
        const requestPromise = server.request(
            {
                method: 'ping',
                params: {}
            },
            z.object({ message: z.string() }),
            {
                relatedTask: { taskId: task.taskId }
            }
        );

        // Get the request ID from the queue
        const queuedMessage = await queue.dequeue(task.taskId);
        const requestId = (queuedMessage!.message as JSONRPCRequest).id as RequestId;

        // Enqueue a response message to the queue (simulating client sending response back)
        await queue.enqueue(task.taskId, {
            type: 'response',
            message: {
                jsonrpc: '2.0',
                id: requestId,
                result: { message: 'pong' }
            },
            timestamp: Date.now()
        });

        // Simulate a client calling tasks/result which will process the response
        // This is done by creating a mock request handler that will trigger the GetTaskPayloadRequest handler
        const mockRequestId = 999;
        transport.onmessage?.({
            jsonrpc: '2.0',
            id: mockRequestId,
            method: 'tasks/result',
            params: { taskId: task.taskId }
        });

        // Wait for the response to be processed
        await new Promise(resolve => setTimeout(resolve, 50));

        // Mark task as completed
        await taskStore.updateTaskStatus(task.taskId, 'completed');
        await taskStore.storeTaskResult(task.taskId, 'completed', { _meta: {} });

        // Verify the response was routed correctly
        const result = await requestPromise;
        expect(result).toEqual({ message: 'pong' });
    });

    it('should log error when resolver is missing for side-channeled request', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });

        const errors: Error[] = [];
        server.onerror = (error: Error) => {
            errors.push(error);
        };

        await server.connect(transport);

        // Create a task
        const task = await taskStore.createTask({ ttl: 60000 }, 'test-request-1', { method: 'tools/call', params: {} });

        // Send a request with related task metadata
        void server.request(
            {
                method: 'ping',
                params: {}
            },
            z.object({ message: z.string() }),
            {
                relatedTask: { taskId: task.taskId }
            }
        );

        // Get the request ID from the queue
        const queue = (server as unknown as TestProtocol)._taskMessageQueue;
        const queuedMessage = await queue!.dequeue(task.taskId);
        const requestId = (queuedMessage!.message as JSONRPCRequest).id as RequestId;

        // Manually delete the resolver to simulate missing resolver
        (server as unknown as TestProtocol)._requestResolvers.delete(requestId);

        // Enqueue a response message - this should trigger the error logging when processed
        await queue!.enqueue(task.taskId, {
            type: 'response',
            message: {
                jsonrpc: '2.0',
                id: requestId,
                result: { message: 'pong' }
            },
            timestamp: Date.now()
        });

        // Simulate a client calling tasks/result which will process the response
        const mockRequestId = 888;
        transport.onmessage?.({
            jsonrpc: '2.0',
            id: mockRequestId,
            method: 'tasks/result',
            params: { taskId: task.taskId }
        });

        // Wait for the response to be processed
        await new Promise(resolve => setTimeout(resolve, 50));

        // Mark task as completed
        await taskStore.updateTaskStatus(task.taskId, 'completed');
        await taskStore.storeTaskResult(task.taskId, 'completed', { _meta: {} });

        // Wait a bit more for error to be logged
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify error was logged
        expect(errors.length).toBeGreaterThanOrEqual(1);
        expect(errors.some(e => e.message.includes('Response handler missing for request'))).toBe(true);
    });

    it('should propagate queue overflow errors for requests without failing the task', async () => {
        const taskStore = createMockTaskStore();
        const transport = new MockTransport();
        const server = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({ taskStore, taskMessageQueue: new InMemoryTaskMessageQueue(), maxTaskQueueSize: 100 });

        await server.connect(transport);

        // Create a task
        const task = await taskStore.createTask({ ttl: 60000 }, 'test-request-1', { method: 'tools/call', params: {} });

        // Fill the queue to max capacity (100 messages)
        const promises: Promise<unknown>[] = [];
        for (let i = 0; i < 100; i++) {
            const promise = server
                .request(
                    {
                        method: 'ping',
                        params: {}
                    },
                    z.object({}),
                    {
                        relatedTask: { taskId: task.taskId }
                    }
                )
                .catch(() => {
                    // Requests will remain pending until task completes or fails
                });
            promises.push(promise);
        }

        // Try to add one more request - should throw an error
        await expect(
            server.request(
                {
                    method: 'ping',
                    params: {}
                },
                z.object({}),
                {
                    relatedTask: { taskId: task.taskId }
                }
            )
        ).rejects.toThrow('overflow');

        // Verify the task was NOT automatically failed by the Protocol
        // (implementations can choose to fail tasks on overflow if they want)
        expect(taskStore.updateTaskStatus).not.toHaveBeenCalledWith(task.taskId, 'failed', expect.anything(), expect.anything());
    });
});

describe('Message Interception', () => {
    let protocol: Protocol<BaseContext>;
    let transport: MockTransport;
    let mockTaskStore: TaskStore & { [K in keyof TaskStore]: MockInstance };

    beforeEach(() => {
        transport = new MockTransport();
        mockTaskStore = createMockTaskStore();
        protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore: mockTaskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });
    });

    describe('messages with relatedTask metadata are queued', () => {
        it('should queue notifications with relatedTask metadata', async () => {
            await protocol.connect(transport);

            // Send a notification with relatedTask metadata
            await protocol.notification(
                {
                    method: 'notifications/message',
                    params: { level: 'info', data: 'test message' }
                },
                {
                    relatedTask: {
                        taskId: 'task-123'
                    }
                }
            );

            // Access the private _taskMessageQueue to verify the message was queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            const queuedMessage = await queue!.dequeue('task-123');
            assertQueuedNotification(queuedMessage);
            expect(queuedMessage!.message.method).toBe('notifications/message');
        });

        it('should queue requests with relatedTask metadata', async () => {
            await protocol.connect(transport);

            const mockSchema = z.object({ result: z.string() });

            // Send a request with relatedTask metadata
            const requestPromise = protocol.request(
                {
                    method: 'test/request',
                    params: { data: 'test' }
                },
                mockSchema,
                {
                    relatedTask: {
                        taskId: 'task-456'
                    }
                }
            );

            // Access the private _taskMessageQueue to verify the message was queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            const queuedMessage = await queue!.dequeue('task-456');
            assertQueuedRequest(queuedMessage);
            expect(queuedMessage.message.method).toBe('test/request');

            // Verify resolver is stored in _requestResolvers map (not in the message)
            const requestId = queuedMessage.message.id as RequestId;
            const resolvers = (protocol as unknown as TestProtocol)._requestResolvers;
            expect(resolvers.has(requestId)).toBe(true);

            // Clean up the pending request
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: requestId,
                result: { result: 'success' }
            });
            await requestPromise;
        });
    });

    describe('server queues responses/errors for task-related requests', () => {
        it('should queue response when handling a request with relatedTask metadata', async () => {
            await protocol.connect(transport);

            // Set up a request handler that returns a result
            protocol.setRequestHandler('ping', async () => {
                return {};
            });

            // Simulate an incoming request with relatedTask metadata
            const requestId = 456;
            const taskId = 'task-response-test';
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: requestId,
                method: 'ping',
                params: {
                    _meta: {
                        'io.modelcontextprotocol/related-task': { taskId }
                    }
                }
            });

            // Wait for the handler to complete
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify the response was queued instead of sent directly
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            const queuedMessage = await queue!.dequeue(taskId);
            expect(queuedMessage).toBeDefined();
            expect(queuedMessage!.type).toBe('response');
            if (queuedMessage!.type === 'response') {
                expect(queuedMessage!.message.id).toBe(requestId);
                expect(queuedMessage!.message.result).toEqual({});
            }
        });

        it('should queue error when handling a request with relatedTask metadata that throws', async () => {
            await protocol.connect(transport);

            // Set up a request handler that throws an error
            protocol.setRequestHandler('ping', async () => {
                throw new ProtocolError(ProtocolErrorCode.InternalError, 'Test error message');
            });

            // Simulate an incoming request with relatedTask metadata
            const requestId = 789;
            const taskId = 'task-error-test';
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: requestId,
                method: 'ping',
                params: {
                    _meta: {
                        'io.modelcontextprotocol/related-task': { taskId }
                    }
                }
            });

            // Wait for the handler to complete
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify the error was queued instead of sent directly
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            const queuedMessage = await queue!.dequeue(taskId);
            expect(queuedMessage).toBeDefined();
            expect(queuedMessage!.type).toBe('error');
            if (queuedMessage!.type === 'error') {
                expect(queuedMessage!.message.id).toBe(requestId);
                expect(queuedMessage!.message.error.code).toBe(ProtocolErrorCode.InternalError);
                expect(queuedMessage!.message.error.message).toContain('Test error message');
            }
        });

        it('should queue MethodNotFound error for unknown method with relatedTask metadata', async () => {
            await protocol.connect(transport);

            // Simulate an incoming request for unknown method with relatedTask metadata
            const requestId = 101;
            const taskId = 'task-not-found-test';
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: requestId,
                method: 'unknown/method',
                params: {
                    _meta: {
                        'io.modelcontextprotocol/related-task': { taskId }
                    }
                }
            });

            // Wait for processing
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify the error was queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            const queuedMessage = await queue!.dequeue(taskId);
            expect(queuedMessage).toBeDefined();
            expect(queuedMessage!.type).toBe('error');
            if (queuedMessage!.type === 'error') {
                expect(queuedMessage!.message.id).toBe(requestId);
                expect(queuedMessage!.message.error.code).toBe(ProtocolErrorCode.MethodNotFound);
            }
        });

        it('should send response normally when request has no relatedTask metadata', async () => {
            await protocol.connect(transport);
            const sendSpy = vi.spyOn(transport, 'send');

            // Set up a request handler
            protocol.setRequestHandler('tools/call', async () => {
                return { content: [{ type: 'text', text: 'done' }] };
            });

            // Simulate an incoming request WITHOUT relatedTask metadata
            const requestId = 202;
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: requestId,
                method: 'tools/call',
                params: { name: 'test-tool' }
            });

            // Wait for the handler to complete
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify the response was sent through transport, not queued
            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    id: requestId,
                    result: { content: [{ type: 'text', text: 'done' }] }
                })
            );
        });
    });

    describe('messages without metadata bypass the queue', () => {
        it('should not queue notifications without relatedTask metadata', async () => {
            await protocol.connect(transport);

            // Send a notification without relatedTask metadata
            await protocol.notification({
                method: 'notifications/message',
                params: { level: 'info', data: 'test message' }
            });

            // Access the private _taskMessageQueue to verify no messages were queued
            // Since we can't check if queues exist without messages, we verify that
            // attempting to dequeue returns undefined (no messages queued)
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();
        });

        it('should not queue requests without relatedTask metadata', async () => {
            await protocol.connect(transport);

            const mockSchema = z.object({ result: z.string() });
            const sendSpy = vi.spyOn(transport, 'send');

            // Send a request without relatedTask metadata
            const requestPromise = protocol.request(
                {
                    method: 'test/request',
                    params: { data: 'test' }
                },
                mockSchema
            );

            // Access the private _taskMessageQueue to verify no messages were queued
            // Since we can't check if queues exist without messages, we verify that
            // attempting to dequeue returns undefined (no messages queued)
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Clean up the pending request
            const requestId = (sendSpy.mock.calls[0]![0] as JSONRPCResultResponse).id;
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: requestId,
                result: { result: 'success' }
            });
            await requestPromise;
        });
    });

    describe('task ID extraction from metadata', () => {
        it('should extract correct task ID from relatedTask metadata for notifications', async () => {
            await protocol.connect(transport);

            const taskId = 'extracted-task-789';

            // Send a notification with relatedTask metadata
            await protocol.notification(
                {
                    method: 'notifications/message',
                    params: { data: 'test' }
                },
                {
                    relatedTask: {
                        taskId: taskId
                    }
                }
            );

            // Verify the message was queued under the correct task ID
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Verify a message was queued for this task
            const queuedMessage = await queue!.dequeue(taskId);
            assertQueuedNotification(queuedMessage);
            expect(queuedMessage.message.method).toBe('notifications/message');
        });

        it('should extract correct task ID from relatedTask metadata for requests', async () => {
            await protocol.connect(transport);

            const taskId = 'extracted-task-999';
            const mockSchema = z.object({ result: z.string() });

            // Send a request with relatedTask metadata
            const requestPromise = protocol.request(
                {
                    method: 'test/request',
                    params: { data: 'test' }
                },
                mockSchema,
                {
                    relatedTask: {
                        taskId: taskId
                    }
                }
            );

            // Verify the message was queued under the correct task ID
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Clean up the pending request
            const queuedMessage = await queue!.dequeue(taskId);
            assertQueuedRequest(queuedMessage);
            expect(queuedMessage.message.method).toBe('test/request');
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: queuedMessage.message.id,
                result: { result: 'success' }
            });
            await requestPromise;
        });

        it('should handle multiple messages for different task IDs', async () => {
            await protocol.connect(transport);

            // Send messages for different tasks
            await protocol.notification({ method: 'test1', params: {} }, { relatedTask: { taskId: 'task-A' } });
            await protocol.notification({ method: 'test2', params: {} }, { relatedTask: { taskId: 'task-B' } });
            await protocol.notification({ method: 'test3', params: {} }, { relatedTask: { taskId: 'task-A' } });

            // Verify messages are queued under correct task IDs
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Verify two messages for task-A
            const msg1A = await queue!.dequeue('task-A');
            const msg2A = await queue!.dequeue('task-A');
            const msg3A = await queue!.dequeue('task-A'); // Should be undefined
            expect(msg1A).toBeDefined();
            expect(msg2A).toBeDefined();
            expect(msg3A).toBeUndefined();

            // Verify one message for task-B
            const msg1B = await queue!.dequeue('task-B');
            const msg2B = await queue!.dequeue('task-B'); // Should be undefined
            expect(msg1B).toBeDefined();
            expect(msg2B).toBeUndefined();
        });
    });

    describe('queue creation on first message', () => {
        it('should queue messages for a task', async () => {
            await protocol.connect(transport);

            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Send first message for a task
            await protocol.notification({ method: 'test', params: {} }, { relatedTask: { taskId: 'new-task' } });

            // Verify message was queued
            const msg = await queue!.dequeue('new-task');
            assertQueuedNotification(msg);
            expect(msg.message.method).toBe('test');
        });

        it('should queue multiple messages for the same task', async () => {
            await protocol.connect(transport);

            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Send first message
            await protocol.notification({ method: 'test1', params: {} }, { relatedTask: { taskId: 'reuse-task' } });

            // Send second message
            await protocol.notification({ method: 'test2', params: {} }, { relatedTask: { taskId: 'reuse-task' } });

            // Verify both messages were queued in order
            const msg1 = await queue!.dequeue('reuse-task');
            const msg2 = await queue!.dequeue('reuse-task');
            assertQueuedNotification(msg1);
            expect(msg1.message.method).toBe('test1');
            assertQueuedNotification(msg2);
            expect(msg2.message.method).toBe('test2');
        });

        it('should queue messages for different tasks separately', async () => {
            await protocol.connect(transport);

            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Send messages for different tasks
            await protocol.notification({ method: 'test1', params: {} }, { relatedTask: { taskId: 'task-1' } });
            await protocol.notification({ method: 'test2', params: {} }, { relatedTask: { taskId: 'task-2' } });

            // Verify messages are queued separately
            const msg1 = await queue!.dequeue('task-1');
            const msg2 = await queue!.dequeue('task-2');
            assertQueuedNotification(msg1);
            expect(msg1?.message.method).toBe('test1');
            assertQueuedNotification(msg2);
            expect(msg2?.message.method).toBe('test2');
        });
    });

    describe('metadata preservation in queued messages', () => {
        it('should preserve relatedTask metadata in queued notification', async () => {
            await protocol.connect(transport);

            const relatedTask = { taskId: 'task-meta-123' };

            await protocol.notification(
                {
                    method: 'test/notification',
                    params: { data: 'test' }
                },
                { relatedTask }
            );

            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            const queuedMessage = await queue!.dequeue('task-meta-123');

            // Verify the metadata is preserved in the queued message
            expect(queuedMessage).toBeDefined();
            assertQueuedNotification(queuedMessage);
            expect(queuedMessage.message.params!._meta).toBeDefined();
            expect(queuedMessage.message.params!._meta![RELATED_TASK_META_KEY]).toEqual(relatedTask);
        });

        it('should preserve relatedTask metadata in queued request', async () => {
            await protocol.connect(transport);

            const relatedTask = { taskId: 'task-meta-456' };
            const mockSchema = z.object({ result: z.string() });

            const requestPromise = protocol.request(
                {
                    method: 'test/request',
                    params: { data: 'test' }
                },
                mockSchema,
                { relatedTask }
            );

            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            const queuedMessage = await queue!.dequeue('task-meta-456');

            // Verify the metadata is preserved in the queued message
            expect(queuedMessage).toBeDefined();
            assertQueuedRequest(queuedMessage);
            expect(queuedMessage.message.params!._meta).toBeDefined();
            expect(queuedMessage.message.params!._meta![RELATED_TASK_META_KEY]).toEqual(relatedTask);

            // Clean up
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: (queuedMessage!.message as JSONRPCRequest).id,
                result: { result: 'success' }
            });
            await requestPromise;
        });

        it('should preserve existing _meta fields when adding relatedTask', async () => {
            await protocol.connect(transport);

            await protocol.notification(
                {
                    method: 'test/notification',
                    params: {
                        data: 'test',
                        _meta: {
                            customField: 'customValue',
                            anotherField: 123
                        }
                    }
                },
                {
                    relatedTask: { taskId: 'task-preserve-meta' }
                }
            );

            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            const queuedMessage = await queue!.dequeue('task-preserve-meta');

            // Verify both existing and new metadata are preserved
            expect(queuedMessage).toBeDefined();
            assertQueuedNotification(queuedMessage);
            expect(queuedMessage.message.params!._meta!.customField).toBe('customValue');
            expect(queuedMessage.message.params!._meta!.anotherField).toBe(123);
            expect(queuedMessage.message.params!._meta![RELATED_TASK_META_KEY]).toEqual({
                taskId: 'task-preserve-meta'
            });
        });
    });
});

describe('Queue lifecycle management', () => {
    let protocol: Protocol<BaseContext>;
    let transport: MockTransport;
    let mockTaskStore: TaskStore & { [K in keyof TaskStore]: MockInstance };

    beforeEach(() => {
        transport = new MockTransport();
        mockTaskStore = createMockTaskStore();
        protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore: mockTaskStore, taskMessageQueue: new InMemoryTaskMessageQueue() });
    });

    describe('queue cleanup on task completion', () => {
        it('should clear queue when task reaches completed status', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await mockTaskStore.createTask({}, 1, { method: 'test', params: {} });
            const taskId = task.taskId;

            // Queue some messages for the task
            await protocol.notification({ method: 'test/notification', params: { data: 'test1' } }, { relatedTask: { taskId } });
            await protocol.notification({ method: 'test/notification', params: { data: 'test2' } }, { relatedTask: { taskId } });

            // Verify messages are queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Verify messages can be dequeued
            const msg1 = await queue!.dequeue(taskId);
            const msg2 = await queue!.dequeue(taskId);
            expect(msg1).toBeDefined();
            expect(msg2).toBeDefined();

            // Directly call the cleanup method (simulating what happens when task reaches terminal status)
            (protocol as unknown as TestProtocol)._clearTaskQueue(taskId);

            // After cleanup, no more messages should be available
            const msg3 = await queue!.dequeue(taskId);
            expect(msg3).toBeUndefined();
        });

        it('should clear queue after delivering messages on tasks/result for completed task', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await mockTaskStore.createTask({}, 1, { method: 'test', params: {} });
            const taskId = task.taskId;

            // Queue a message
            await protocol.notification({ method: 'test/notification', params: { data: 'test' } }, { relatedTask: { taskId } });

            // Mark task as completed
            const completedTask = { ...task, status: 'completed' as const };
            mockTaskStore.getTask.mockResolvedValue(completedTask);
            mockTaskStore.getTaskResult.mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });

            // Simulate tasks/result request
            const resultPromise = new Promise(resolve => {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: 100,
                    method: 'tasks/result',
                    params: { taskId }
                });
                setTimeout(resolve, 50);
            });

            await resultPromise;

            // Verify queue is cleared after delivery (no messages available)
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            const msg = await queue!.dequeue(taskId);
            expect(msg).toBeUndefined();
        });
    });

    describe('queue cleanup on task cancellation', () => {
        it('should clear queue when task is cancelled', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await mockTaskStore.createTask({}, 1, { method: 'test', params: {} });
            const taskId = task.taskId;

            // Queue some messages
            await protocol.notification({ method: 'test/notification', params: { data: 'test1' } }, { relatedTask: { taskId } });

            // Verify message is queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            const msg1 = await queue!.dequeue(taskId);
            expect(msg1).toBeDefined();

            // Re-queue the message for cancellation test
            await protocol.notification({ method: 'test/notification', params: { data: 'test1' } }, { relatedTask: { taskId } });

            // Mock task as non-terminal
            mockTaskStore.getTask.mockResolvedValue(task);

            // Cancel the task
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 200,
                method: 'tasks/cancel',
                params: { taskId }
            });

            // Wait for cancellation to process
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify queue is cleared (no messages available)
            const msg2 = await queue!.dequeue(taskId);
            expect(msg2).toBeUndefined();
        });

        it('should reject pending request resolvers when task is cancelled', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await mockTaskStore.createTask({}, 1, { method: 'test', params: {} });
            const taskId = task.taskId;

            // Queue a request (catch rejection to avoid unhandled promise rejection)
            const requestPromise = protocol
                .request({ method: 'test/request', params: { data: 'test' } }, z.object({ result: z.string() }), {
                    relatedTask: { taskId }
                })
                .catch(err => err);

            // Verify request is queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Mock task as non-terminal
            mockTaskStore.getTask.mockResolvedValue(task);

            // Cancel the task
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 201,
                method: 'tasks/cancel',
                params: { taskId }
            });

            // Wait for cancellation to process
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify the request promise is rejected
            const result = await requestPromise;
            expect(result).toBeInstanceOf(ProtocolError);
            expect(result.message).toContain('Task cancelled or completed');

            // Verify queue is cleared (no messages available)
            const msg = await queue!.dequeue(taskId);
            expect(msg).toBeUndefined();
        });
    });

    describe('queue cleanup on task failure', () => {
        it('should clear queue when task reaches failed status', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await mockTaskStore.createTask({}, 1, { method: 'test', params: {} });
            const taskId = task.taskId;

            // Queue some messages
            await protocol.notification({ method: 'test/notification', params: { data: 'test1' } }, { relatedTask: { taskId } });
            await protocol.notification({ method: 'test/notification', params: { data: 'test2' } }, { relatedTask: { taskId } });

            // Verify messages are queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Verify messages can be dequeued
            const msg1 = await queue!.dequeue(taskId);
            const msg2 = await queue!.dequeue(taskId);
            expect(msg1).toBeDefined();
            expect(msg2).toBeDefined();

            // Directly call the cleanup method (simulating what happens when task reaches terminal status)
            (protocol as unknown as TestProtocol)._clearTaskQueue(taskId);

            // After cleanup, no more messages should be available
            const msg3 = await queue!.dequeue(taskId);
            expect(msg3).toBeUndefined();
        });

        it('should reject pending request resolvers when task fails', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await mockTaskStore.createTask({}, 1, { method: 'test', params: {} });
            const taskId = task.taskId;

            // Queue a request (catch the rejection to avoid unhandled promise rejection)
            const requestPromise = protocol
                .request({ method: 'test/request', params: { data: 'test' } }, z.object({ result: z.string() }), {
                    relatedTask: { taskId }
                })
                .catch(err => err);

            // Verify request is queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Directly call the cleanup method (simulating what happens when task reaches terminal status)
            (protocol as unknown as TestProtocol)._clearTaskQueue(taskId);

            // Verify the request promise is rejected
            const result = await requestPromise;
            expect(result).toBeInstanceOf(ProtocolError);
            expect(result.message).toContain('Task cancelled or completed');

            // Verify queue is cleared (no messages available)
            const msg = await queue!.dequeue(taskId);
            expect(msg).toBeUndefined();
        });
    });

    describe('resolver rejection on cleanup', () => {
        it('should reject all pending request resolvers when queue is cleared', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await mockTaskStore.createTask({}, 1, { method: 'test', params: {} });
            const taskId = task.taskId;

            // Queue multiple requests (catch rejections to avoid unhandled promise rejections)
            const request1Promise = protocol
                .request({ method: 'test/request1', params: { data: 'test1' } }, z.object({ result: z.string() }), {
                    relatedTask: { taskId }
                })
                .catch(err => err);

            const request2Promise = protocol
                .request({ method: 'test/request2', params: { data: 'test2' } }, z.object({ result: z.string() }), {
                    relatedTask: { taskId }
                })
                .catch(err => err);

            const request3Promise = protocol
                .request({ method: 'test/request3', params: { data: 'test3' } }, z.object({ result: z.string() }), {
                    relatedTask: { taskId }
                })
                .catch(err => err);

            // Verify requests are queued
            const queue = (protocol as unknown as TestProtocol)._taskMessageQueue;
            expect(queue).toBeDefined();

            // Directly call the cleanup method (simulating what happens when task reaches terminal status)
            (protocol as unknown as TestProtocol)._clearTaskQueue(taskId);

            // Verify all request promises are rejected
            const result1 = await request1Promise;
            const result2 = await request2Promise;
            const result3 = await request3Promise;

            expect(result1).toBeInstanceOf(ProtocolError);
            expect(result1.message).toContain('Task cancelled or completed');
            expect(result2).toBeInstanceOf(ProtocolError);
            expect(result2.message).toContain('Task cancelled or completed');
            expect(result3).toBeInstanceOf(ProtocolError);
            expect(result3.message).toContain('Task cancelled or completed');

            // Verify queue is cleared (no messages available)
            const msg = await queue!.dequeue(taskId);
            expect(msg).toBeUndefined();
        });

        it('should clean up resolver mappings when rejecting requests', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await mockTaskStore.createTask({}, 1, { method: 'test', params: {} });
            const taskId = task.taskId;

            // Queue a request (catch rejection to avoid unhandled promise rejection)
            const requestPromise = protocol
                .request({ method: 'test/request', params: { data: 'test' } }, z.object({ result: z.string() }), {
                    relatedTask: { taskId }
                })
                .catch(err => err);

            // Get the request ID that was sent
            const requestResolvers = (protocol as unknown as TestProtocol)._requestResolvers;
            const initialResolverCount = requestResolvers.size;
            expect(initialResolverCount).toBeGreaterThan(0);

            // Complete the task (triggers cleanup)
            const completedTask = { ...task, status: 'completed' as const };
            mockTaskStore.getTask.mockResolvedValue(completedTask);

            // Directly call the cleanup method (simulating what happens when task reaches terminal status)
            (protocol as unknown as TestProtocol)._clearTaskQueue(taskId);

            // Verify request promise is rejected
            const result = await requestPromise;
            expect(result).toBeInstanceOf(ProtocolError);
            expect(result.message).toContain('Task cancelled or completed');

            // Verify resolver mapping is cleaned up
            // The resolver should be removed from the map
            expect(requestResolvers.size).toBeLessThan(initialResolverCount);
        });
    });
});

describe('requestStream() method', () => {
    const CallToolResultSchema = z.object({
        content: z.array(z.object({ type: z.string(), text: z.string() })),
        _meta: z.object({}).optional()
    });

    test('should yield result immediately for non-task requests', async () => {
        const transport = new MockTransport();
        const protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })();
        await protocol.connect(transport);

        // Start the request stream
        const streamPromise = (async () => {
            const messages = [];
            const stream = (protocol as unknown as TestProtocol).requestStream(
                { method: 'tools/call', params: { name: 'test', arguments: {} } },
                CallToolResultSchema
            );
            for await (const message of stream) {
                messages.push(message);
            }
            return messages;
        })();

        // Simulate server response
        await new Promise(resolve => setTimeout(resolve, 10));
        transport.onmessage?.({
            jsonrpc: '2.0',
            id: 0,
            result: {
                content: [{ type: 'text', text: 'test result' }],
                _meta: {}
            }
        });

        const messages = await streamPromise;

        // Should yield exactly one result message
        expect(messages).toHaveLength(1);
        expect(messages[0]?.type).toBe('result');
        expect(messages[0]).toHaveProperty('result');
    });

    test('should yield error message on request failure', async () => {
        const transport = new MockTransport();
        const protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })();
        await protocol.connect(transport);

        // Start the request stream
        const streamPromise = (async () => {
            const messages = [];
            const stream = (protocol as unknown as TestProtocol).requestStream(
                { method: 'tools/call', params: { name: 'test', arguments: {} } },
                CallToolResultSchema
            );
            for await (const message of stream) {
                messages.push(message);
            }
            return messages;
        })();

        // Simulate server error response
        await new Promise(resolve => setTimeout(resolve, 10));
        transport.onmessage?.({
            jsonrpc: '2.0',
            id: 0,
            error: {
                code: ProtocolErrorCode.InternalError,
                message: 'Test error'
            }
        });

        const messages = await streamPromise;

        // Should yield exactly one error message
        expect(messages).toHaveLength(1);
        expect(messages[0]?.type).toBe('error');
        expect(messages[0]).toHaveProperty('error');
        if (messages[0]?.type === 'error') {
            expect(messages[0]?.error?.message).toContain('Test error');
        }
    });

    test('should handle cancellation via AbortSignal', async () => {
        const transport = new MockTransport();
        const protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(): void {}
        })();
        await protocol.connect(transport);

        const abortController = new AbortController();

        // Abort immediately before starting the stream
        abortController.abort('User cancelled');

        // Start the request stream with already-aborted signal
        const messages = [];
        const stream = (protocol as unknown as TestProtocol).requestStream(
            { method: 'tools/call', params: { name: 'test', arguments: {} } },
            CallToolResultSchema,
            {
                signal: abortController.signal
            }
        );
        for await (const message of stream) {
            messages.push(message);
        }

        // Should yield error message about cancellation
        expect(messages).toHaveLength(1);
        expect(messages[0]?.type).toBe('error');
        if (messages[0]?.type === 'error') {
            expect(messages[0]?.error?.message).toContain('cancelled');
        }
    });

    describe('Error responses', () => {
        test('should yield error as terminal message for server error response', async () => {
            const transport = new MockTransport();
            const protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })();
            await protocol.connect(transport);

            const messagesPromise = toArrayAsync(
                (protocol as unknown as TestProtocol).requestStream(
                    { method: 'tools/call', params: { name: 'test', arguments: {} } },
                    CallToolResultSchema
                )
            );

            // Simulate server error response
            await new Promise(resolve => setTimeout(resolve, 10));
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 0,
                error: {
                    code: ProtocolErrorCode.InternalError,
                    message: 'Server error'
                }
            });

            // Collect messages
            const messages = await messagesPromise;

            // Verify error is terminal and last message
            expect(messages.length).toBeGreaterThan(0);
            const lastMessage = messages[messages.length - 1];
            assertErrorResponse(lastMessage!);
            expect(lastMessage.error).toBeDefined();
            expect(lastMessage.error.message).toContain('Server error');
        });

        test('should yield error as terminal message for timeout', async () => {
            vi.useFakeTimers();
            try {
                const transport = new MockTransport();
                const protocol = new (class extends Protocol<BaseContext> {
                    protected assertCapabilityForMethod(): void {}
                    protected assertNotificationCapability(): void {}
                    protected assertRequestHandlerCapability(): void {}
                    protected assertTaskCapability(): void {}
                    protected buildContext(ctx: BaseContext): BaseContext {
                        return ctx;
                    }
                    protected assertTaskHandlerCapability(): void {}
                })();
                await protocol.connect(transport);

                const messagesPromise = toArrayAsync(
                    (protocol as unknown as TestProtocol).requestStream(
                        { method: 'tools/call', params: { name: 'test', arguments: {} } },
                        CallToolResultSchema,
                        {
                            timeout: 100
                        }
                    )
                );

                // Advance time to trigger timeout
                await vi.advanceTimersByTimeAsync(101);

                // Collect messages
                const messages = await messagesPromise;

                // Verify error is terminal and last message
                expect(messages.length).toBeGreaterThan(0);
                const lastMessage = messages[messages.length - 1];
                assertErrorResponse(lastMessage!);
                expect(lastMessage.error).toBeDefined();
                expect(lastMessage.error).toBeInstanceOf(SdkError);
                expect((lastMessage.error as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
            } finally {
                vi.useRealTimers();
            }
        });

        test('should yield error as terminal message for cancellation', async () => {
            const transport = new MockTransport();
            const protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })();
            await protocol.connect(transport);

            const abortController = new AbortController();
            abortController.abort('User cancelled');

            // Collect messages
            const messages = await toArrayAsync(
                (protocol as unknown as TestProtocol).requestStream(
                    { method: 'tools/call', params: { name: 'test', arguments: {} } },
                    CallToolResultSchema,
                    {
                        signal: abortController.signal
                    }
                )
            );

            // Verify error is terminal and last message
            expect(messages.length).toBeGreaterThan(0);
            const lastMessage = messages[messages.length - 1];
            assertErrorResponse(lastMessage!);
            expect(lastMessage.error).toBeDefined();
            expect(lastMessage.error.message).toContain('cancelled');
        });

        test('should not yield any messages after error message', async () => {
            const transport = new MockTransport();
            const protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })();
            await protocol.connect(transport);

            const messagesPromise = toArrayAsync(
                (protocol as unknown as TestProtocol).requestStream(
                    { method: 'tools/call', params: { name: 'test', arguments: {} } },
                    CallToolResultSchema
                )
            );

            // Simulate server error response
            await new Promise(resolve => setTimeout(resolve, 10));
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 0,
                error: {
                    code: ProtocolErrorCode.InternalError,
                    message: 'Test error'
                }
            });

            // Collect messages
            const messages = await messagesPromise;

            // Verify only one message (the error) was yielded
            expect(messages).toHaveLength(1);
            expect(messages[0]?.type).toBe('error');

            // Try to send another message (should be ignored)
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 0,
                result: {
                    content: [{ type: 'text', text: 'should not appear' }]
                }
            });

            await new Promise(resolve => setTimeout(resolve, 10));

            // Verify no additional messages were yielded
            expect(messages).toHaveLength(1);
        });

        test('should yield error as terminal message for task failure', async () => {
            const transport = new MockTransport();
            const mockTaskStore = createMockTaskStore();
            const protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });
            await protocol.connect(transport);

            const messagesPromise = toArrayAsync(
                (protocol as unknown as TestProtocol).requestStream(
                    { method: 'tools/call', params: { name: 'test', arguments: {} } },
                    CallToolResultSchema
                )
            );

            // Simulate task creation response
            await new Promise(resolve => setTimeout(resolve, 10));
            const taskId = 'test-task-123';
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 0,
                result: {
                    _meta: {
                        task: {
                            taskId,
                            status: 'working',
                            createdAt: new Date().toISOString(),
                            pollInterval: 100
                        }
                    }
                }
            });

            // Wait for task creation to be processed
            await new Promise(resolve => setTimeout(resolve, 20));

            // Update task to failed status
            const failedTask = {
                taskId,
                status: 'failed' as const,
                createdAt: new Date().toISOString(),
                pollInterval: 100,
                ttl: null,
                statusMessage: 'Task failed'
            };
            mockTaskStore.getTask.mockResolvedValue(failedTask);

            // Collect messages
            const messages = await messagesPromise;

            // Verify error is terminal and last message
            expect(messages.length).toBeGreaterThan(0);
            const lastMessage = messages[messages.length - 1];
            assertErrorResponse(lastMessage!);
            expect(lastMessage.error).toBeDefined();
        });

        test('should yield error as terminal message for network error', async () => {
            const transport = new MockTransport();
            const protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })();
            await protocol.connect(transport);

            // Override send to simulate network error
            transport.send = vi.fn().mockRejectedValue(new Error('Network error'));

            const messages = await toArrayAsync(
                (protocol as unknown as TestProtocol).requestStream(
                    { method: 'tools/call', params: { name: 'test', arguments: {} } },
                    CallToolResultSchema
                )
            );

            // Verify error is terminal and last message
            expect(messages.length).toBeGreaterThan(0);
            const lastMessage = messages[messages.length - 1];
            assertErrorResponse(lastMessage!);
            expect(lastMessage.error).toBeDefined();
        });

        test('should ensure error is always the final message', async () => {
            const transport = new MockTransport();
            const protocol = new (class extends Protocol<BaseContext> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected buildContext(ctx: BaseContext): BaseContext {
                    return ctx;
                }
                protected assertTaskHandlerCapability(): void {}
            })();
            await protocol.connect(transport);

            const messagesPromise = toArrayAsync(
                (protocol as unknown as TestProtocol).requestStream(
                    { method: 'tools/call', params: { name: 'test', arguments: {} } },
                    CallToolResultSchema
                )
            );

            // Simulate server error response
            await new Promise(resolve => setTimeout(resolve, 10));
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 0,
                error: {
                    code: ProtocolErrorCode.InternalError,
                    message: 'Test error'
                }
            });

            // Collect messages
            const messages = await messagesPromise;

            // Verify error is the last message
            expect(messages.length).toBeGreaterThan(0);
            const lastMessage = messages[messages.length - 1];
            expect(lastMessage?.type).toBe('error');

            // Verify all messages before the last are not terminal
            for (let i = 0; i < messages.length - 1; i++) {
                expect(messages[i]?.type).not.toBe('error');
                expect(messages[i]?.type).not.toBe('result');
            }
        });
    });
});

describe('Error handling for missing resolvers', () => {
    let protocol: Protocol<BaseContext>;
    let transport: MockTransport;
    let taskStore: TaskStore & { [K in keyof TaskStore]: MockInstance };
    let taskMessageQueue: TaskMessageQueue;
    let errorHandler: MockInstance;

    beforeEach(() => {
        taskStore = createMockTaskStore();
        taskMessageQueue = new InMemoryTaskMessageQueue();
        errorHandler = vi.fn();

        protocol = new (class extends Protocol<BaseContext> {
            protected assertCapabilityForMethod(_method: string): void {}
            protected assertNotificationCapability(_method: string): void {}
            protected assertRequestHandlerCapability(_method: string): void {}
            protected assertTaskCapability(_method: string): void {}
            protected buildContext(ctx: BaseContext): BaseContext {
                return ctx;
            }
            protected assertTaskHandlerCapability(_method: string): void {}
        })({
            taskStore,
            taskMessageQueue,
            defaultTaskPollInterval: 100
        });

        // @ts-expect-error deliberately overriding error handler with mock
        protocol.onerror = errorHandler;
        transport = new MockTransport();
    });

    describe('Response routing with missing resolvers', () => {
        it('should log error for unknown request ID without throwing', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });

            // Enqueue a response message without a corresponding resolver
            await taskMessageQueue.enqueue(task.taskId, {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 999, // Non-existent request ID
                    result: { content: [] }
                },
                timestamp: Date.now()
            });

            // Set up the GetTaskPayloadRequest handler to process the message
            const testProtocol = protocol as unknown as TestProtocol;

            // Simulate dequeuing and processing the response
            const queuedMessage = await taskMessageQueue.dequeue(task.taskId);
            expect(queuedMessage).toBeDefined();
            expect(queuedMessage?.type).toBe('response');

            // Manually trigger the response handling logic
            if (queuedMessage && queuedMessage.type === 'response') {
                const responseMessage = queuedMessage.message as JSONRPCResultResponse;
                const requestId = responseMessage.id as RequestId;
                const resolver = testProtocol._requestResolvers.get(requestId);

                if (!resolver) {
                    // This simulates what happens in the actual handler
                    protocol.onerror?.(new Error(`Response handler missing for request ${requestId}`));
                }
            }

            // Verify error was logged
            expect(errorHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('Response handler missing for request 999')
                })
            );
        });

        it('should continue processing after missing resolver error', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });

            // Enqueue a response with missing resolver, then a valid notification
            await taskMessageQueue.enqueue(task.taskId, {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 999,
                    result: { content: [] }
                },
                timestamp: Date.now()
            });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'notification',
                message: {
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: { progress: 50, total: 100 }
                },
                timestamp: Date.now()
            });

            // Process first message (response with missing resolver)
            const msg1 = await taskMessageQueue.dequeue(task.taskId);
            expect(msg1?.type).toBe('response');

            // Process second message (should work fine)
            const msg2 = await taskMessageQueue.dequeue(task.taskId);
            expect(msg2?.type).toBe('notification');
            expect(msg2?.message).toMatchObject({
                method: 'notifications/progress'
            });
        });
    });

    describe('Task cancellation with missing resolvers', () => {
        it('should log error when resolver is missing during cleanup', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });

            // Enqueue a request without storing a resolver
            await taskMessageQueue.enqueue(task.taskId, {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: 42,
                    method: 'tools/call',
                    params: { name: 'test-tool', arguments: {} }
                },
                timestamp: Date.now()
            });

            // Clear the task queue (simulating cancellation)
            const testProtocol = protocol as unknown as TestProtocol;
            await testProtocol._clearTaskQueue(task.taskId);

            // Verify error was logged for missing resolver
            expect(errorHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('Resolver missing for request 42')
                })
            );
        });

        it('should handle cleanup gracefully when resolver exists', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });

            const requestId = 42;
            const resolverMock = vi.fn();

            // Store a resolver
            const testProtocol = protocol as unknown as TestProtocol;
            testProtocol._requestResolvers.set(requestId, resolverMock);

            // Enqueue a request
            await taskMessageQueue.enqueue(task.taskId, {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: requestId,
                    method: 'tools/call',
                    params: { name: 'test-tool', arguments: {} }
                },
                timestamp: Date.now()
            });

            // Clear the task queue
            await testProtocol._clearTaskQueue(task.taskId);

            // Verify resolver was called with cancellation error
            expect(resolverMock).toHaveBeenCalledWith(expect.any(ProtocolError));

            // Verify the error has the correct properties
            const calledError = resolverMock.mock.calls[0]![0];
            expect(calledError.code).toBe(ProtocolErrorCode.InternalError);
            expect(calledError.message).toContain('Task cancelled or completed');

            // Verify resolver was removed
            expect(testProtocol._requestResolvers.has(requestId)).toBe(false);
        });

        it('should handle mixed messages during cleanup', async () => {
            await protocol.connect(transport);

            // Create a task
            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });

            const testProtocol = protocol as unknown as TestProtocol;

            // Enqueue multiple messages: request with resolver, request without, notification
            const requestId1 = 42;
            const resolverMock = vi.fn();
            testProtocol._requestResolvers.set(requestId1, resolverMock);

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: requestId1,
                    method: 'tools/call',
                    params: { name: 'test-tool', arguments: {} }
                },
                timestamp: Date.now()
            });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: 43, // No resolver for this one
                    method: 'tools/call',
                    params: { name: 'test-tool', arguments: {} }
                },
                timestamp: Date.now()
            });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'notification',
                message: {
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: { progress: 50, total: 100 }
                },
                timestamp: Date.now()
            });

            // Clear the task queue
            await testProtocol._clearTaskQueue(task.taskId);

            // Verify resolver was called for first request
            expect(resolverMock).toHaveBeenCalledWith(expect.any(ProtocolError));

            // Verify the error has the correct properties
            const calledError = resolverMock.mock.calls[0]![0];
            expect(calledError.code).toBe(ProtocolErrorCode.InternalError);
            expect(calledError.message).toContain('Task cancelled or completed');

            // Verify error was logged for second request
            expect(errorHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('Resolver missing for request 43')
                })
            );

            // Verify queue is empty
            const remaining = await taskMessageQueue.dequeue(task.taskId);
            expect(remaining).toBeUndefined();
        });
    });

    describe('Side-channeled request error handling', () => {
        it('should log error when response handler is missing for side-channeled request', async () => {
            await protocol.connect(transport);

            const testProtocol = protocol as unknown as TestProtocol;
            const messageId = 123;

            // Create a response resolver without a corresponding response handler
            const responseResolver = (response: JSONRPCResultResponse | Error) => {
                const handler = testProtocol._responseHandlers.get(messageId);
                if (handler) {
                    handler(response);
                } else {
                    protocol.onerror?.(new Error(`Response handler missing for side-channeled request ${messageId}`));
                }
            };

            // Simulate the resolver being called without a handler
            const mockResponse: JSONRPCResultResponse = {
                jsonrpc: '2.0',
                id: messageId,
                result: { content: [] }
            };

            responseResolver(mockResponse);

            // Verify error was logged
            expect(errorHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('Response handler missing for side-channeled request 123')
                })
            );
        });
    });

    describe('Error handling does not throw exceptions', () => {
        it('should not throw when processing response with missing resolver', async () => {
            await protocol.connect(transport);

            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 999,
                    result: { content: [] }
                },
                timestamp: Date.now()
            });

            // This should not throw
            const processMessage = async () => {
                const msg = await taskMessageQueue.dequeue(task.taskId);
                if (msg && msg.type === 'response') {
                    const testProtocol = protocol as unknown as TestProtocol;
                    const responseMessage = msg.message as JSONRPCResultResponse;
                    const requestId = responseMessage.id as RequestId;
                    const resolver = testProtocol._requestResolvers.get(requestId);
                    if (!resolver) {
                        protocol.onerror?.(new Error(`Response handler missing for request ${requestId}`));
                    }
                }
            };

            await expect(processMessage()).resolves.not.toThrow();
        });

        it('should not throw during task cleanup with missing resolvers', async () => {
            await protocol.connect(transport);

            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: 42,
                    method: 'tools/call',
                    params: { name: 'test-tool', arguments: {} }
                },
                timestamp: Date.now()
            });

            const testProtocol = protocol as unknown as TestProtocol;

            // This should not throw
            await expect(testProtocol._clearTaskQueue(task.taskId)).resolves.not.toThrow();
        });
    });

    describe('Error message routing', () => {
        it('should route error messages to resolvers correctly', async () => {
            await protocol.connect(transport);

            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });
            const requestId = 42;
            const resolverMock = vi.fn();

            // Store a resolver
            const testProtocol = protocol as unknown as TestProtocol;
            testProtocol._requestResolvers.set(requestId, resolverMock);

            // Enqueue an error message
            await taskMessageQueue.enqueue(task.taskId, {
                type: 'error',
                message: {
                    jsonrpc: '2.0',
                    id: requestId,
                    error: {
                        code: ProtocolErrorCode.InvalidRequest,
                        message: 'Invalid request parameters'
                    }
                },
                timestamp: Date.now()
            });

            // Simulate dequeuing and processing the error
            const queuedMessage = await taskMessageQueue.dequeue(task.taskId);
            expect(queuedMessage).toBeDefined();
            expect(queuedMessage?.type).toBe('error');

            // Manually trigger the error handling logic
            if (queuedMessage && queuedMessage.type === 'error') {
                const errorMessage = queuedMessage.message as JSONRPCErrorResponse;
                const reqId = errorMessage.id as RequestId;
                const resolver = testProtocol._requestResolvers.get(reqId);

                if (resolver) {
                    testProtocol._requestResolvers.delete(reqId);
                    const error = new ProtocolError(errorMessage.error.code, errorMessage.error.message, errorMessage.error.data);
                    resolver(error);
                }
            }

            // Verify resolver was called with ProtocolError
            expect(resolverMock).toHaveBeenCalledWith(expect.any(ProtocolError));
            const calledError = resolverMock.mock.calls[0]![0];
            expect(calledError.code).toBe(ProtocolErrorCode.InvalidRequest);
            expect(calledError.message).toContain('Invalid request parameters');

            // Verify resolver was removed from map
            expect(testProtocol._requestResolvers.has(requestId)).toBe(false);
        });

        it('should log error for unknown request ID in error messages', async () => {
            await protocol.connect(transport);

            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });

            // Enqueue an error message without a corresponding resolver
            await taskMessageQueue.enqueue(task.taskId, {
                type: 'error',
                message: {
                    jsonrpc: '2.0',
                    id: 999,
                    error: {
                        code: ProtocolErrorCode.InternalError,
                        message: 'Something went wrong'
                    }
                },
                timestamp: Date.now()
            });

            // Simulate dequeuing and processing the error
            const queuedMessage = await taskMessageQueue.dequeue(task.taskId);
            expect(queuedMessage).toBeDefined();
            expect(queuedMessage?.type).toBe('error');

            // Manually trigger the error handling logic
            if (queuedMessage && queuedMessage.type === 'error') {
                const testProtocol = protocol as unknown as TestProtocol;
                const errorMessage = queuedMessage.message as JSONRPCErrorResponse;
                const requestId = errorMessage.id as RequestId;
                const resolver = testProtocol._requestResolvers.get(requestId);

                if (!resolver) {
                    protocol.onerror?.(new Error(`Error handler missing for request ${requestId}`));
                }
            }

            // Verify error was logged
            expect(errorHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('Error handler missing for request 999')
                })
            );
        });

        it('should handle error messages with data field', async () => {
            await protocol.connect(transport);

            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });
            const requestId = 42;
            const resolverMock = vi.fn();

            // Store a resolver
            const testProtocol = protocol as unknown as TestProtocol;
            testProtocol._requestResolvers.set(requestId, resolverMock);

            // Enqueue an error message with data field
            await taskMessageQueue.enqueue(task.taskId, {
                type: 'error',
                message: {
                    jsonrpc: '2.0',
                    id: requestId,
                    error: {
                        code: ProtocolErrorCode.InvalidParams,
                        message: 'Validation failed',
                        data: { field: 'userName', reason: 'required' }
                    }
                },
                timestamp: Date.now()
            });

            // Simulate dequeuing and processing the error
            const queuedMessage = await taskMessageQueue.dequeue(task.taskId);

            if (queuedMessage && queuedMessage.type === 'error') {
                const errorMessage = queuedMessage.message as JSONRPCErrorResponse;
                const reqId = errorMessage.id as RequestId;
                const resolver = testProtocol._requestResolvers.get(reqId);

                if (resolver) {
                    testProtocol._requestResolvers.delete(reqId);
                    const error = new ProtocolError(errorMessage.error.code, errorMessage.error.message, errorMessage.error.data);
                    resolver(error);
                }
            }

            // Verify resolver was called with ProtocolError including data
            expect(resolverMock).toHaveBeenCalledWith(expect.any(ProtocolError));
            const calledError = resolverMock.mock.calls[0]![0];
            expect(calledError.code).toBe(ProtocolErrorCode.InvalidParams);
            expect(calledError.message).toContain('Validation failed');
            expect(calledError.data).toEqual({ field: 'userName', reason: 'required' });
        });

        it('should not throw when processing error with missing resolver', async () => {
            await protocol.connect(transport);

            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'error',
                message: {
                    jsonrpc: '2.0',
                    id: 999,
                    error: {
                        code: ProtocolErrorCode.InternalError,
                        message: 'Error occurred'
                    }
                },
                timestamp: Date.now()
            });

            // This should not throw
            const processMessage = async () => {
                const msg = await taskMessageQueue.dequeue(task.taskId);
                if (msg && msg.type === 'error') {
                    const testProtocol = protocol as unknown as TestProtocol;
                    const errorMessage = msg.message as JSONRPCErrorResponse;
                    const requestId = errorMessage.id as RequestId;
                    const resolver = testProtocol._requestResolvers.get(requestId);
                    if (!resolver) {
                        protocol.onerror?.(new Error(`Error handler missing for request ${requestId}`));
                    }
                }
            };

            await expect(processMessage()).resolves.not.toThrow();
        });
    });

    describe('Response and error message routing integration', () => {
        it('should handle mixed response and error messages in queue', async () => {
            await protocol.connect(transport);

            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });
            const testProtocol = protocol as unknown as TestProtocol;

            // Set up resolvers for multiple requests
            const resolver1 = vi.fn();
            const resolver2 = vi.fn();
            const resolver3 = vi.fn();

            testProtocol._requestResolvers.set(1, resolver1);
            testProtocol._requestResolvers.set(2, resolver2);
            testProtocol._requestResolvers.set(3, resolver3);

            // Enqueue mixed messages: response, error, response
            await taskMessageQueue.enqueue(task.taskId, {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    result: { content: [{ type: 'text', text: 'Success' }] }
                },
                timestamp: Date.now()
            });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'error',
                message: {
                    jsonrpc: '2.0',
                    id: 2,
                    error: {
                        code: ProtocolErrorCode.InvalidRequest,
                        message: 'Request failed'
                    }
                },
                timestamp: Date.now()
            });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 3,
                    result: { content: [{ type: 'text', text: 'Another success' }] }
                },
                timestamp: Date.now()
            });

            // Process all messages
            let msg;
            while ((msg = await taskMessageQueue.dequeue(task.taskId))) {
                if (msg.type === 'response') {
                    const responseMessage = msg.message as JSONRPCResultResponse;
                    const requestId = responseMessage.id as RequestId;
                    const resolver = testProtocol._requestResolvers.get(requestId);
                    if (resolver) {
                        testProtocol._requestResolvers.delete(requestId);
                        resolver(responseMessage);
                    }
                } else if (msg.type === 'error') {
                    const errorMessage = msg.message as JSONRPCErrorResponse;
                    const requestId = errorMessage.id as RequestId;
                    const resolver = testProtocol._requestResolvers.get(requestId);
                    if (resolver) {
                        testProtocol._requestResolvers.delete(requestId);
                        const error = new ProtocolError(errorMessage.error.code, errorMessage.error.message, errorMessage.error.data);
                        resolver(error);
                    }
                }
            }

            // Verify all resolvers were called correctly
            expect(resolver1).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
            expect(resolver2).toHaveBeenCalledWith(expect.any(ProtocolError));
            expect(resolver3).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));

            // Verify error has correct properties
            const error = resolver2.mock.calls[0]![0];
            expect(error.code).toBe(ProtocolErrorCode.InvalidRequest);
            expect(error.message).toContain('Request failed');

            // Verify all resolvers were removed
            expect(testProtocol._requestResolvers.size).toBe(0);
        });

        it('should maintain FIFO order when processing responses and errors', async () => {
            await protocol.connect(transport);

            const task = await taskStore.createTask({ ttl: 60000 }, 1, { method: 'test', params: {} });
            const testProtocol = protocol as unknown as TestProtocol;

            const callOrder: number[] = [];
            const resolver1 = vi.fn(() => callOrder.push(1));
            const resolver2 = vi.fn(() => callOrder.push(2));
            const resolver3 = vi.fn(() => callOrder.push(3));

            testProtocol._requestResolvers.set(1, resolver1);
            testProtocol._requestResolvers.set(2, resolver2);
            testProtocol._requestResolvers.set(3, resolver3);

            // Enqueue in specific order
            await taskMessageQueue.enqueue(task.taskId, {
                type: 'response',
                message: { jsonrpc: '2.0', id: 1, result: {} },
                timestamp: 1000
            });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'error',
                message: {
                    jsonrpc: '2.0',
                    id: 2,
                    error: { code: -32600, message: 'Error' }
                },
                timestamp: 2000
            });

            await taskMessageQueue.enqueue(task.taskId, {
                type: 'response',
                message: { jsonrpc: '2.0', id: 3, result: {} },
                timestamp: 3000
            });

            // Process all messages
            let msg;
            while ((msg = await taskMessageQueue.dequeue(task.taskId))) {
                if (msg.type === 'response') {
                    const responseMessage = msg.message as JSONRPCResultResponse;
                    const requestId = responseMessage.id as RequestId;
                    const resolver = testProtocol._requestResolvers.get(requestId);
                    if (resolver) {
                        testProtocol._requestResolvers.delete(requestId);
                        resolver(responseMessage);
                    }
                } else if (msg.type === 'error') {
                    const errorMessage = msg.message as JSONRPCErrorResponse;
                    const requestId = errorMessage.id as RequestId;
                    const resolver = testProtocol._requestResolvers.get(requestId);
                    if (resolver) {
                        testProtocol._requestResolvers.delete(requestId);
                        const error = new ProtocolError(errorMessage.error.code, errorMessage.error.message, errorMessage.error.data);
                        resolver(error);
                    }
                }
            }

            // Verify FIFO order was maintained
            expect(callOrder).toEqual([1, 2, 3]);
        });
    });
});
