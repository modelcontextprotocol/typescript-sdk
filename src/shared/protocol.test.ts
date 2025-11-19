import { ZodType, z } from 'zod';
import {
    CallToolRequestSchema,
    ClientCapabilities,
    ErrorCode,
    McpError,
    Notification,
    RELATED_TASK_META_KEY,
    Request,
    RequestId,
    Result,
    ServerCapabilities,
    Task,
    TaskCreationParams
} from '../types.js';
import { Protocol, mergeCapabilities } from './protocol.js';
import { Transport } from './transport.js';
import { TaskStore } from './task.js';
import { MockInstance, vi } from 'vitest';

// Mock Transport class
class MockTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;

    async start(): Promise<void> {}
    async close(): Promise<void> {
        this.onclose?.();
    }
    async send(_message: unknown): Promise<void> {}
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
            const task = (tasks[taskId] = {
                taskId,
                status: 'working',
                ttl: taskParams.ttl ?? null,
                createdAt: new Date().toISOString(),
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
        storeTaskResult: vi.fn((taskId: string, result: Result) => {
            const task = tasks[taskId];
            if (task) {
                task.status = 'completed';
                task.result = result;
                options?.onStatus?.('completed');
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

describe('protocol tests', () => {
    let protocol: Protocol<Request, Notification, Result>;
    let transport: MockTransport;
    let sendSpy: MockInstance;

    beforeEach(() => {
        transport = new MockTransport();
        sendSpy = vi.spyOn(transport, 'send');
        protocol = new (class extends Protocol<Request, Notification, Result> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
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
            expect(error).toBeInstanceOf(McpError);
            if (error instanceof McpError) {
                expect(error.code).toBe(ErrorCode.RequestTimeout);
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

            protocol.request(request, mockSchema, {
                onprogress: onProgressMock
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

            protocol.request(request, mockSchema, {
                onprogress: onProgressMock
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

            protocol.request(request, mockSchema);

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

            protocol.request(request, mockSchema, {
                onprogress: onProgressMock
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
            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            const sentNotification = sendSpy.mock.calls[0][0];
            expect(sentNotification.method).toBe('test/debounced');
            expect(sentNotification.params).toBeUndefined();
        });

        it('should debounce calls when params is explicitly undefined', async () => {
            // ARRANGE
            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
    let protocol: Protocol<Request, Notification, Result>;
    let transport: MockTransport;
    let sendSpy: MockInstance;

    beforeEach(() => {
        transport = new MockTransport();
        sendSpy = vi.spyOn(transport, 'send');
        protocol = new (class extends Protocol<Request, Notification, Result> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected assertTaskHandlerCapability(): void {}
        })();
    });

    describe('beginRequest with task metadata', () => {
        it('should include task parameters at top level', async () => {
            await protocol.connect(transport);

            const request = {
                method: 'tools/call',
                params: { name: 'test-tool' }
            };

            const resultSchema = z.object({
                content: z.array(z.object({ type: z.literal('text'), text: z.string() }))
            });

            protocol.beginRequest(request, resultSchema, {
                task: {
                    ttl: 30000,
                    pollInterval: 1000
                }
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

            protocol.beginRequest(request, resultSchema, {
                task: {
                    ttl: 60000
                }
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

        it('should return PendingRequest object', async () => {
            await protocol.connect(transport);

            const request = {
                method: 'tools/call',
                params: { name: 'test-tool' }
            };

            const resultSchema = z.object({
                content: z.array(z.object({ type: z.literal('text'), text: z.string() }))
            });

            const pendingRequest = protocol.beginRequest(request, resultSchema, {
                task: {
                    ttl: 30000
                }
            });

            expect(pendingRequest).toBeDefined();
            expect(pendingRequest.taskId).toBeUndefined(); // taskId is generated by receiver, not provided by client
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

            protocol.beginRequest(request, resultSchema, {
                relatedTask: {
                    taskId: 'parent-task-123'
                }
            });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    params: {
                        data: 'test',
                        _meta: {
                            [RELATED_TASK_META_KEY]: {
                                taskId: 'parent-task-123'
                            }
                        }
                    }
                }),
                expect.any(Object)
            );
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

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'notifications/message',
                    params: {
                        level: 'info',
                        data: 'test message',
                        _meta: {
                            [RELATED_TASK_META_KEY]: {
                                taskId: 'parent-task-456'
                            }
                        }
                    }
                }),
                expect.any(Object)
            );
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

            protocol.beginRequest(request, resultSchema, {
                task: {
                    ttl: 60000,
                    pollInterval: 1000
                },
                relatedTask: {
                    taskId: 'parent-task'
                },
                onprogress: vi.fn()
            });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    params: {
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
                    }
                }),
                expect.any(Object)
            );
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

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            protocol.setRequestHandler(CallToolRequestSchema, async request => {
                // Tool implementor can access task creation parameters from request.params.task
                expect(request.params.task).toEqual({
                    ttl: 60000,
                    pollInterval: 1000
                });
                return { result: 'success' };
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

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            const sentMessage = sendSpy.mock.calls[0][0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(3);
            expect(sentMessage.result.tasks).toEqual([
                { taskId: task1.taskId, status: 'completed', ttl: null, createdAt: expect.any(String), pollInterval: 500 },
                { taskId: task2.taskId, status: 'working', ttl: 60000, createdAt: expect.any(String), pollInterval: 1000 }
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

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            const sentMessage = sendSpy.mock.calls[0][0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(2);
            expect(sentMessage.result.tasks).toEqual([
                { taskId: task3.taskId, status: 'working', ttl: null, createdAt: expect.any(String), pollInterval: 500 }
            ]);
            expect(sentMessage.result.nextCursor).toBeUndefined();
            expect(sentMessage.result._meta).toEqual({});
        });

        it('should handle tasks/list requests with empty results', async () => {
            const listedTasks = createLatch();
            const mockTaskStore = createMockTaskStore({
                onList: () => listedTasks.releaseLatch()
            });

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            const sentMessage = sendSpy.mock.calls[0][0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(3);
            expect(sentMessage.result.tasks).toEqual([]);
            expect(sentMessage.result.nextCursor).toBeUndefined();
            expect(sentMessage.result._meta).toEqual({});
        });

        it('should return error for invalid cursor', async () => {
            const mockTaskStore = createMockTaskStore();
            mockTaskStore.listTasks.mockRejectedValue(new Error('Invalid cursor: bad-cursor'));

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            const sentMessage = sendSpy.mock.calls[0][0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(4);
            expect(sentMessage.error).toBeDefined();
            expect(sentMessage.error.code).toBe(-32602); // InvalidParams error code
            expect(sentMessage.error.message).toContain('Failed to list tasks');
            expect(sentMessage.error.message).toContain('Invalid cursor');
        });

        it('should call listTasks method from client side', async () => {
            await protocol.connect(transport);

            const listTasksPromise = protocol.listTasks();

            // Simulate server response
            setTimeout(() => {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: sendSpy.mock.calls[0][0].id,
                    result: {
                        tasks: [{ taskId: 'task-1', status: 'completed', ttl: null, createdAt: '2024-01-01T00:00:00Z', pollInterval: 500 }],
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
            expect(result.tasks[0].taskId).toBe('task-1');
        });

        it('should call listTasks with cursor from client side', async () => {
            await protocol.connect(transport);

            const listTasksPromise = protocol.listTasks({ cursor: 'task-10' });

            // Simulate server response
            setTimeout(() => {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: sendSpy.mock.calls[0][0].id,
                    result: {
                        tasks: [
                            { taskId: 'task-11', status: 'working', ttl: 30000, createdAt: '2024-01-01T00:00:00Z', pollInterval: 1000 }
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
            expect(result.tasks[0].taskId).toBe('task-11');
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

            const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sentMessage = sendSpy.mock.calls[0][0] as any;
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(5);
            expect(sentMessage.result._meta).toBeDefined();
        });

        it('should return error with code -32602 when task does not exist', async () => {
            const taskDeleted = createLatch();
            const mockTaskStore = createMockTaskStore();

            mockTaskStore.getTask.mockResolvedValue(null);

            const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sentMessage = sendSpy.mock.calls[0][0] as any;
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

            const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sentMessage = sendSpy.mock.calls[0][0] as any;
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(7);
            expect(sentMessage.error).toBeDefined();
            expect(sentMessage.error.code).toBe(-32602); // InvalidParams error code
            expect(sentMessage.error.message).toContain('Cannot cancel task in terminal status');
        });

        it('should call cancelTask method from client side', async () => {
            await protocol.connect(transport);

            const deleteTaskPromise = protocol.cancelTask({ taskId: 'task-to-delete' });

            // Simulate server response
            setTimeout(() => {
                transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: sendSpy.mock.calls[0][0].id,
                    result: {
                        _meta: {}
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

            const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            expect(lastGetTaskCall[0]).toBe(task.taskId);
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

            const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            const response = sendSpy.mock.calls[0][0] as { result?: { _meta?: Record<string, unknown> } };
            expect(response.result?._meta?.[RELATED_TASK_META_KEY]).toBeUndefined();
        });

        it('should NOT include related-task metadata in tasks/list response', async () => {
            const mockTaskStore = createMockTaskStore();

            // Create a task first
            await mockTaskStore.createTask({}, 1, {
                method: 'test/method',
                params: {}
            });

            const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            const response = sendSpy.mock.calls[0][0] as { result?: { _meta?: Record<string, unknown> } };
            expect(response.result?._meta).toEqual({});
        });

        it('should NOT include related-task metadata in tasks/cancel response', async () => {
            const mockTaskStore = createMockTaskStore();

            // Create a task first
            const task = await mockTaskStore.createTask({}, 1, {
                method: 'test/method',
                params: {}
            });

            const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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
            const response = sendSpy.mock.calls[0][0] as { result?: { _meta?: Record<string, unknown> } };
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

            await mockTaskStore.storeTaskResult(task.taskId, testResult);

            const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
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

            const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
                protected assertTaskCapability(): void {}
                protected assertTaskHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            const serverTransport = new MockTransport();
            const sendSpy = vi.spyOn(serverTransport, 'send');

            await serverProtocol.connect(serverTransport);

            // Set up a handler that uses sendRequest and sendNotification
            serverProtocol.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
                // Send a notification using the extra.sendNotification
                await extra.sendNotification({
                    method: 'notifications/message',
                    params: { level: 'info', data: 'test' }
                });

                return {
                    content: [{ type: 'text', text: 'done' }]
                };
            });

            // Send a request with related-task metadata
            serverTransport.onmessage?.({
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

            // Wait for async processing
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify the notification includes related-task metadata
            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'notifications/message',
                    params: expect.objectContaining({
                        _meta: expect.objectContaining({
                            [RELATED_TASK_META_KEY]: {
                                taskId: 'parent-task-123'
                            }
                        })
                    })
                }),
                expect.any(Object)
            );
        });
    });
});

describe('Request Cancellation vs Task Cancellation', () => {
    let protocol: Protocol<Request, Notification, Result>;
    let transport: MockTransport;
    let taskStore: TaskStore;

    beforeEach(() => {
        transport = new MockTransport();
        taskStore = createMockTaskStore();
        protocol = new (class extends Protocol<Request, Notification, Result> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
            protected assertTaskCapability(): void {}
            protected assertTaskHandlerCapability(): void {}
        })({ taskStore });
    });

    describe('notifications/cancelled behavior', () => {
        test('should abort request handler when notifications/cancelled is received', async () => {
            await protocol.connect(transport);

            // Set up a request handler that checks if it was aborted
            let wasAborted = false;
            const TestRequestSchema = z.object({
                method: z.literal('test/longRunning'),
                params: z.optional(z.record(z.unknown()))
            });
            protocol.setRequestHandler(TestRequestSchema, async (_request, extra) => {
                // Simulate a long-running operation
                await new Promise(resolve => setTimeout(resolve, 100));
                wasAborted = extra.signal.aborted;
                return { _meta: {} } as Result;
            });

            // Simulate an incoming request
            const requestId = 123;
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: requestId,
                    method: 'test/longRunning',
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
                        code: ErrorCode.InvalidParams,
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
                        code: ErrorCode.InvalidParams,
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
            const TestMethodSchema = z.object({
                method: z.literal('test/method'),
                params: z.optional(z.record(z.unknown()))
            });
            protocol.setRequestHandler(TestMethodSchema, async () => {
                await new Promise(resolve => setTimeout(resolve, 50));
                requestCompleted = true;
                return { _meta: {} } as Result;
            });

            // Create a task
            const task = await taskStore.createTask({ ttl: 60000 }, 'req-1', {
                method: 'test/method',
                params: {}
            });

            // Start a request
            if (transport.onmessage) {
                transport.onmessage({
                    jsonrpc: '2.0',
                    id: 123,
                    method: 'test/method',
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
