import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueuedMessage } from '../../src/experimental/tasks/interfaces.js';
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from '../../src/experimental/tasks/stores/in-memory.js';
import type { Request, TaskCreationParams } from '../../src/types/types.js';

describe('InMemoryTaskStore', () => {
    let store: InMemoryTaskStore;

    beforeEach(() => {
        store = new InMemoryTaskStore();
    });

    afterEach(() => {
        store.cleanup();
    });

    describe('createTask', () => {
        it('should create a new task with working status', async () => {
            const taskParams: TaskCreationParams = {
                ttl: 60000
            };
            const request: Request = {
                method: 'tools/call',
                params: { name: 'test-tool' }
            };

            const task = await store.createTask(taskParams, 123, request);

            expect(task).toBeDefined();
            expect(task.taskId).toBeDefined();
            expect(typeof task.taskId).toBe('string');
            expect(task.taskId.length).toBeGreaterThan(0);
            expect(task.status).toBe('working');
            expect(task.ttl).toBe(60000);
            expect(task.pollInterval).toBeDefined();
            expect(task.createdAt).toBeDefined();
            expect(new Date(task.createdAt).getTime()).toBeGreaterThan(0);
        });

        it('should create task without ttl', async () => {
            const taskParams: TaskCreationParams = {};
            const request: Request = {
                method: 'tools/call',
                params: {}
            };

            const task = await store.createTask(taskParams, 456, request);

            expect(task).toBeDefined();
            expect(task.ttl).toBeNull();
        });

        it('should generate unique taskIds', async () => {
            const taskParams: TaskCreationParams = {};
            const request: Request = {
                method: 'tools/call',
                params: {}
            };

            const task1 = await store.createTask(taskParams, 789, request);
            const task2 = await store.createTask(taskParams, 790, request);

            expect(task1.taskId).not.toBe(task2.taskId);
        });
    });

    describe('getTask', () => {
        it('should return null for non-existent task', async () => {
            const task = await store.getTask('non-existent');
            expect(task).toBeNull();
        });

        it('should return task state', async () => {
            const taskParams: TaskCreationParams = {};
            const request: Request = {
                method: 'tools/call',
                params: {}
            };

            const createdTask = await store.createTask(taskParams, 111, request);
            await store.updateTaskStatus(createdTask.taskId, 'working');

            const task = await store.getTask(createdTask.taskId);
            expect(task).toBeDefined();
            expect(task?.status).toBe('working');
        });
    });

    describe('updateTaskStatus', () => {
        let taskId: string;

        beforeEach(async () => {
            const taskParams: TaskCreationParams = {};
            const createdTask = await store.createTask(taskParams, 222, {
                method: 'tools/call',
                params: {}
            });
            taskId = createdTask.taskId;
        });

        it('should keep task status as working', async () => {
            const task = await store.getTask(taskId);
            expect(task?.status).toBe('working');
        });

        it('should update task status to input_required', async () => {
            await store.updateTaskStatus(taskId, 'input_required');

            const task = await store.getTask(taskId);
            expect(task?.status).toBe('input_required');
        });

        it('should update task status to completed', async () => {
            await store.updateTaskStatus(taskId, 'completed');

            const task = await store.getTask(taskId);
            expect(task?.status).toBe('completed');
        });

        it('should update task status to failed with error', async () => {
            await store.updateTaskStatus(taskId, 'failed', 'Something went wrong');

            const task = await store.getTask(taskId);
            expect(task?.status).toBe('failed');
            expect(task?.statusMessage).toBe('Something went wrong');
        });

        it('should update task status to cancelled', async () => {
            await store.updateTaskStatus(taskId, 'cancelled');

            const task = await store.getTask(taskId);
            expect(task?.status).toBe('cancelled');
        });

        it('should throw if task not found', async () => {
            await expect(store.updateTaskStatus('non-existent', 'working')).rejects.toThrow('Task with ID non-existent not found');
        });

        describe('status lifecycle validation', () => {
            it('should allow transition from working to input_required', async () => {
                await store.updateTaskStatus(taskId, 'input_required');
                const task = await store.getTask(taskId);
                expect(task?.status).toBe('input_required');
            });

            it('should allow transition from working to completed', async () => {
                await store.updateTaskStatus(taskId, 'completed');
                const task = await store.getTask(taskId);
                expect(task?.status).toBe('completed');
            });

            it('should allow transition from working to failed', async () => {
                await store.updateTaskStatus(taskId, 'failed');
                const task = await store.getTask(taskId);
                expect(task?.status).toBe('failed');
            });

            it('should allow transition from working to cancelled', async () => {
                await store.updateTaskStatus(taskId, 'cancelled');
                const task = await store.getTask(taskId);
                expect(task?.status).toBe('cancelled');
            });

            it('should allow transition from input_required to working', async () => {
                await store.updateTaskStatus(taskId, 'input_required');
                await store.updateTaskStatus(taskId, 'working');
                const task = await store.getTask(taskId);
                expect(task?.status).toBe('working');
            });

            it('should allow transition from input_required to completed', async () => {
                await store.updateTaskStatus(taskId, 'input_required');
                await store.updateTaskStatus(taskId, 'completed');
                const task = await store.getTask(taskId);
                expect(task?.status).toBe('completed');
            });

            it('should allow transition from input_required to failed', async () => {
                await store.updateTaskStatus(taskId, 'input_required');
                await store.updateTaskStatus(taskId, 'failed');
                const task = await store.getTask(taskId);
                expect(task?.status).toBe('failed');
            });

            it('should allow transition from input_required to cancelled', async () => {
                await store.updateTaskStatus(taskId, 'input_required');
                await store.updateTaskStatus(taskId, 'cancelled');
                const task = await store.getTask(taskId);
                expect(task?.status).toBe('cancelled');
            });

            it('should reject transition from completed to any other status', async () => {
                await store.updateTaskStatus(taskId, 'completed');
                await expect(store.updateTaskStatus(taskId, 'working')).rejects.toThrow('Cannot update task');
                await expect(store.updateTaskStatus(taskId, 'input_required')).rejects.toThrow('Cannot update task');
                await expect(store.updateTaskStatus(taskId, 'failed')).rejects.toThrow('Cannot update task');
                await expect(store.updateTaskStatus(taskId, 'cancelled')).rejects.toThrow('Cannot update task');
            });

            it('should reject transition from failed to any other status', async () => {
                await store.updateTaskStatus(taskId, 'failed');
                await expect(store.updateTaskStatus(taskId, 'working')).rejects.toThrow('Cannot update task');
                await expect(store.updateTaskStatus(taskId, 'input_required')).rejects.toThrow('Cannot update task');
                await expect(store.updateTaskStatus(taskId, 'completed')).rejects.toThrow('Cannot update task');
                await expect(store.updateTaskStatus(taskId, 'cancelled')).rejects.toThrow('Cannot update task');
            });

            it('should reject transition from cancelled to any other status', async () => {
                await store.updateTaskStatus(taskId, 'cancelled');
                await expect(store.updateTaskStatus(taskId, 'working')).rejects.toThrow('Cannot update task');
                await expect(store.updateTaskStatus(taskId, 'input_required')).rejects.toThrow('Cannot update task');
                await expect(store.updateTaskStatus(taskId, 'completed')).rejects.toThrow('Cannot update task');
                await expect(store.updateTaskStatus(taskId, 'failed')).rejects.toThrow('Cannot update task');
            });
        });
    });

    describe('storeTaskResult', () => {
        let taskId: string;

        beforeEach(async () => {
            const taskParams: TaskCreationParams = {
                ttl: 60000
            };
            const createdTask = await store.createTask(taskParams, 333, {
                method: 'tools/call',
                params: {}
            });
            taskId = createdTask.taskId;
        });

        it('should store task result and set status to completed', async () => {
            const result = {
                content: [{ type: 'text' as const, text: 'Success!' }]
            };

            await store.storeTaskResult(taskId, 'completed', result);

            const task = await store.getTask(taskId);
            expect(task?.status).toBe('completed');

            const storedResult = await store.getTaskResult(taskId);
            expect(storedResult).toEqual(result);
        });

        it('should throw if task not found', async () => {
            await expect(store.storeTaskResult('non-existent', 'completed', {})).rejects.toThrow('Task with ID non-existent not found');
        });

        it('should reject storing result for task already in completed status', async () => {
            // First complete the task
            const firstResult = {
                content: [{ type: 'text' as const, text: 'First result' }]
            };
            await store.storeTaskResult(taskId, 'completed', firstResult);

            // Try to store result again (should fail)
            const secondResult = {
                content: [{ type: 'text' as const, text: 'Second result' }]
            };

            await expect(store.storeTaskResult(taskId, 'completed', secondResult)).rejects.toThrow('Cannot store result for task');
        });

        it('should store result with failed status', async () => {
            const result = {
                content: [{ type: 'text' as const, text: 'Error details' }],
                isError: true
            };

            await store.storeTaskResult(taskId, 'failed', result);

            const task = await store.getTask(taskId);
            expect(task?.status).toBe('failed');

            const storedResult = await store.getTaskResult(taskId);
            expect(storedResult).toEqual(result);
        });

        it('should reject storing result for task already in failed status', async () => {
            // First fail the task
            const firstResult = {
                content: [{ type: 'text' as const, text: 'First error' }],
                isError: true
            };
            await store.storeTaskResult(taskId, 'failed', firstResult);

            // Try to store result again (should fail)
            const secondResult = {
                content: [{ type: 'text' as const, text: 'Second error' }],
                isError: true
            };

            await expect(store.storeTaskResult(taskId, 'failed', secondResult)).rejects.toThrow('Cannot store result for task');
        });

        it('should reject storing result for cancelled task', async () => {
            // Mark task as cancelled
            await store.updateTaskStatus(taskId, 'cancelled');

            // Try to store result (should fail)
            const result = {
                content: [{ type: 'text' as const, text: 'Cancellation result' }]
            };

            await expect(store.storeTaskResult(taskId, 'completed', result)).rejects.toThrow('Cannot store result for task');
        });

        it('should allow storing result from input_required status', async () => {
            await store.updateTaskStatus(taskId, 'input_required');

            const result = {
                content: [{ type: 'text' as const, text: 'Success!' }]
            };

            await store.storeTaskResult(taskId, 'completed', result);

            const task = await store.getTask(taskId);
            expect(task?.status).toBe('completed');
        });
    });

    describe('getTaskResult', () => {
        it('should throw if task not found', async () => {
            await expect(store.getTaskResult('non-existent')).rejects.toThrow('Task with ID non-existent not found');
        });

        it('should throw if task has no result stored', async () => {
            const taskParams: TaskCreationParams = {};
            const createdTask = await store.createTask(taskParams, 444, {
                method: 'tools/call',
                params: {}
            });

            await expect(store.getTaskResult(createdTask.taskId)).rejects.toThrow(`Task ${createdTask.taskId} has no result stored`);
        });

        it('should return stored result', async () => {
            const taskParams: TaskCreationParams = {};
            const createdTask = await store.createTask(taskParams, 555, {
                method: 'tools/call',
                params: {}
            });

            const result = {
                content: [{ type: 'text' as const, text: 'Result data' }]
            };
            await store.storeTaskResult(createdTask.taskId, 'completed', result);

            const retrieved = await store.getTaskResult(createdTask.taskId);
            expect(retrieved).toEqual(result);
        });
    });

    describe('ttl cleanup', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should cleanup task after ttl duration', async () => {
            const taskParams: TaskCreationParams = {
                ttl: 1000
            };
            const createdTask = await store.createTask(taskParams, 666, {
                method: 'tools/call',
                params: {}
            });

            // Task should exist initially
            let task = await store.getTask(createdTask.taskId);
            expect(task).toBeDefined();

            // Fast-forward past ttl
            vi.advanceTimersByTime(1001);

            // Task should be cleaned up
            task = await store.getTask(createdTask.taskId);
            expect(task).toBeNull();
        });

        it('should reset cleanup timer when result is stored', async () => {
            const taskParams: TaskCreationParams = {
                ttl: 1000
            };
            const createdTask = await store.createTask(taskParams, 777, {
                method: 'tools/call',
                params: {}
            });

            // Fast-forward 500ms
            vi.advanceTimersByTime(500);

            // Store result (should reset timer)
            await store.storeTaskResult(createdTask.taskId, 'completed', {
                content: [{ type: 'text' as const, text: 'Done' }]
            });

            // Fast-forward another 500ms (total 1000ms since creation, but timer was reset)
            vi.advanceTimersByTime(500);

            // Task should still exist
            const task = await store.getTask(createdTask.taskId);
            expect(task).toBeDefined();

            // Fast-forward remaining time
            vi.advanceTimersByTime(501);

            // Now task should be cleaned up
            const cleanedTask = await store.getTask(createdTask.taskId);
            expect(cleanedTask).toBeNull();
        });

        it('should not cleanup tasks without ttl', async () => {
            const taskParams: TaskCreationParams = {};
            const createdTask = await store.createTask(taskParams, 888, {
                method: 'tools/call',
                params: {}
            });

            // Fast-forward a long time
            vi.advanceTimersByTime(100000);

            // Task should still exist
            const task = await store.getTask(createdTask.taskId);
            expect(task).toBeDefined();
        });

        it('should start cleanup timer when task reaches terminal state', async () => {
            const taskParams: TaskCreationParams = {
                ttl: 1000
            };
            const createdTask = await store.createTask(taskParams, 999, {
                method: 'tools/call',
                params: {}
            });

            // Task in non-terminal state, fast-forward
            vi.advanceTimersByTime(1001);

            // Task should be cleaned up
            let task = await store.getTask(createdTask.taskId);
            expect(task).toBeNull();

            // Create another task
            const taskParams2: TaskCreationParams = {
                ttl: 2000
            };
            const createdTask2 = await store.createTask(taskParams2, 1000, {
                method: 'tools/call',
                params: {}
            });

            // Update to terminal state
            await store.updateTaskStatus(createdTask2.taskId, 'completed');

            // Fast-forward past original ttl
            vi.advanceTimersByTime(2001);

            // Task should be cleaned up
            task = await store.getTask(createdTask2.taskId);
            expect(task).toBeNull();
        });

        it('should return actual TTL in task response', async () => {
            // Test that the TaskStore returns the actual TTL it will use
            // This implementation uses the requested TTL as-is, but implementations
            // MAY override it (e.g., enforce maximum TTL limits)
            const requestedTtl = 5000;
            const taskParams: TaskCreationParams = {
                ttl: requestedTtl
            };
            const createdTask = await store.createTask(taskParams, 1111, {
                method: 'tools/call',
                params: {}
            });

            // The returned task should include the actual TTL that will be used
            expect(createdTask.ttl).toBe(requestedTtl);

            // Verify the task is cleaned up after the actual TTL
            vi.advanceTimersByTime(requestedTtl + 1);
            const task = await store.getTask(createdTask.taskId);
            expect(task).toBeNull();
        });

        it('should support null TTL for unlimited lifetime', async () => {
            // Test that null TTL means unlimited lifetime
            const taskParams: TaskCreationParams = {
                ttl: null
            };
            const createdTask = await store.createTask(taskParams, 2222, {
                method: 'tools/call',
                params: {}
            });

            // The returned task should have null TTL
            expect(createdTask.ttl).toBeNull();

            // Task should not be cleaned up even after a long time
            vi.advanceTimersByTime(100000);
            const task = await store.getTask(createdTask.taskId);
            expect(task).toBeDefined();
            expect(task?.taskId).toBe(createdTask.taskId);
        });

        it('should cleanup tasks regardless of status', async () => {
            // Test that TTL cleanup happens regardless of task status
            const taskParams: TaskCreationParams = {
                ttl: 1000
            };

            // Create tasks in different statuses
            const workingTask = await store.createTask(taskParams, 3333, {
                method: 'tools/call',
                params: {}
            });

            const completedTask = await store.createTask(taskParams, 4444, {
                method: 'tools/call',
                params: {}
            });
            await store.storeTaskResult(completedTask.taskId, 'completed', {
                content: [{ type: 'text' as const, text: 'Done' }]
            });

            const failedTask = await store.createTask(taskParams, 5555, {
                method: 'tools/call',
                params: {}
            });
            await store.storeTaskResult(failedTask.taskId, 'failed', {
                content: [{ type: 'text' as const, text: 'Error' }]
            });

            // Fast-forward past TTL
            vi.advanceTimersByTime(1001);

            // All tasks should be cleaned up regardless of status
            expect(await store.getTask(workingTask.taskId)).toBeNull();
            expect(await store.getTask(completedTask.taskId)).toBeNull();
            expect(await store.getTask(failedTask.taskId)).toBeNull();
        });
    });

    describe('getAllTasks', () => {
        it('should return all tasks', async () => {
            await store.createTask({}, 1, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({}, 2, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({}, 3, {
                method: 'tools/call',
                params: {}
            });

            const tasks = store.getAllTasks();
            expect(tasks).toHaveLength(3);
            // Verify all tasks have unique IDs
            const taskIds = tasks.map(t => t.taskId);
            expect(new Set(taskIds).size).toBe(3);
        });

        it('should return empty array when no tasks', () => {
            const tasks = store.getAllTasks();
            expect(tasks).toEqual([]);
        });
    });

    describe('listTasks', () => {
        it('should return empty list when no tasks', async () => {
            const result = await store.listTasks();
            expect(result.tasks).toEqual([]);
            expect(result.nextCursor).toBeUndefined();
        });

        it('should return all tasks when less than page size', async () => {
            await store.createTask({}, 1, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({}, 2, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({}, 3, {
                method: 'tools/call',
                params: {}
            });

            const result = await store.listTasks();
            expect(result.tasks).toHaveLength(3);
            expect(result.nextCursor).toBeUndefined();
        });

        it('should paginate when more than page size', async () => {
            // Create 15 tasks (page size is 10)
            for (let i = 1; i <= 15; i++) {
                await store.createTask({}, i, {
                    method: 'tools/call',
                    params: {}
                });
            }

            // Get first page
            const page1 = await store.listTasks();
            expect(page1.tasks).toHaveLength(10);
            expect(page1.nextCursor).toBeDefined();

            // Get second page using cursor
            const page2 = await store.listTasks(page1.nextCursor);
            expect(page2.tasks).toHaveLength(5);
            expect(page2.nextCursor).toBeUndefined();
        });

        it('should throw error for invalid cursor', async () => {
            await store.createTask({}, 1, {
                method: 'tools/call',
                params: {}
            });

            await expect(store.listTasks('non-existent-cursor')).rejects.toThrow('Invalid cursor: non-existent-cursor');
        });

        it('should continue from cursor correctly', async () => {
            // Create 5 tasks
            for (let i = 1; i <= 5; i++) {
                await store.createTask({}, i, {
                    method: 'tools/call',
                    params: {}
                });
            }

            // Get first 3 tasks
            const allTaskIds = Array.from(store.getAllTasks().map(t => t.taskId));
            const result = await store.listTasks(allTaskIds[2]);

            // Should get tasks after the third task
            expect(result.tasks).toHaveLength(2);
        });
    });

    describe('cleanup', () => {
        it('should clear all timers and tasks', async () => {
            await store.createTask({ ttl: 1000 }, 1, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({ ttl: 2000 }, 2, {
                method: 'tools/call',
                params: {}
            });

            expect(store.getAllTasks()).toHaveLength(2);

            store.cleanup();

            expect(store.getAllTasks()).toHaveLength(0);
        });
    });
});

describe('InMemoryTaskMessageQueue', () => {
    let queue: InMemoryTaskMessageQueue;

    beforeEach(() => {
        queue = new InMemoryTaskMessageQueue();
    });

    describe('enqueue and dequeue', () => {
        it('should enqueue and dequeue request messages', async () => {
            const requestMessage: QueuedMessage = {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'test-tool', arguments: {} }
                },
                timestamp: Date.now()
            };

            await queue.enqueue('task-1', requestMessage);
            const dequeued = await queue.dequeue('task-1');

            expect(dequeued).toEqual(requestMessage);
        });

        it('should enqueue and dequeue notification messages', async () => {
            const notificationMessage: QueuedMessage = {
                type: 'notification',
                message: {
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: { progress: 50, total: 100 }
                },
                timestamp: Date.now()
            };

            await queue.enqueue('task-2', notificationMessage);
            const dequeued = await queue.dequeue('task-2');

            expect(dequeued).toEqual(notificationMessage);
        });

        it('should enqueue and dequeue response messages', async () => {
            const responseMessage: QueuedMessage = {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 42,
                    result: { content: [{ type: 'text', text: 'Success' }] }
                },
                timestamp: Date.now()
            };

            await queue.enqueue('task-3', responseMessage);
            const dequeued = await queue.dequeue('task-3');

            expect(dequeued).toEqual(responseMessage);
        });

        it('should return undefined when dequeuing from empty queue', async () => {
            const dequeued = await queue.dequeue('task-empty');
            expect(dequeued).toBeUndefined();
        });

        it('should maintain FIFO order for mixed message types', async () => {
            const request: QueuedMessage = {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {}
                },
                timestamp: 1000
            };

            const notification: QueuedMessage = {
                type: 'notification',
                message: {
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {}
                },
                timestamp: 2000
            };

            const response: QueuedMessage = {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    result: {}
                },
                timestamp: 3000
            };

            await queue.enqueue('task-fifo', request);
            await queue.enqueue('task-fifo', notification);
            await queue.enqueue('task-fifo', response);

            expect(await queue.dequeue('task-fifo')).toEqual(request);
            expect(await queue.dequeue('task-fifo')).toEqual(notification);
            expect(await queue.dequeue('task-fifo')).toEqual(response);
            expect(await queue.dequeue('task-fifo')).toBeUndefined();
        });
    });

    describe('dequeueAll', () => {
        it('should dequeue all messages including responses', async () => {
            const request: QueuedMessage = {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {}
                },
                timestamp: 1000
            };

            const response: QueuedMessage = {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    result: {}
                },
                timestamp: 2000
            };

            const notification: QueuedMessage = {
                type: 'notification',
                message: {
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {}
                },
                timestamp: 3000
            };

            await queue.enqueue('task-all', request);
            await queue.enqueue('task-all', response);
            await queue.enqueue('task-all', notification);

            const all = await queue.dequeueAll('task-all');

            expect(all).toHaveLength(3);
            expect(all[0]).toEqual(request);
            expect(all[1]).toEqual(response);
            expect(all[2]).toEqual(notification);
        });

        it('should return empty array for non-existent task', async () => {
            const all = await queue.dequeueAll('non-existent');
            expect(all).toEqual([]);
        });

        it('should clear the queue after dequeueAll', async () => {
            const message: QueuedMessage = {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'test',
                    params: {}
                },
                timestamp: Date.now()
            };

            await queue.enqueue('task-clear', message);
            await queue.dequeueAll('task-clear');

            const dequeued = await queue.dequeue('task-clear');
            expect(dequeued).toBeUndefined();
        });
    });

    describe('queue size limits', () => {
        it('should throw when maxSize is exceeded', async () => {
            const message: QueuedMessage = {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'test',
                    params: {}
                },
                timestamp: Date.now()
            };

            await queue.enqueue('task-limit', message, undefined, 2);
            await queue.enqueue('task-limit', message, undefined, 2);

            await expect(queue.enqueue('task-limit', message, undefined, 2)).rejects.toThrow('Task message queue overflow');
        });

        it('should allow enqueue when under maxSize', async () => {
            const message: QueuedMessage = {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    result: {}
                },
                timestamp: Date.now()
            };

            await expect(queue.enqueue('task-ok', message, undefined, 5)).resolves.toBeUndefined();
        });
    });

    describe('task isolation', () => {
        it('should isolate messages between different tasks', async () => {
            const message1: QueuedMessage = {
                type: 'request',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'test1',
                    params: {}
                },
                timestamp: 1000
            };

            const message2: QueuedMessage = {
                type: 'response',
                message: {
                    jsonrpc: '2.0',
                    id: 2,
                    result: {}
                },
                timestamp: 2000
            };

            await queue.enqueue('task-a', message1);
            await queue.enqueue('task-b', message2);

            expect(await queue.dequeue('task-a')).toEqual(message1);
            expect(await queue.dequeue('task-b')).toEqual(message2);
            expect(await queue.dequeue('task-a')).toBeUndefined();
            expect(await queue.dequeue('task-b')).toBeUndefined();
        });
    });

    describe('response message error handling', () => {
        it('should handle response messages with errors', async () => {
            const errorResponse: QueuedMessage = {
                type: 'error',
                message: {
                    jsonrpc: '2.0',
                    id: 1,
                    error: {
                        code: -32600,
                        message: 'Invalid Request'
                    }
                },
                timestamp: Date.now()
            };

            await queue.enqueue('task-error', errorResponse);
            const dequeued = await queue.dequeue('task-error');

            expect(dequeued).toEqual(errorResponse);
            expect(dequeued?.type).toBe('error');
        });
    });
});
