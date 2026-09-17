/**
 * End to end through a real `Client` against the stateless `createMcpHandler`
 * (a fresh `McpServer` per request): nothing about a running task lives on
 * the server instance that answered `tools/call`; the store is the only
 * shared state, and the work runs wherever the server chooses — here, a
 * plain async function driving the store's writer handle.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TasksClientExtension } from '@modelcontextprotocol/client/ext/tasks';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import type { DetailedTask, TaskHandle } from '../../../src/ext/tasks/index';
import { InMemoryTaskStore, TASKS_EXTENSION_ID, TasksExtension } from '../../../src/ext/tasks/index';
import { CLIENT_CAPABILITIES_META_KEY, createMcpHandler, McpServer, PROTOCOL_VERSION_META_KEY } from '../../../src/index';

type Work = (handle: TaskHandle, input: { name: string }) => Promise<void>;

function createHarness(work: Work, options?: { declareExtension?: boolean; plainTool?: boolean }) {
    const store = new InMemoryTaskStore();
    const tasks = new TasksExtension(store, { defaultPollIntervalMs: 10 });
    const createServer = () => {
        const server = new McpServer({ name: 'tasks-test', version: '1.0.0' }, { extensions: [tasks] });
        server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, async (input, ctx) => {
            const task = await tasks.create(ctx);
            void work(store.handle(task.taskId), input);
            return task;
        });
        if (options?.plainTool) {
            // A handle minted outside `tasks.create`: the tools/call override still gates it.
            server.registerTool('sneaky', {}, async () => {
                const task = await store.create({ ttlMs: null });
                return { resultType: 'task', ...task } as never;
            });
        }
        return server;
    };
    const mcpHandler = createMcpHandler(createServer);
    const declare = options?.declareExtension !== false;
    /** A raw `tools/call` POST, for the cases where the client deliberately does not declare the extension. */
    const callTool = async (name: string, args: Record<string, unknown>) => {
        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name,
                arguments: args,
                _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: declare ? TASKS_CAPABILITY : {} }
            }
        };
        const response = await mcpHandler.fetch(
            new Request('http://test.local/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'MCP-Protocol-Version': '2026-07-28',
                    'Mcp-Method': 'tools/call',
                    'Mcp-Name': name
                },
                body: JSON.stringify(body)
            })
        );
        const text = await response.text();
        const payload = response.headers.get('content-type')?.includes('text/event-stream')
            ? text
                  .split('\n')
                  .filter(line => line.startsWith('data:'))
                  .map(line => line.slice(5).trim())
                  .at(-1)
            : text;
        return JSON.parse(payload ?? '{}') as { result?: Record<string, unknown>; error?: { code: number; message: string } };
    };
    const startTask = async (name: string) => {
        const outcome = await clientTasks.callTool({ name: 'greet', arguments: { name } });
        if (outcome.kind !== 'task') throw new Error('expected a task handle');
        return outcome.task;
    };
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
        fetch: (url, init) => mcpHandler.fetch(new Request(url, init))
    });
    const clientTasks = new TasksClientExtension();
    const client = new Client(
        { name: 'harness', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' }, extensions: declare ? [clientTasks] : [] }
    );
    return { store, client, transport, clientTasks, startTask, callTool };
}

async function pollUntil(tasks: TasksClientExtension, taskId: string, predicate: (task: DetailedTask) => boolean) {
    for (let i = 0; i < 200; i++) {
        const task = await tasks.get(taskId);
        if (predicate(task)) return task;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`task ${taskId} never reached the expected state`);
}

