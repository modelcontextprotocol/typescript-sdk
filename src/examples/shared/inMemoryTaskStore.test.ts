import { InMemoryTaskStore } from './inMemoryTaskStore.js';
import { TaskMetadata, Request } from '../../types.js';

describe('InMemoryTaskStore', () => {
    let store: InMemoryTaskStore;

    beforeEach(() => {
        store = new InMemoryTaskStore();
    });

    afterEach(() => {
        store.cleanup();
    });

    describe('createTask', () => {
        it('should create a new task with submitted status', async () => {
            const metadata: TaskMetadata = {
                taskId: 'task-1',
                keepAlive: 60000
            };
            const request: Request = {
                method: 'tools/call',
                params: { name: 'test-tool' }
            };

            await store.createTask(metadata, 123, request);

            const task = await store.getTask('task-1');
            expect(task).toBeDefined();
            expect(task?.taskId).toBe('task-1');
            expect(task?.status).toBe('submitted');
            expect(task?.keepAlive).toBe(60000);
            expect(task?.pollInterval).toBe(500);
        });

        it('should create task without keepAlive', async () => {
            const metadata: TaskMetadata = {
                taskId: 'task-no-keepalive'
            };
            const request: Request = {
                method: 'tools/call',
                params: {}
            };

            await store.createTask(metadata, 456, request);

            const task = await store.getTask('task-no-keepalive');
            expect(task).toBeDefined();
            expect(task?.keepAlive).toBeNull();
        });

        it('should reject duplicate taskId', async () => {
            const metadata: TaskMetadata = {
                taskId: 'duplicate-task'
            };
            const request: Request = {
                method: 'tools/call',
                params: {}
            };

            await store.createTask(metadata, 789, request);

            await expect(store.createTask(metadata, 790, request)).rejects.toThrow('Task with ID duplicate-task already exists');
        });
    });

    describe('getTask', () => {
        it('should return null for non-existent task', async () => {
            const task = await store.getTask('non-existent');
            expect(task).toBeNull();
        });

        it('should return task state', async () => {
            const metadata: TaskMetadata = {
                taskId: 'get-test'
            };
            const request: Request = {
                method: 'tools/call',
                params: {}
            };

            await store.createTask(metadata, 111, request);
            await store.updateTaskStatus('get-test', 'working');

            const task = await store.getTask('get-test');
            expect(task).toBeDefined();
            expect(task?.status).toBe('working');
        });
    });

    describe('updateTaskStatus', () => {
        beforeEach(async () => {
            const metadata: TaskMetadata = {
                taskId: 'status-test'
            };
            await store.createTask(metadata, 222, {
                method: 'tools/call',
                params: {}
            });
        });

        it('should update task status from submitted to working', async () => {
            await store.updateTaskStatus('status-test', 'working');

            const task = await store.getTask('status-test');
            expect(task?.status).toBe('working');
        });

        it('should update task status to input_required', async () => {
            await store.updateTaskStatus('status-test', 'input_required');

            const task = await store.getTask('status-test');
            expect(task?.status).toBe('input_required');
        });

        it('should update task status to completed', async () => {
            await store.updateTaskStatus('status-test', 'completed');

            const task = await store.getTask('status-test');
            expect(task?.status).toBe('completed');
        });

        it('should update task status to failed with error', async () => {
            await store.updateTaskStatus('status-test', 'failed', 'Something went wrong');

            const task = await store.getTask('status-test');
            expect(task?.status).toBe('failed');
            expect(task?.error).toBe('Something went wrong');
        });

        it('should update task status to cancelled', async () => {
            await store.updateTaskStatus('status-test', 'cancelled');

            const task = await store.getTask('status-test');
            expect(task?.status).toBe('cancelled');
        });

        it('should throw if task not found', async () => {
            await expect(store.updateTaskStatus('non-existent', 'working')).rejects.toThrow('Task with ID non-existent not found');
        });
    });

    describe('storeTaskResult', () => {
        beforeEach(async () => {
            const metadata: TaskMetadata = {
                taskId: 'result-test',
                keepAlive: 60000
            };
            await store.createTask(metadata, 333, {
                method: 'tools/call',
                params: {}
            });
        });

        it('should store task result and set status to completed', async () => {
            const result = {
                content: [{ type: 'text' as const, text: 'Success!' }]
            };

            await store.storeTaskResult('result-test', result);

            const task = await store.getTask('result-test');
            expect(task?.status).toBe('completed');

            const storedResult = await store.getTaskResult('result-test');
            expect(storedResult).toEqual(result);
        });

        it('should throw if task not found', async () => {
            await expect(store.storeTaskResult('non-existent', {})).rejects.toThrow('Task with ID non-existent not found');
        });
    });

    describe('getTaskResult', () => {
        it('should throw if task not found', async () => {
            await expect(store.getTaskResult('non-existent')).rejects.toThrow('Task with ID non-existent not found');
        });

        it('should throw if task has no result stored', async () => {
            const metadata: TaskMetadata = {
                taskId: 'no-result'
            };
            await store.createTask(metadata, 444, {
                method: 'tools/call',
                params: {}
            });

            await expect(store.getTaskResult('no-result')).rejects.toThrow('Task no-result has no result stored');
        });

        it('should return stored result', async () => {
            const metadata: TaskMetadata = {
                taskId: 'with-result'
            };
            await store.createTask(metadata, 555, {
                method: 'tools/call',
                params: {}
            });

            const result = {
                content: [{ type: 'text' as const, text: 'Result data' }]
            };
            await store.storeTaskResult('with-result', result);

            const retrieved = await store.getTaskResult('with-result');
            expect(retrieved).toEqual(result);
        });
    });

    describe('keepAlive cleanup', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should cleanup task after keepAlive duration', async () => {
            const metadata: TaskMetadata = {
                taskId: 'cleanup-test',
                keepAlive: 1000
            };
            await store.createTask(metadata, 666, {
                method: 'tools/call',
                params: {}
            });

            // Task should exist initially
            let task = await store.getTask('cleanup-test');
            expect(task).toBeDefined();

            // Fast-forward past keepAlive
            jest.advanceTimersByTime(1001);

            // Task should be cleaned up
            task = await store.getTask('cleanup-test');
            expect(task).toBeNull();
        });

        it('should reset cleanup timer when result is stored', async () => {
            const metadata: TaskMetadata = {
                taskId: 'reset-cleanup',
                keepAlive: 1000
            };
            await store.createTask(metadata, 777, {
                method: 'tools/call',
                params: {}
            });

            // Fast-forward 500ms
            jest.advanceTimersByTime(500);

            // Store result (should reset timer)
            await store.storeTaskResult('reset-cleanup', {
                content: [{ type: 'text' as const, text: 'Done' }]
            });

            // Fast-forward another 500ms (total 1000ms since creation, but timer was reset)
            jest.advanceTimersByTime(500);

            // Task should still exist
            const task = await store.getTask('reset-cleanup');
            expect(task).toBeDefined();

            // Fast-forward remaining time
            jest.advanceTimersByTime(501);

            // Now task should be cleaned up
            const cleanedTask = await store.getTask('reset-cleanup');
            expect(cleanedTask).toBeNull();
        });

        it('should not cleanup tasks without keepAlive', async () => {
            const metadata: TaskMetadata = {
                taskId: 'no-cleanup'
            };
            await store.createTask(metadata, 888, {
                method: 'tools/call',
                params: {}
            });

            // Fast-forward a long time
            jest.advanceTimersByTime(100000);

            // Task should still exist
            const task = await store.getTask('no-cleanup');
            expect(task).toBeDefined();
        });

        it('should start cleanup timer when task reaches terminal state', async () => {
            const metadata: TaskMetadata = {
                taskId: 'terminal-cleanup',
                keepAlive: 1000
            };
            await store.createTask(metadata, 999, {
                method: 'tools/call',
                params: {}
            });

            // Task in non-terminal state, fast-forward
            jest.advanceTimersByTime(1001);

            // Task should be cleaned up
            let task = await store.getTask('terminal-cleanup');
            expect(task).toBeNull();

            // Create another task
            const metadata2: TaskMetadata = {
                taskId: 'terminal-cleanup-2',
                keepAlive: 2000
            };
            await store.createTask(metadata2, 1000, {
                method: 'tools/call',
                params: {}
            });

            // Update to terminal state
            await store.updateTaskStatus('terminal-cleanup-2', 'completed');

            // Fast-forward past original keepAlive
            jest.advanceTimersByTime(2001);

            // Task should be cleaned up
            task = await store.getTask('terminal-cleanup-2');
            expect(task).toBeNull();
        });
    });

    describe('getAllTasks', () => {
        it('should return all tasks', async () => {
            await store.createTask({ taskId: 'task-1' }, 1, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({ taskId: 'task-2' }, 2, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({ taskId: 'task-3' }, 3, {
                method: 'tools/call',
                params: {}
            });

            const tasks = store.getAllTasks();
            expect(tasks).toHaveLength(3);
            expect(tasks.map(t => t.taskId).sort()).toEqual(['task-1', 'task-2', 'task-3']);
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
            await store.createTask({ taskId: 'task-1' }, 1, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({ taskId: 'task-2' }, 2, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({ taskId: 'task-3' }, 3, {
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
                await store.createTask({ taskId: `task-${i}` }, i, {
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
            await store.createTask({ taskId: 'task-1' }, 1, {
                method: 'tools/call',
                params: {}
            });

            await expect(store.listTasks('non-existent-cursor')).rejects.toThrow('Invalid cursor: non-existent-cursor');
        });

        it('should continue from cursor correctly', async () => {
            // Create tasks with predictable IDs
            for (let i = 1; i <= 5; i++) {
                await store.createTask({ taskId: `task-${i}` }, i, {
                    method: 'tools/call',
                    params: {}
                });
            }

            // Get first 3 tasks
            const allTaskIds = Array.from(store.getAllTasks().map(t => t.taskId));
            const result = await store.listTasks(allTaskIds[2]);

            // Should get tasks after task-3
            expect(result.tasks).toHaveLength(2);
        });
    });

    describe('cleanup', () => {
        it('should clear all timers and tasks', async () => {
            await store.createTask({ taskId: 'task-1', keepAlive: 1000 }, 1, {
                method: 'tools/call',
                params: {}
            });
            await store.createTask({ taskId: 'task-2', keepAlive: 2000 }, 2, {
                method: 'tools/call',
                params: {}
            });

            expect(store.getAllTasks()).toHaveLength(2);

            store.cleanup();

            expect(store.getAllTasks()).toHaveLength(0);
        });
    });

    describe('deleteTask', () => {
        it('should delete an existing task', async () => {
            await store.createTask({ taskId: 'task-to-delete' }, 1, {
                method: 'tools/call',
                params: {}
            });

            expect(await store.getTask('task-to-delete')).toBeDefined();

            await store.deleteTask('task-to-delete');

            expect(await store.getTask('task-to-delete')).toBeNull();
        });

        it('should throw error when deleting non-existent task', async () => {
            await expect(store.deleteTask('non-existent')).rejects.toThrow('Task with ID non-existent not found');
        });

        it('should clear cleanup timer when deleting task with keepAlive', async () => {
            jest.useFakeTimers();

            await store.createTask({ taskId: 'task-with-timer', keepAlive: 1000 }, 1, {
                method: 'tools/call',
                params: {}
            });

            expect(await store.getTask('task-with-timer')).toBeDefined();

            await store.deleteTask('task-with-timer');

            // Fast-forward past keepAlive time
            jest.advanceTimersByTime(1001);

            // Task should not exist (it was deleted immediately, not cleaned up by timer)
            expect(await store.getTask('task-with-timer')).toBeNull();

            jest.useRealTimers();
        });

        it('should delete task with result', async () => {
            await store.createTask({ taskId: 'task-with-result' }, 1, {
                method: 'tools/call',
                params: {}
            });

            const result = { content: [{ type: 'text' as const, text: 'Result' }] };
            await store.storeTaskResult('task-with-result', result);

            await store.deleteTask('task-with-result');

            expect(await store.getTask('task-with-result')).toBeNull();
        });
    });
});
