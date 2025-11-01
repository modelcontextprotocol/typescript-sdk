import { ZodType, z } from 'zod';
import {
    ClientCapabilities,
    ErrorCode,
    McpError,
    Notification,
    RELATED_TASK_META_KEY,
    Request,
    Result,
    ServerCapabilities,
    TASK_META_KEY
} from '../types.js';
import { Protocol, mergeCapabilities } from './protocol.js';
import { Transport } from './transport.js';

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

describe('protocol tests', () => {
    let protocol: Protocol<Request, Notification, Result>;
    let transport: MockTransport;
    let sendSpy: jest.SpyInstance;

    beforeEach(() => {
        transport = new MockTransport();
        sendSpy = jest.spyOn(transport, 'send');
        protocol = new (class extends Protocol<Request, Notification, Result> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
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
        const oncloseMock = jest.fn();
        protocol.onclose = oncloseMock;
        await protocol.connect(transport);
        await transport.close();
        expect(oncloseMock).toHaveBeenCalled();
    });

    test('should not overwrite existing hooks when connecting transports', async () => {
        const oncloseMock = jest.fn();
        const onerrorMock = jest.fn();
        const onmessageMock = jest.fn();
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
            const onProgressMock = jest.fn();

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
            const onProgressMock = jest.fn();

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
            const onProgressMock = jest.fn();

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
            jest.useFakeTimers();
        });
        afterEach(() => {
            jest.useRealTimers();
        });

        test('should not reset timeout when resetTimeoutOnProgress is false', async () => {
            await protocol.connect(transport);
            const request = { method: 'example', params: {} };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = jest.fn();
            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                resetTimeoutOnProgress: false,
                onprogress: onProgressMock
            });

            jest.advanceTimersByTime(800);

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

            jest.advanceTimersByTime(201);

            await expect(requestPromise).rejects.toThrow('Request timed out');
        });

        test('should reset timeout when progress notification is received', async () => {
            await protocol.connect(transport);
            const request = { method: 'example', params: {} };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = jest.fn();
            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                resetTimeoutOnProgress: true,
                onprogress: onProgressMock
            });
            jest.advanceTimersByTime(800);
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
            jest.advanceTimersByTime(800);
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
            const onProgressMock = jest.fn();
            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                maxTotalTimeout: 150,
                resetTimeoutOnProgress: true,
                onprogress: onProgressMock
            });

            // First progress notification should work
            jest.advanceTimersByTime(80);
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
            jest.advanceTimersByTime(80);
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
            jest.advanceTimersByTime(101);
            await expect(requestPromise).rejects.toThrow('Request timed out');
        });

        test('should handle multiple progress notifications correctly', async () => {
            await protocol.connect(transport);
            const request = { method: 'example', params: {} };
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            const onProgressMock = jest.fn();
            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                resetTimeoutOnProgress: true,
                onprogress: onProgressMock
            });

            // Simulate multiple progress updates
            for (let i = 1; i <= 3; i++) {
                jest.advanceTimersByTime(800);
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
            const onProgressMock = jest.fn();

            const requestPromise = protocol.request(request, mockSchema, {
                timeout: 1000,
                onprogress: onProgressMock
            });

            jest.advanceTimersByTime(200);

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

            jest.advanceTimersByTime(200);

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
                feature: true
            },
            elicitation: {},
            roots: {
                newProp: true
            }
        };

        const merged = mergeCapabilities(base, additional);
        expect(merged).toEqual({
            sampling: {},
            elicitation: {},
            roots: {
                listChanged: true,
                newProp: true
            },
            experimental: {
                feature: true
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
                newProp: true
            }
        };

        const merged = mergeCapabilities(base, additional);
        expect(merged).toEqual({
            logging: {},
            prompts: {
                listChanged: true,
                newProp: true
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
    let sendSpy: jest.SpyInstance;

    beforeEach(() => {
        transport = new MockTransport();
        sendSpy = jest.spyOn(transport, 'send');
        protocol = new (class extends Protocol<Request, Notification, Result> {
            protected assertCapabilityForMethod(): void {}
            protected assertNotificationCapability(): void {}
            protected assertRequestHandlerCapability(): void {}
        })();
    });

    describe('beginRequest with task metadata', () => {
        it('should inject task metadata into _meta field', async () => {
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
                    taskId: 'my-task-123',
                    keepAlive: 30000
                }
            });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'tools/call',
                    params: {
                        name: 'test-tool',
                        _meta: {
                            [TASK_META_KEY]: {
                                taskId: 'my-task-123',
                                keepAlive: 30000
                            }
                        }
                    }
                }),
                expect.any(Object)
            );
        });

        it('should preserve existing _meta when adding task metadata', async () => {
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
                    taskId: 'my-task-456'
                }
            });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    params: {
                        name: 'test-tool',
                        _meta: {
                            customField: 'customValue',
                            [TASK_META_KEY]: {
                                taskId: 'my-task-456'
                            }
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
                    taskId: 'my-task-789'
                }
            });

            expect(pendingRequest).toBeDefined();
            expect(pendingRequest.taskId).toBe('my-task-789');
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
                    taskId: 'my-task-combined'
                },
                relatedTask: {
                    taskId: 'parent-task'
                },
                onprogress: jest.fn()
            });

            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    params: {
                        name: 'test-tool',
                        _meta: {
                            [TASK_META_KEY]: {
                                taskId: 'my-task-combined'
                            },
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
        it('should transition from submitted to working when handler starts', async () => {
            const mockTaskStore = {
                createTask: jest.fn().mockResolvedValue(undefined),
                getTask: jest.fn().mockResolvedValue(null),
                updateTaskStatus: jest.fn().mockResolvedValue(undefined),
                storeTaskResult: jest.fn().mockResolvedValue(undefined),
                getTaskResult: jest.fn().mockResolvedValue({ content: [] }),
                listTasks: jest.fn().mockResolvedValue({ tasks: [], nextCursor: undefined })
            };

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            protocol.setRequestHandler(z.object({ method: z.literal('test/method'), params: z.any() }), async () => ({
                result: 'success'
            }));

            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 1,
                method: 'test/method',
                params: {
                    _meta: {
                        [TASK_META_KEY]: {
                            taskId: 'test-task',
                            keepAlive: 60000
                        }
                    }
                }
            });

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockTaskStore.createTask).toHaveBeenCalledWith({ taskId: 'test-task', keepAlive: 60000 }, 1, {
                method: 'test/method',
                params: expect.any(Object)
            });
            expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('test-task', 'working');
        });

        it('should transition to input_required during extra.sendRequest', async () => {
            const mockTaskStore = {
                createTask: jest.fn().mockResolvedValue(undefined),
                getTask: jest.fn().mockResolvedValue(null),
                updateTaskStatus: jest.fn().mockResolvedValue(undefined),
                storeTaskResult: jest.fn().mockResolvedValue(undefined),
                getTaskResult: jest.fn().mockResolvedValue({ content: [] }),
                listTasks: jest.fn().mockResolvedValue({ tasks: [], nextCursor: undefined })
            };

            const responsiveTransport = new MockTransport();
            responsiveTransport.send = jest.fn().mockImplementation(async (message: unknown) => {
                if (
                    typeof message === 'object' &&
                    message !== null &&
                    'method' in message &&
                    'id' in message &&
                    message.method === 'nested/request' &&
                    responsiveTransport.onmessage
                ) {
                    setTimeout(() => {
                        responsiveTransport.onmessage?.({
                            jsonrpc: '2.0',
                            id: (message as { id: number }).id,
                            result: { nested: 'response' }
                        });
                    }, 5);
                }
            });

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(responsiveTransport);

            const capturedUpdateCalls: Array<{ taskId: string; status: string }> = [];
            mockTaskStore.updateTaskStatus.mockImplementation((taskId, status) => {
                capturedUpdateCalls.push({ taskId, status });
                return Promise.resolve();
            });

            protocol.setRequestHandler(z.object({ method: z.literal('test/method'), params: z.any() }), async (_request, extra) => {
                await extra.sendRequest({ method: 'nested/request', params: {} }, z.object({ nested: z.string() }));
                return { result: 'success' };
            });

            responsiveTransport.onmessage?.({
                jsonrpc: '2.0',
                id: 1,
                method: 'test/method',
                params: {
                    _meta: {
                        [TASK_META_KEY]: {
                            taskId: 'test-task',
                            keepAlive: 60000
                        }
                    }
                }
            });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(capturedUpdateCalls).toContainEqual({ taskId: 'test-task', status: 'working' });
            expect(capturedUpdateCalls).toContainEqual({ taskId: 'test-task', status: 'input_required' });

            const inputRequiredIndex = capturedUpdateCalls.findIndex(c => c.status === 'input_required');
            const workingCalls = capturedUpdateCalls.filter(c => c.status === 'working');
            expect(workingCalls).toHaveLength(2);

            let workingCount = 0;
            const secondWorkingIndex = capturedUpdateCalls.findIndex(c => {
                if (c.status === 'working') {
                    workingCount++;
                    return workingCount === 2;
                }
                return false;
            });
            expect(secondWorkingIndex).toBeGreaterThan(inputRequiredIndex);
        });

        it('should mark task as completed when storeTaskResult is called', async () => {
            const mockTaskStore = {
                createTask: jest.fn().mockResolvedValue(undefined),
                getTask: jest.fn().mockResolvedValue(null),
                updateTaskStatus: jest.fn().mockResolvedValue(undefined),
                storeTaskResult: jest.fn().mockResolvedValue(undefined),
                getTaskResult: jest.fn().mockResolvedValue({ content: [] }),
                listTasks: jest.fn().mockResolvedValue({ tasks: [], nextCursor: undefined })
            };

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            protocol.setRequestHandler(z.object({ method: z.literal('test/method'), params: z.any() }), async () => ({
                result: 'success'
            }));

            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 1,
                method: 'test/method',
                params: {
                    _meta: {
                        [TASK_META_KEY]: {
                            taskId: 'test-task',
                            keepAlive: 60000
                        }
                    }
                }
            });

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockTaskStore.storeTaskResult).toHaveBeenCalledWith('test-task', { result: 'success' });
        });

        it('should mark task as cancelled when notifications/cancelled is received', async () => {
            const mockTaskStore = {
                createTask: jest.fn().mockResolvedValue(undefined),
                getTask: jest.fn().mockResolvedValue({ taskId: 'test-task', status: 'working', keepAlive: null, pollFrequency: 500 }),
                updateTaskStatus: jest.fn().mockResolvedValue(undefined),
                storeTaskResult: jest.fn().mockResolvedValue(undefined),
                getTaskResult: jest.fn().mockResolvedValue({ content: [] }),
                listTasks: jest.fn().mockResolvedValue({ tasks: [], nextCursor: undefined })
            };

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            void protocol.request({ method: 'test/slow', params: {} }, z.object({ result: z.string() }), {
                task: { taskId: 'test-task', keepAlive: 60000 }
            });

            await new Promise(resolve => setTimeout(resolve, 10));

            transport.onmessage?.({
                jsonrpc: '2.0',
                method: 'notifications/cancelled',
                params: {
                    requestId: 0,
                    reason: 'User cancelled'
                }
            });

            await new Promise(resolve => setTimeout(resolve, 10));

            expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('test-task', 'cancelled');
        });

        it('should mark task as failed when updateTaskStatus to working fails', async () => {
            const mockTaskStore = {
                createTask: jest.fn().mockResolvedValue(undefined),
                getTask: jest.fn().mockResolvedValue(null),
                updateTaskStatus: jest.fn().mockRejectedValueOnce(new Error('Failed to update status')).mockResolvedValue(undefined),
                storeTaskResult: jest.fn().mockResolvedValue(undefined),
                getTaskResult: jest.fn().mockResolvedValue({ content: [] }),
                listTasks: jest.fn().mockResolvedValue({ tasks: [], nextCursor: undefined })
            };

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            protocol.setRequestHandler(z.object({ method: z.literal('test/method'), params: z.any() }), async () => ({
                result: 'success'
            }));

            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 1,
                method: 'test/method',
                params: {
                    _meta: {
                        [TASK_META_KEY]: {
                            taskId: 'test-task',
                            keepAlive: 60000
                        }
                    }
                }
            });

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('test-task', 'working');
            expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('test-task', 'failed', 'Failed to mark task as working');
        });
    });

    describe('listTasks', () => {
        it('should handle tasks/list requests and return tasks from TaskStore', async () => {
            const mockTaskStore = {
                createTask: jest.fn().mockResolvedValue(undefined),
                getTask: jest.fn().mockResolvedValue(null),
                updateTaskStatus: jest.fn().mockResolvedValue(undefined),
                storeTaskResult: jest.fn().mockResolvedValue(undefined),
                getTaskResult: jest.fn().mockResolvedValue({ content: [] }),
                listTasks: jest.fn().mockResolvedValue({
                    tasks: [
                        { taskId: 'task-1', status: 'completed', keepAlive: null, pollFrequency: 500 },
                        { taskId: 'task-2', status: 'working', keepAlive: 60000, pollFrequency: 1000 }
                    ],
                    nextCursor: 'task-2'
                })
            };

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            // Simulate receiving a tasks/list request
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 1,
                method: 'tasks/list',
                params: {}
            });

            await new Promise(resolve => setTimeout(resolve, 10));

            expect(mockTaskStore.listTasks).toHaveBeenCalledWith(undefined);
            const sentMessage = sendSpy.mock.calls[0][0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(1);
            expect(sentMessage.result.tasks).toEqual([
                { taskId: 'task-1', status: 'completed', keepAlive: null, pollFrequency: 500 },
                { taskId: 'task-2', status: 'working', keepAlive: 60000, pollFrequency: 1000 }
            ]);
            expect(sentMessage.result.nextCursor).toBe('task-2');
            expect(sentMessage.result._meta).toEqual({});
        });

        it('should handle tasks/list requests with cursor for pagination', async () => {
            const mockTaskStore = {
                createTask: jest.fn().mockResolvedValue(undefined),
                getTask: jest.fn().mockResolvedValue(null),
                updateTaskStatus: jest.fn().mockResolvedValue(undefined),
                storeTaskResult: jest.fn().mockResolvedValue(undefined),
                getTaskResult: jest.fn().mockResolvedValue({ content: [] }),
                listTasks: jest.fn().mockResolvedValue({
                    tasks: [{ taskId: 'task-3', status: 'submitted', keepAlive: null, pollFrequency: 500 }],
                    nextCursor: undefined
                })
            };

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
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

            await new Promise(resolve => setTimeout(resolve, 10));

            expect(mockTaskStore.listTasks).toHaveBeenCalledWith('task-2');
            const sentMessage = sendSpy.mock.calls[0][0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(2);
            expect(sentMessage.result.tasks).toEqual([{ taskId: 'task-3', status: 'submitted', keepAlive: null, pollFrequency: 500 }]);
            expect(sentMessage.result.nextCursor).toBeUndefined();
            expect(sentMessage.result._meta).toEqual({});
        });

        it('should handle tasks/list requests with empty results', async () => {
            const mockTaskStore = {
                createTask: jest.fn().mockResolvedValue(undefined),
                getTask: jest.fn().mockResolvedValue(null),
                updateTaskStatus: jest.fn().mockResolvedValue(undefined),
                storeTaskResult: jest.fn().mockResolvedValue(undefined),
                getTaskResult: jest.fn().mockResolvedValue({ content: [] }),
                listTasks: jest.fn().mockResolvedValue({
                    tasks: [],
                    nextCursor: undefined
                })
            };

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
            })({ taskStore: mockTaskStore });

            await protocol.connect(transport);

            // Simulate receiving a tasks/list request
            transport.onmessage?.({
                jsonrpc: '2.0',
                id: 3,
                method: 'tasks/list',
                params: {}
            });

            await new Promise(resolve => setTimeout(resolve, 10));

            expect(mockTaskStore.listTasks).toHaveBeenCalledWith(undefined);
            const sentMessage = sendSpy.mock.calls[0][0];
            expect(sentMessage.jsonrpc).toBe('2.0');
            expect(sentMessage.id).toBe(3);
            expect(sentMessage.result.tasks).toEqual([]);
            expect(sentMessage.result.nextCursor).toBeUndefined();
            expect(sentMessage.result._meta).toEqual({});
        });

        it('should return error for invalid cursor', async () => {
            const mockTaskStore = {
                createTask: jest.fn().mockResolvedValue(undefined),
                getTask: jest.fn().mockResolvedValue(null),
                updateTaskStatus: jest.fn().mockResolvedValue(undefined),
                storeTaskResult: jest.fn().mockResolvedValue(undefined),
                getTaskResult: jest.fn().mockResolvedValue({ content: [] }),
                listTasks: jest.fn().mockRejectedValue(new Error('Invalid cursor: bad-cursor'))
            };

            protocol = new (class extends Protocol<Request, Notification, Result> {
                protected assertCapabilityForMethod(): void {}
                protected assertNotificationCapability(): void {}
                protected assertRequestHandlerCapability(): void {}
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

            expect(mockTaskStore.listTasks).toHaveBeenCalledWith('bad-cursor');
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
                        tasks: [{ taskId: 'task-1', status: 'completed', keepAlive: null, pollFrequency: 500 }],
                        nextCursor: undefined,
                        _meta: {
                            [TASK_META_KEY]: expect.objectContaining({
                                taskId: expect.any(String)
                            })
                        }
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
                        tasks: [{ taskId: 'task-11', status: 'working', keepAlive: 30000, pollFrequency: 1000 }],
                        nextCursor: 'task-11',
                        _meta: {
                            [TASK_META_KEY]: expect.objectContaining({
                                taskId: expect.any(String)
                            })
                        }
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
});
