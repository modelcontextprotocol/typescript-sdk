/**
 * `TasksClientExtension` — the client side of the MCP Tasks extension
 * (`io.modelcontextprotocol/tasks`) as a {@linkcode ClientExtension}. It
 * advertises the capability on every request, lets `tools/call` answer with a
 * task handle, and wraps the extension's methods: `get`, `update`, `cancel`,
 * and a `waitFor` that polls at the server's suggested interval until the
 * task is terminal.
 *
 * ```ts
 * const tasks = new TasksClientExtension();
 * const client = new Client(info, { extensions: [tasks] });
 * await client.connect(transport);
 *
 * const outcome = await tasks.callTool({ name: 'send_report', arguments: { to: 'ops' } });
 * if (outcome.kind === 'task') {
 *     const done = await tasks.waitFor(outcome.task.taskId);
 *     if (done.status === 'completed') console.log(done.result);
 * }
 * ```
 *
 * One extension instance serves one client: `install` binds it.
 */

import type { CallToolRequestParams, CallToolResult, InputResponses, RequestOptions } from '@modelcontextprotocol/core-internal';
import { CompatibilityCallToolResultSchema, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import type { CreateTaskResult, DetailedTask } from '@modelcontextprotocol/core-internal/ext/tasks';
import { createTaskResultSchema, detailedTaskSchema, TASKS_EXTENSION_ID } from '@modelcontextprotocol/core-internal/ext/tasks';
import * as z from 'zod/v4';

import type { Client } from '../../client/client';
import type { ClientExtension } from '../../client/extension';

/** How a task-capable `tools/call` settled: a task handle to follow, or the ordinary result. */
export type CallToolOutcome = { kind: 'task'; task: CreateTaskResult } | { kind: 'result'; result: CallToolResult };

/** Options for {@link TasksClientExtension.waitFor}. */
export interface WaitForOptions {
    /** Aborting stops polling; the task itself is untouched. */
    signal?: AbortSignal;
    /** Overrides the server's `pollIntervalMs` hint, ms. */
    pollIntervalMs?: number;
    /** Fallback when the task carries no `pollIntervalMs`, ms. Default 1_000. */
    defaultPollIntervalMs?: number;
    /** Called with every snapshot, terminal one included. */
    onUpdate?: (task: DetailedTask) => void;
}

/** A task in a terminal status. */
export type TerminalTask = Extract<DetailedTask, { status: 'completed' | 'failed' | 'cancelled' }>;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * The `Client` consumes `resultType` before a caller schema runs for every
 * kind it knows, so the neutral `DetailedTask` shape is what `tasks/get`
 * answers arrive as; a task handle arrives raw, discriminator included.
 */
const callToolOutcomeSchema = z.union([createTaskResultSchema, CompatibilityCallToolResultSchema]);
const ackSchema = z.looseObject({});

export class TasksClientExtension implements ClientExtension {
    readonly id = TASKS_EXTENSION_ID;
    readonly capability = {};
    #client: Client | undefined;

    install(client: Client): void {
        if (this.#client !== undefined) throw new Error('TasksClientExtension is already installed on a client');
        this.#client = client;
        client.acceptResultType('tools/call', 'task');
    }

    get client(): Client {
        if (this.#client === undefined) throw new SdkError(SdkErrorCode.NotConnected, 'TasksClientExtension is not installed on a client');
        return this.#client;
    }

    /**
     * Calls a tool that may answer with a task handle. The ordinary result
     * comes back as `{ kind: 'result' }` for tools that answer synchronously.
     */
    async callTool(params: CallToolRequestParams, options?: RequestOptions): Promise<CallToolOutcome> {
        const raw = await this.client.request({ method: 'tools/call', params }, callToolOutcomeSchema, options);
        if ((raw as { resultType?: unknown }).resultType === 'task') {
            return { kind: 'task', task: createTaskResultSchema.parse(raw) };
        }
        return { kind: 'result', result: raw as CallToolResult };
    }

    /** `tasks/get`: the task's current snapshot, results and input requests inlined. */
    async get(taskId: string, options?: RequestOptions): Promise<DetailedTask> {
        const task = await this.client.request({ method: 'tasks/get', params: { taskId } }, detailedTaskSchema, options);
        return task as DetailedTask;
    }

    /** `tasks/update`: answers outstanding input requests. Partial answers are accepted. */
    async update(taskId: string, inputResponses: InputResponses, options?: RequestOptions): Promise<void> {
        await this.client.request({ method: 'tasks/update', params: { taskId, inputResponses } }, ackSchema, options);
    }

    /** `tasks/cancel`: cooperative; resolves on acknowledgement, the task may still settle. */
    async cancel(taskId: string, options?: RequestOptions): Promise<void> {
        await this.client.request({ method: 'tasks/cancel', params: { taskId } }, ackSchema, options);
    }

    /**
     * Polls `tasks/get` at the task's suggested interval until the task is
     * terminal. `input_required` snapshots are reported through `onUpdate`
     * and polling continues; answer them with {@link update}.
     */
    async waitFor(taskId: string, options?: WaitForOptions): Promise<TerminalTask> {
        for (;;) {
            options?.signal?.throwIfAborted();
            const task = await this.get(taskId, { signal: options?.signal });
            options?.onUpdate?.(task);
            if (TERMINAL.has(task.status)) return task as TerminalTask;
            const delay = options?.pollIntervalMs ?? task.pollIntervalMs ?? options?.defaultPollIntervalMs ?? 1000;
            await sleep(delay, options?.signal);
        }
    }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
