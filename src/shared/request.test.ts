import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PendingRequest } from './request.js';
import { Protocol } from './protocol.js';
import { Request, Notification, Result, GetTaskResult } from '../types.js';
import { z, ZodType } from 'zod';

// Mock Protocol class
class MockProtocol extends Protocol<Request, Notification, Result> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected assertTaskCapability(): void {}
    protected assertTaskHandlerCapability(): void {}

    // Expose methods for testing
    public mockGetTask = vi.fn();
    public mockGetTaskResult = vi.fn();

    async getTask(params: { taskId: string }): Promise<GetTaskResult> {
        return this.mockGetTask(params);
    }

    async getTaskResult<T>(params: { taskId: string }, _resultSchema: ZodType): Promise<T> {
        return this.mockGetTaskResult(params, _resultSchema) as Promise<T>;
    }
}

describe('PendingRequest', () => {
    let protocol: MockProtocol;
    const mockResultSchema = z.object({ result: z.string() });

    beforeEach(() => {
        protocol = new MockProtocol();
    });

    describe('input_required status handling', () => {
        it('should preemptively call tasks/result when input_required status is encountered', async () => {
            // Setup: Create a task that transitions to input_required
            const taskId = 'test-task-123';
            const expectedResult = { result: 'completed after input' };

            // Mock getTask to return input_required status
            protocol.mockGetTask.mockResolvedValueOnce({
                taskId,
                status: 'input_required',
                ttl: null,
                createdAt: new Date().toISOString(),
                pollInterval: 1000
            });

            // Mock getTaskResult to return the final result
            protocol.mockGetTaskResult.mockResolvedValueOnce(expectedResult);

            // Create a PendingRequest with a task ID
            const resultHandle = Promise.resolve(expectedResult);
            const pendingRequest = new PendingRequest(protocol, resultHandle, mockResultSchema, taskId, 5000);

            // Execute: Call result() which should trigger taskHandler
            const result = await pendingRequest.result({
                onTaskCreated: vi.fn(),
                onTaskStatus: vi.fn()
            });

            // Verify: getTask was called once
            expect(protocol.mockGetTask).toHaveBeenCalledTimes(1);
            expect(protocol.mockGetTask).toHaveBeenCalledWith({ taskId });

            // Verify: getTaskResult was called immediately after detecting input_required
            expect(protocol.mockGetTaskResult).toHaveBeenCalledTimes(1);
            expect(protocol.mockGetTaskResult).toHaveBeenCalledWith({ taskId }, mockResultSchema);

            // Verify: Result is correct
            expect(result).toEqual(expectedResult);
        });

        it('should call onTaskStatus before calling tasks/result for input_required', async () => {
            const taskId = 'test-task-456';
            const expectedResult = { result: 'completed' };
            const onTaskStatus = vi.fn();

            const inputRequiredTask: GetTaskResult = {
                taskId,
                status: 'input_required',
                ttl: null,
                createdAt: new Date().toISOString(),
                pollInterval: 1000
            };

            protocol.mockGetTask.mockResolvedValueOnce(inputRequiredTask);
            protocol.mockGetTaskResult.mockResolvedValueOnce(expectedResult);

            const resultHandle = Promise.resolve(expectedResult);
            const pendingRequest = new PendingRequest(protocol, resultHandle, mockResultSchema, taskId, 5000);

            await pendingRequest.result({
                onTaskCreated: vi.fn(),
                onTaskStatus
            });

            // Verify: onTaskStatus was called with the input_required task
            expect(onTaskStatus).toHaveBeenCalledWith(inputRequiredTask);
            expect(onTaskStatus).toHaveBeenCalledBefore(protocol.mockGetTaskResult);
        });

        it('should not poll again after encountering input_required status', async () => {
            const taskId = 'test-task-789';
            const expectedResult = { result: 'completed' };

            protocol.mockGetTask.mockResolvedValueOnce({
                taskId,
                status: 'input_required',
                ttl: null,
                createdAt: new Date().toISOString(),
                pollInterval: 100 // Short interval to test that we don't wait
            });

            protocol.mockGetTaskResult.mockResolvedValueOnce(expectedResult);

            const resultHandle = Promise.resolve(expectedResult);
            const pendingRequest = new PendingRequest(protocol, resultHandle, mockResultSchema, taskId, 5000);

            const startTime = Date.now();
            await pendingRequest.result({
                onTaskCreated: vi.fn(),
                onTaskStatus: vi.fn()
            });
            const endTime = Date.now();

            // Verify: getTask was only called once (no polling)
            expect(protocol.mockGetTask).toHaveBeenCalledTimes(1);

            // Verify: The operation completed quickly without waiting for pollInterval
            expect(endTime - startTime).toBeLessThan(100);
        });

        it('should continue normal polling for working status before input_required', async () => {
            const taskId = 'test-task-abc';
            const expectedResult = { result: 'completed' };

            // First poll: working status
            protocol.mockGetTask.mockResolvedValueOnce({
                taskId,
                status: 'working',
                ttl: null,
                createdAt: new Date().toISOString(),
                pollInterval: 10
            });

            // Second poll: input_required status
            protocol.mockGetTask.mockResolvedValueOnce({
                taskId,
                status: 'input_required',
                ttl: null,
                createdAt: new Date().toISOString(),
                pollInterval: 10
            });

            protocol.mockGetTaskResult.mockResolvedValueOnce(expectedResult);

            const resultHandle = Promise.resolve(expectedResult);
            const pendingRequest = new PendingRequest(protocol, resultHandle, mockResultSchema, taskId, 5000);

            await pendingRequest.result({
                onTaskCreated: vi.fn(),
                onTaskStatus: vi.fn()
            });

            // Verify: getTask was called twice (once for working, once for input_required)
            expect(protocol.mockGetTask).toHaveBeenCalledTimes(2);

            // Verify: getTaskResult was called after input_required was detected
            expect(protocol.mockGetTaskResult).toHaveBeenCalledTimes(1);
        });

        it('should handle terminal status normally without input_required', async () => {
            const taskId = 'test-task-def';
            const expectedResult = { result: 'completed' };

            // Task is already completed
            protocol.mockGetTask.mockResolvedValueOnce({
                taskId,
                status: 'completed',
                ttl: null,
                createdAt: new Date().toISOString(),
                pollInterval: 1000
            });

            protocol.mockGetTaskResult.mockResolvedValueOnce(expectedResult);

            const resultHandle = Promise.resolve(expectedResult);
            const pendingRequest = new PendingRequest(protocol, resultHandle, mockResultSchema, taskId, 5000);

            await pendingRequest.result({
                onTaskCreated: vi.fn(),
                onTaskStatus: vi.fn()
            });

            // Verify: Normal flow - getTask once, then getTaskResult
            expect(protocol.mockGetTask).toHaveBeenCalledTimes(1);
            expect(protocol.mockGetTaskResult).toHaveBeenCalledTimes(1);
        });
    });

    describe('normal task polling', () => {
        it('should poll until terminal status is reached', async () => {
            const taskId = 'test-task-polling';
            const expectedResult = { result: 'completed' };

            // First poll: working
            protocol.mockGetTask.mockResolvedValueOnce({
                taskId,
                status: 'working',
                ttl: null,
                createdAt: new Date().toISOString(),
                pollInterval: 10
            });

            // Second poll: still working
            protocol.mockGetTask.mockResolvedValueOnce({
                taskId,
                status: 'working',
                ttl: null,
                createdAt: new Date().toISOString(),
                pollInterval: 10
            });

            // Third poll: completed
            protocol.mockGetTask.mockResolvedValueOnce({
                taskId,
                status: 'completed',
                ttl: null,
                createdAt: new Date().toISOString(),
                pollInterval: 10
            });

            protocol.mockGetTaskResult.mockResolvedValueOnce(expectedResult);

            const resultHandle = Promise.resolve(expectedResult);
            const pendingRequest = new PendingRequest(protocol, resultHandle, mockResultSchema, taskId, 5000);

            await pendingRequest.result({
                onTaskCreated: vi.fn(),
                onTaskStatus: vi.fn()
            });

            // Verify: getTask was called three times
            expect(protocol.mockGetTask).toHaveBeenCalledTimes(3);

            // Verify: getTaskResult was called once after terminal status
            expect(protocol.mockGetTaskResult).toHaveBeenCalledTimes(1);
        });
    });
});
