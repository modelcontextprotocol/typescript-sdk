/**
 * Tasks (SEP-2663) served by the conformance server, with the fixtures the
 * `tasks-*` server scenarios call by name. One store backs every per-request
 * server, and each task's work is a plain async function driving the store's
 * writer handle.
 */
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import type { TaskHandle } from '@modelcontextprotocol/server/ext/tasks';
import { declaresTasksExtension, InMemoryTaskStore, TasksExtension } from '@modelcontextprotocol/server/ext/tasks';
import * as z from 'zod/v4';

const store = new InMemoryTaskStore();

export const conformanceTasks = new TasksExtension(store, { defaultTtlMs: 600_000, defaultPollIntervalMs: 100 });

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });

/** Resolves after `ms`, or early when `signal` aborts. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true }
        );
    });

const confirmRequest = (message: string) =>
    inputRequired.elicit({
        message,
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
    });

/** Creates a task for this call and starts `work` on it; a failure in `work` fails the task. */
async function runAsTask(ctx: ServerContext, work: (handle: TaskHandle) => Promise<void>) {
    const task = await conformanceTasks.create(ctx);
    const handle = store.handle(task.taskId);
    void work(handle).catch(error => handle.fail({ code: -32_603, message: String(error) }));
    return task;
}

export function registerTaskFixtures(mcpServer: McpServer): void {
    mcpServer.registerTool(
        'greet',
        { description: 'SEP-2663 fixture: sync-only greeting', inputSchema: z.object({ name: z.string() }) },
        async ({ name }) => text(`Hello, ${name}!`)
    );

    // Task-supporting; without the extension declared on the request it runs synchronously.
    mcpServer.registerTool(
        'slow_compute',
        {
            description: 'SEP-2663 fixture: sleeps `seconds`, then returns; a task when the client declares the extension',
            inputSchema: z.object({ seconds: z.number().min(0), label: z.string().optional() })
        },
        async ({ seconds, label }, ctx) => {
            const done = `computed ${label ?? 'result'} after ${seconds}s`;
            if (!declaresTasksExtension(ctx)) {
                await sleep(Math.min(seconds, 5) * 1000);
                return text(done);
            }
            return runAsTask(ctx, async handle => {
                await handle.status(`computing ${label ?? ''}`.trim());
                await sleep(seconds * 1000, handle.signal);
                await handle.complete(text(done));
            });
        }
    );

    // Task-required: refuses with -32021 when the client did not declare the extension.
    mcpServer.registerTool(
        'failing_job',
        { description: 'SEP-2663 fixture: a task that completes with a tool execution error', inputSchema: z.object({}) },
        async (_args, ctx) =>
            runAsTask(ctx, async handle => {
                await sleep(1000, handle.signal);
                await handle.complete({ isError: true, content: [{ type: 'text', text: 'the job failed' }] });
            })
    );

    mcpServer.registerTool(
        'protocol_error_job',
        { description: 'SEP-2663 fixture: a task that fails with a protocol-level error', inputSchema: z.object({}) },
        async (_args, ctx) =>
            runAsTask(ctx, async handle => {
                await sleep(200, handle.signal);
                await handle.fail({ code: -32_603, message: 'internal failure while running the job' });
            })
    );

    mcpServer.registerTool(
        'confirm_delete',
        {
            description: 'SEP-2663 fixture: a task that asks for confirmation through tasks/update',
            inputSchema: z.object({ filename: z.string() })
        },
        async ({ filename }, ctx) =>
            runAsTask(ctx, async handle => {
                const answers = await handle.requireInput({ confirm: confirmRequest(`Delete ${filename}?`) });
                const confirmed = acceptedContent<{ confirm: boolean }>(answers, 'confirm')?.confirm === true;
                await handle.complete(text(confirmed ? `deleted ${filename}` : `kept ${filename}`));
            })
    );

    mcpServer.registerTool(
        'multi_input',
        { description: 'SEP-2663 fixture: a task that asks two questions at once', inputSchema: z.object({}) },
        async (_args, ctx) =>
            runAsTask(ctx, async handle => {
                const answers = await handle.requireInput({
                    first: confirmRequest('First question?'),
                    second: confirmRequest('Second question?')
                });
                await handle.complete(text(`answered ${Object.keys(answers).toSorted().join(', ')}`));
            })
    );

    // MRTR first (SEP-2322), then a task on the final round (SEP-2663).
    mcpServer.registerTool(
        'test_tool_with_task',
        { description: 'SEP-2663 fixture: gathers a name in band, then answers with a task', inputSchema: z.object({}) },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const name = acceptedContent<{ name: string }>(ctx.mcpReq.inputResponses, 'user_name')?.name;
            if (typeof name !== 'string') {
                return inputRequired({
                    inputRequests: {
                        user_name: inputRequired.elicit({
                            message: 'What is your name?',
                            requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
                        })
                    }
                });
            }
            return runAsTask(ctx, async handle => {
                await sleep(100, handle.signal);
                await handle.complete(text(`Hello, ${name}!`));
            });
        }
    );
}
