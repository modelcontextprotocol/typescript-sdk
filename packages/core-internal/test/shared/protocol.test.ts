import type { MockInstance } from 'vitest';
import { vi } from 'vitest';
import * as z from 'zod/v4';
import type { ZodType } from 'zod/v4';

import type { BaseContext } from '../../src/shared/protocol';
import { mergeCapabilities, Protocol, setNegotiatedProtocolVersion } from '../../src/shared/protocol';
import type { Transport, TransportSendOptions } from '../../src/shared/transport';
import type {
    ClientCapabilities,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    Notification,
    Request,
    RequestId,
    Result,
    ServerCapabilities
} from '../../src/types/index';
import { ProtocolError, ProtocolErrorCode } from '../../src/types/index';
import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors';
import { InMemoryTransport } from '../../src/util/inMemory';
import { rev2025Codec } from '../../src/wire/rev2025-11-25/codec';

// Test Protocol subclass for testing
class TestProtocolImpl extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

function createTestProtocol(): TestProtocolImpl {
    return new TestProtocolImpl();
}

// Type helper for accessing private/protected Protocol properties in tests
interface TestProtocolInternals {
    _responseHandlers: Map<RequestId, (response: JSONRPCResultResponse | Error) => void>;
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

/**
 * Helper to call the protected _requestWithSchema method from tests that
 * use custom method names not present in RequestMethod.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function testRequest(proto: Protocol<BaseContext>, request: Request, resultSchema: ZodType, options?: any) {
    return (
        proto as unknown as { _requestWithSchema: (request: Request, resultSchema: ZodType, options?: unknown) => Promise<unknown> }
    )._requestWithSchema(request, resultSchema, options);
}

describe('protocol tests', () => {
    let protocol: Protocol<BaseContext>;
    let transport: MockTransport;
    let sendSpy: MockInstance;

    beforeEach(() => {
        transport = new MockTransport();
        sendSpy = vi.spyOn(transport, 'send');
        protocol = createTestProtocol();
    });

    test('should throw a timeout error if the request exceeds the timeout', async () => {
        await protocol.connect(transport);
        const request = { method: 'example', params: {} };
        try {
            const mockSchema: ZodType<{ result: string }> = z.object({
                result: z.string()
            });
            await testRequest(protocol, request, mockSchema, {
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

    test('should abort in-flight request handlers when the connection is closed', async () => {
        await protocol.connect(transport);

        let abortReason: unknown;
        let handlerStarted = false;
        const handlerDone = new Promise<void>(resolve => {
            protocol.setRequestHandler('ping', async (_request, ctx) => {
                handlerStarted = true;
                await new Promise<void>(resolveInner => {
                    ctx.mcpReq.signal.addEventListener('abort', () => {
                        abortReason = ctx.mcpReq.signal.reason;
                        resolveInner();
                    });
                });
                resolve();
                return {};
            });
        });

        transport.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });

        await vi.waitFor(() => expect(handlerStarted).toBe(true));

        await transport.close();
        await handlerDone;

        expect(abortReason).toBeInstanceOf(SdkError);
        expect((abortReason as SdkError).code).toBe(SdkErrorCode.ConnectionClosed);
    });

    test('should remove abort listener from caller signal when request settles', async () => {
        await protocol.connect(transport);

        const controller = new AbortController();
        const addSpy = vi.spyOn(controller.signal, 'addEventListener');
        const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

        const mockSchema = z.object({ result: z.string() });
        const reqPromise = testRequest(protocol, { method: 'example', params: {} }, mockSchema, {
            signal: controller.signal
        });

        expect(addSpy).toHaveBeenCalledTimes(1);
        const listener = addSpy.mock.calls[0]![1];

        transport.onmessage?.({ jsonrpc: '2.0', id: 0, result: { result: 'ok' } });
        await reqPromise;

        expect(removeSpy).toHaveBeenCalledWith('abort', listener);
    });

    test('should not accumulate abort listeners when reusing a signal across requests', async () => {
        await protocol.connect(transport);

        const controller = new AbortController();
        const addSpy = vi.spyOn(controller.signal, 'addEventListener');
        const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

        const mockSchema = z.object({ result: z.string() });
        for (let i = 0; i < 5; i++) {
            const reqPromise = testRequest(protocol, { method: 'example', params: {} }, mockSchema, {
                signal: controller.signal
            });
            transport.onmessage?.({ jsonrpc: '2.0', id: i, result: { result: 'ok' } });
            await reqPromise;
        }

        expect(addSpy).toHaveBeenCalledTimes(5);
        expect(removeSpy).toHaveBeenCalledTimes(5);
    });

    test('should remove abort listener when request rejects', async () => {
        await protocol.connect(transport);

        const controller = new AbortController();
        const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

        const mockSchema = z.object({ result: z.string() });
        await expect(
            testRequest(protocol, { method: 'example', params: {} }, mockSchema, {
                signal: controller.signal,
                timeout: 0
            })
        ).rejects.toThrow();

        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
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
            void testRequest(protocol, request, mockSchema, {
                onprogress: onProgressMock
            }).catch(() => {
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
            void testRequest(protocol, request, mockSchema, {
                onprogress: onProgressMock
            }).catch(() => {
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
            void testRequest(protocol, request, mockSchema).catch(() => {
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
            void testRequest(protocol, request, mockSchema, {
                onprogress: onProgressMock
            }).catch(() => {
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
            const requestPromise = testRequest(protocol, request, mockSchema, {
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
            const requestPromise = testRequest(protocol, request, mockSchema, {
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
            const requestPromise = testRequest(protocol, request, mockSchema, {
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
            const requestPromise = testRequest(protocol, request, mockSchema, {
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
            const requestPromise = testRequest(protocol, request, mockSchema, {
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

            const requestPromise = testRequest(protocol, request, mockSchema, {
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
            protocol = new TestProtocolImpl({ debouncedNotificationMethods: ['test/debounced_with_params'] });
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
            protocol = new TestProtocolImpl({ debouncedNotificationMethods: ['test/debounced_with_options'] });
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
            protocol = new TestProtocolImpl({ debouncedNotificationMethods: ['test/debounced'] });
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
            protocol = new TestProtocolImpl({ debouncedNotificationMethods: ['test/debounced'] });
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
            protocol = new TestProtocolImpl({ debouncedNotificationMethods: ['test/debounced'] });
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
            protocol = new TestProtocolImpl({ debouncedNotificationMethods: ['test/debounced'] }); // Configure for a different method
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
            protocol = new TestProtocolImpl({ debouncedNotificationMethods: ['test/debounced'] });
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
    });

    // Spec basic/patterns/cancellation §Transport-Specific (2026-07-28): on a
    // per-request-stream transport (Streamable HTTP), closing that stream IS
    // the cancel signal — no `notifications/cancelled` is sent. Legacy era and
    // single-channel transports keep the `notifications/cancelled` POST path.
    describe('outbound request cancellation: stream-close vs notifications/cancelled', () => {
        /** Mock transport that records the requestSignal it was handed and every outbound message. */
        class PerRequestStreamTransport extends MockTransport {
            readonly hasPerRequestStream = true;
            sent: JSONRPCMessage[] = [];
            lastRequestSignal: AbortSignal | undefined;
            override async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
                this.sent.push(message);
                this.lastRequestSignal = options?.requestSignal;
            }
        }

        const cancelledSent = (sent: JSONRPCMessage[]): JSONRPCMessage[] =>
            sent.filter(m => 'method' in m && m.method === 'notifications/cancelled');

        test('modern era + per-request-stream transport: abort closes the stream, NO notifications/cancelled', async () => {
            const tx = new PerRequestStreamTransport();
            const proto = createTestProtocol();
            await proto.connect(tx);
            setNegotiatedProtocolVersion(proto, '2026-07-28');

            const ac = new AbortController();
            const pending = testRequest(proto, { method: 'example', params: {} }, z.object({}), { signal: ac.signal });

            // The transport was handed a per-request requestSignal.
            expect(tx.lastRequestSignal).toBeInstanceOf(AbortSignal);
            expect(tx.lastRequestSignal?.aborted).toBe(false);

            ac.abort('user cancel');
            await expect(pending).rejects.toThrow();

            // Stream-close IS the signal: requestSignal aborted, no cancelled notification on the wire.
            expect(tx.lastRequestSignal?.aborted).toBe(true);
            expect(cancelledSent(tx.sent)).toHaveLength(0);
        });

        test('modern era + single-channel transport (no hasPerRequestStream): POSTs notifications/cancelled', async () => {
            // stdio / in-memory shape: hasPerRequestStream is undefined.
            const sent: JSONRPCMessage[] = [];
            const tx = new MockTransport();
            tx.send = async (m: JSONRPCMessage, _opts?: TransportSendOptions) => {
                sent.push(m);
            };
            const proto = createTestProtocol();
            await proto.connect(tx);
            setNegotiatedProtocolVersion(proto, '2026-07-28');

            const ac = new AbortController();
            const pending = testRequest(proto, { method: 'example', params: {} }, z.object({}), { signal: ac.signal });
            ac.abort('user cancel');
            await expect(pending).rejects.toThrow();

            // stdio MUST send notifications/cancelled (spec).
            expect(cancelledSent(sent)).toHaveLength(1);
        });

        test('legacy era + per-request-stream transport: behavior unchanged — POSTs notifications/cancelled, no requestSignal', async () => {
            const tx = new PerRequestStreamTransport();
            const proto = createTestProtocol();
            await proto.connect(tx);
            setNegotiatedProtocolVersion(proto, '2025-11-25');

            const ac = new AbortController();
            const pending = testRequest(proto, { method: 'example', params: {} }, z.object({}), { signal: ac.signal });

            // Legacy path is byte-identical to before: no requestSignal threaded.
            expect(tx.lastRequestSignal).toBeUndefined();

            ac.abort('user cancel');
            await expect(pending).rejects.toThrow();

            expect(cancelledSent(tx.sent)).toHaveLength(1);
        });

        test('modern era + per-request-stream transport: timeout aborts the stream, NO notifications/cancelled', async () => {
            const tx = new PerRequestStreamTransport();
            const proto = createTestProtocol();
            await proto.connect(tx);
            setNegotiatedProtocolVersion(proto, '2026-07-28');

            const pending = testRequest(proto, { method: 'example', params: {} }, z.object({}), { timeout: 0 });
            await expect(pending).rejects.toThrow();

            expect(tx.lastRequestSignal?.aborted).toBe(true);
            expect(cancelledSent(tx.sent)).toHaveLength(0);
        });
    });
});