describe('TasksExtension end to end (stateless handler, in-memory store)', () => {
    let cleanup: (() => void) | undefined;
    afterEach(() => cleanup?.());

    it('advertises the extension, answers a task handle, and completes with status', async () => {
        const h = createHarness(async (handle, { name }) => {
            await handle.status(`greeting ${name}`);
            await new Promise(resolve => setTimeout(resolve, 10));
            await handle.complete({ content: [{ type: 'text', text: `hello ${name}` }] });
        });
        cleanup = () => h.store.close();
        await h.client.connect(h.transport);
        expect(h.client.getServerCapabilities()?.extensions).toEqual({ [TASKS_EXTENSION_ID]: {} });

        const created = await h.startTask('ada');
        expect(created).toMatchObject({ resultType: 'task', status: 'working', ttlMs: 86_400_000, pollIntervalMs: 10 });

        const seen: string[] = [];
        const done = await h.clientTasks.waitFor(created.taskId, { onUpdate: task => seen.push(task.status) });
        expect(done.status === 'completed' && done.result).toEqual({ content: [{ type: 'text', text: 'hello ada' }] });
        expect(done.statusMessage).toBe('greeting ada');
        expect(seen.at(-1)).toBe('completed');
    });

    it('surfaces input_required, resumes on tasks/update, and inlines the answer', async () => {
        const h = createHarness(async (handle, { name }) => {
            const answers = await handle.requireInput({
                confirm: {
                    method: 'elicitation/create',
                    params: { message: `greet ${name}?`, mode: 'form', requestedSchema: { type: 'object', properties: {} } }
                }
            });
            await handle.complete({ content: [{ type: 'text', text: JSON.stringify(answers) }] });
        });
        cleanup = () => h.store.close();
        await h.client.connect(h.transport);
        const created = await h.startTask('bob');
        const waiting = await pollUntil(h.clientTasks, created.taskId, task => task.status === 'input_required');
        expect(waiting.status === 'input_required' && Object.keys(waiting.inputRequests)).toEqual(['confirm']);

        await h.clientTasks.update(created.taskId, { confirm: { action: 'accept', content: { ok: true } } });
        const done = await pollUntil(h.clientTasks, created.taskId, task => task.status === 'completed');
        expect(done.status === 'completed' && done.result).toEqual({
            content: [{ type: 'text', text: JSON.stringify({ confirm: { action: 'accept', content: { ok: true } } }) }]
        });
    });

    it('fails a task with the reported error', async () => {
        const h = createHarness(async handle => {
            await handle.fail({ code: -32_000, message: 'upstream down' });
        });
        cleanup = () => h.store.close();
        await h.client.connect(h.transport);
        const created = await h.startTask('x');
        const done = await pollUntil(h.clientTasks, created.taskId, task => task.status === 'failed');
        expect(done.status === 'failed' && done.error).toEqual({ code: -32_000, message: 'upstream down' });
    });

    it('cancels cooperatively: the handle signal aborts and later writes are ignored', async () => {
        let aborted = false;
        const h = createHarness(async handle => {
            await new Promise<void>(resolve => handle.signal.addEventListener('abort', () => resolve(), { once: true }));
            aborted = true;
            await handle.complete({ content: [] });
        });
        cleanup = () => h.store.close();
        await h.client.connect(h.transport);
        const created = await h.startTask('x');
        await h.clientTasks.cancel(created.taskId);
        const done = await pollUntil(h.clientTasks, created.taskId, task => task.status === 'cancelled');
        expect(done.status).toBe('cancelled');
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(aborted).toBe(true);
        expect((await h.clientTasks.get(created.taskId)).status).toBe('cancelled');
        await expect(h.clientTasks.cancel(created.taskId)).resolves.toBeUndefined(); // idempotent
    });

    it('answers -32602 for an unknown task and -32021 without the extension capability, as JSON-RPC errors', async () => {
        const h = createHarness(async () => {});
        cleanup = () => h.store.close();
        await h.client.connect(h.transport);
        await expect(h.clientTasks.get('nope')).rejects.toMatchObject({ code: -32_602 });

        const plain = createHarness(async () => {}, { declareExtension: false, plainTool: true });
        await plain.client.connect(plain.transport);
        await expect(plain.client.request({ method: 'tasks/get', params: { taskId: 'nope' } }, z.looseObject({}))).rejects.toMatchObject({
            code: -32_021
        });
        const refused = await plain.callTool('greet', { name: 'x' });
        expect(refused.error).toMatchObject({ code: -32_021 });
        const sneaky = await plain.callTool('sneaky', {});
        expect(sneaky.error).toMatchObject({ code: -32_021 });
        plain.store.close();
    });
});
