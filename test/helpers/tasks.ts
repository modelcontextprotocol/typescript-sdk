import type { Task } from '../../src/types.js';

/**
 * Polls the provided getTask function until the task reaches the desired status or times out.
 */
export async function waitForTaskStatus(
    getTask: (taskId: string) => Promise<Task | null | undefined>,
    taskId: string,
    desiredStatus: Task['status'],
    {
        intervalMs = 100,
        timeoutMs = 10_000
    }: {
        intervalMs?: number;
        timeoutMs?: number;
    } = {}
): Promise<Task> {
    const start = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const task = await getTask(taskId);
        if (task && task.status === desiredStatus) {
            return task;
        }

        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for task ${taskId} to reach status ${desiredStatus}`);
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}