// (2025-11 experimental test suites removed under SEP-2663; see git history.)
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

describe('codec-seam hardening in the protocol funnels', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const flush = () => new Promise(resolve => setTimeout(resolve, 10));

    test('a throw inside codec.encodeResult answers −32603 on the wire — the peer is never stranded', async () => {
        const [peerTx, protocolTx] = InMemoryTransport.createLinkedPair();
        const sent: JSONRPCMessage[] = [];
        peerTx.onmessage = message => void sent.push(message);
        await peerTx.start();

        const protocol = createTestProtocol();
        const errors: Error[] = [];
        protocol.onerror = error => void errors.push(error);
        protocol.setRequestHandler('acme/op', { params: z.looseObject({}) }, () => ({ ok: true }) as Result);
        await protocol.connect(protocolTx);

        // The encode hop is the only throw-capable step between handler
        // success and the transport send (and it grows stamping content in
        // M3.2). Force it to throw once.
        vi.spyOn(rev2025Codec, 'encodeResult').mockImplementationOnce(() => {
            throw new Error('stamp exploded');
        });

        await peerTx.send({ jsonrpc: '2.0', id: 1, method: 'acme/op', params: {} });
        await flush();

        expect(sent).toHaveLength(1);
        expect((sent[0] as JSONRPCErrorResponse).error).toMatchObject({ code: ProtocolErrorCode.InternalError });
        // Surfaced locally too.
        expect(errors.some(error => error.message.includes('Failed to encode result'))).toBe(true);

        // The connection stays serviceable: the next request round-trips.
        await peerTx.send({ jsonrpc: '2.0', id: 2, method: 'acme/op', params: {} });
        await flush();
        expect(sent).toHaveLength(2);
        expect((sent[1] as JSONRPCResultResponse).result).toMatchObject({ ok: true });

        await protocol.close();
    });

    test('a synchronous throw out of codec.decodeResult rejects the request instead of escaping into transport.onmessage', async () => {
        const [protocolTx, peerTx] = InMemoryTransport.createLinkedPair();
        peerTx.onmessage = message => {
            const request = message as JSONRPCRequest;
            void peerTx.send({ jsonrpc: '2.0', id: request.id, result: {} });
        };
        await peerTx.start();

        const protocol = createTestProtocol();
        await protocol.connect(protocolTx);

        // The response callback runs synchronously inside _onresponse; an
        // unguarded throw here would propagate into the transport instead of
        // failing the request. (The concrete production vector is the 2026
        // codec's method-keyed schema lookup — see the own-key guard in
        // rev2026-07-28/codec.ts.)
        vi.spyOn(rev2025Codec, 'decodeResult').mockImplementationOnce(() => {
            throw new Error('decode exploded');
        });

        await expect(protocol.request({ method: 'ping' })).rejects.toThrow('decode exploded');

        await protocol.close();
    });
});

describe('inbound validation precedence: −32601 outranks envelope −32602', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const flush = () => new Promise(resolve => setTimeout(resolve, 10));

    async function wireWithFailingEnvelope(setup?: (protocol: TestProtocolImpl) => void) {
        const [peerTx, protocolTx] = InMemoryTransport.createLinkedPair();
        const sent: JSONRPCMessage[] = [];
        peerTx.onmessage = message => void sent.push(message);
        await peerTx.start();

        const protocol = createTestProtocol();
        setup?.(protocol);
        await protocol.connect(protocolTx);

        // Force the era's envelope check to fail for every request, so the
        // test pins WHERE in the ladder it runs, independent of era wiring.
        vi.spyOn(rev2025Codec, 'checkInboundEnvelope').mockImplementation(() => 'Request is missing the required _meta envelope');

        return { peerTx, sent, flush };
    }

    test('a genuinely unknown method answers −32601 even when the envelope check would also fail', async () => {
        const { peerTx, sent } = await wireWithFailingEnvelope();

        await peerTx.send({ jsonrpc: '2.0', id: 1, method: 'acme/no-such-method', params: {} });
        await flush();

        expect(sent).toHaveLength(1);
        expect((sent[0] as JSONRPCErrorResponse).error).toMatchObject({
            code: ProtocolErrorCode.MethodNotFound,
            message: 'Method not found'
        });
    });

    test('a served method still answers −32602 when the envelope check fails', async () => {
        const { peerTx, sent } = await wireWithFailingEnvelope(protocol => {
            protocol.setRequestHandler('acme/known', { params: z.looseObject({}) }, () => ({}) as Result);
        });

        await peerTx.send({ jsonrpc: '2.0', id: 1, method: 'acme/known', params: {} });
        await flush();

        expect(sent).toHaveLength(1);
        expect((sent[0] as JSONRPCErrorResponse).error).toMatchObject({
            code: ProtocolErrorCode.InvalidParams,
            message: 'Request is missing the required _meta envelope'
        });
    });
});

describe('inbound protocol-version mismatch (−32022): the error data lists every supported version', () => {
    const flush = () => new Promise(resolve => setTimeout(resolve, 10));

    test('a request classified for a protocol version this connection does not serve is rejected with the full supported list', async () => {
        const supportedProtocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26'];
        const [peerTx, protocolTx] = InMemoryTransport.createLinkedPair();
        const sent: JSONRPCMessage[] = [];
        peerTx.onmessage = message => void sent.push(message);
        await peerTx.start();

        const protocol = new TestProtocolImpl({ supportedProtocolVersions });
        const errors: Error[] = [];
        protocol.onerror = error => void errors.push(error);
        await protocol.connect(protocolTx);

        // Deliver a request whose transport-edge classification names a
        // protocol version this connection does not serve. The rejection's
        // `data.supported` must list every protocol version the receiver
        // supports — not just the version the connection is on — so the peer
        // can pick a mutually supported version from the error alone.
        protocolTx.onmessage?.(
            { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage,
            // The in-memory transport's onmessage declares the narrower
            // pre-classification extra type; the protocol layer reads the
            // full MessageExtraInfo (same cast as the era-gate suite).
            { classification: { era: 'modern' } } as never
        );
        await flush();

        expect(sent).toHaveLength(1);
        const error = (sent[0] as JSONRPCErrorResponse).error as {
            code: number;
            message: string;
            data?: { supported?: string[]; requested?: string };
        };
        expect(error.code).toBe(-32022);
        expect(error.message).toContain('Unsupported protocol version');
        expect(error.data?.supported).toEqual(supportedProtocolVersions);
        expect(error.data?.requested).toBe('2026-07-28');

        await protocol.close();
    });
});
