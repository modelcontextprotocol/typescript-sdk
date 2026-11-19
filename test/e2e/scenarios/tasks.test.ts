/**
 * The Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) end to end:
 * a real `Client` with `TasksClientExtension` against a server whose tool
 * answers with a task handle. The store is the only state shared between the
 * server instances a factory builds; the work is a plain async function
 * driving the store's writer handle.
 */

import { Client } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import type { DetailedTask } from '@modelcontextprotocol/client/ext/tasks';
import { TasksClientExtension } from '@modelcontextprotocol/client/ext/tasks';
import { McpServer } from '@modelcontextprotocol/server';
import { memorySkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import type { TaskHandle } from '@modelcontextprotocol/server/ext/tasks';
import { InMemoryTaskStore, TASKS_EXTENSION_ID, TasksExtension } from '@modelcontextprotocol/server/ext/tasks';
import { expect, vi } from 'vitest';
import * as z from 'zod/v4';

import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const WIRE = { allowCustomMethods: true } as const;
const info = { name: 't', version: '0' };
const loose = z.looseObject({});
const ELICIT_FORM = { elicitation: { form: {} } };
const confirm = (name: string) => ({
    confirm: {
        method: 'elicitation/create' as const,
        params: { message: `greet ${name}?`, mode: 'form' as const, requestedSchema: { type: 'object' as const, properties: {} } }
    }
});

type Work = (handle: TaskHandle, input: { name: string }) => Promise<void>;

function harness(work: Work, toolConfig: { outputSchema?: z.ZodType } = {}) {
    const store = new InMemoryTaskStore();
    const tasks = new TasksExtension(store, { defaultPollIntervalMs: 5 });
    const makeServer = () => {
        const server = new McpServer(info, { extensions: [tasks] });
        server.registerTool('greet', { inputSchema: z.object({ name: z.string() }), ...toolConfig }, async (input, ctx) => {
            const task = await tasks.create(ctx);
            void work(store.handle(task.taskId), input).catch(() => {});
            return task as never;
        });
        // A handle minted outside `tasks.create`.
        server.registerTool('sneaky', {}, async () => ({ resultType: 'task', ...(await store.create({ ttlMs: null })) }) as never);
        return server;
    };
    const clientTasks = new TasksClientExtension();
    const newClient = (capabilities = {}) => new Client(info, { capabilities, extensions: [clientTasks] });
    const start = async (name = 'ada') => {
        const outcome = await clientTasks.callTool({ name: 'greet', arguments: { name } });
        if (outcome.kind !== 'task') throw new Error('expected a task handle');
        return outcome.task;
    };
    return { store, tasks: clientTasks, newClient, makeServer, start, [Symbol.dispose]: () => store.close() };
}

async function until(tasks: TasksClientExtension, taskId: string, status: DetailedTask['status']): Promise<DetailedTask> {
    for (let i = 0; i < 400; i++) {
        const task = await tasks.get(taskId);
        if (task.status === status) return task;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`task ${taskId} never became ${status}`);
}

verifies('tasks:create:handle-then-completed', async ({ transport }: TestArgs) => {
    using h = harness(async (handle, { name }) => {
        await handle.status(`greeting ${name}`);
        await handle.complete({ content: [{ type: 'text', text: `hello ${name}` }] });
    });
    const client = h.newClient();
    await using _ = await wire(transport, h.makeServer, client, WIRE);

    expect(client.getServerCapabilities()?.extensions).toEqual({ [TASKS_EXTENSION_ID]: {} });
    const created = await h.start();
    expect(created).toMatchObject({ resultType: 'task', status: 'working', ttlMs: 86_400_000, pollIntervalMs: 5 });

    const seen: string[] = [];
    const done = await h.tasks.waitFor(created.taskId, { onUpdate: task => void seen.push(task.status) });
    expect(done.status === 'completed' && done.result).toEqual({ content: [{ type: 'text', text: 'hello ada' }] });
    expect(done.statusMessage).toBe('greeting ada');
    expect(seen.at(-1)).toBe('completed');
});

verifies('tasks:input-required:update-resumes', async ({ transport }: TestArgs) => {
    using h = harness(async (handle, { name }) => {
        const answers = await handle.requireInput(confirm(name));
        await handle.complete({ content: [{ type: 'text', text: JSON.stringify(answers) }] });
    });
    const client = h.newClient(ELICIT_FORM);
    await using _ = await wire(transport, h.makeServer, client, WIRE);

    const created = await h.start('bob');
    const waiting = await until(h.tasks, created.taskId, 'input_required');
    expect(waiting.status === 'input_required' && Object.keys(waiting.inputRequests)).toEqual(['confirm']);

    // An answer that is not a valid result for the request is refused and changes nothing.
    await expect(h.tasks.update(created.taskId, { confirm: { action: 'maybe' } as never })).rejects.toMatchObject({ code: -32_602 });
    await expect(h.tasks.get(created.taskId)).resolves.toMatchObject({ status: 'input_required' });

    await h.tasks.update(created.taskId, { confirm: { action: 'accept', content: { ok: true } } });
    const done = await until(h.tasks, created.taskId, 'completed');
    expect(done.status === 'completed' && done.result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ confirm: { action: 'accept', content: { ok: true } } }) }]
    });
});

verifies('typescript:tasks:input-request:needs-declared-capability', async ({ transport }: TestArgs) => {
    using h = harness(async (handle, { name }) => {
        await handle.requireInput(confirm(name)).catch(error => handle.fail({ code: -32_603, message: (error as Error).message }));
    });
    const client = h.newClient(); // declares no elicitation capability
    await using _ = await wire(transport, h.makeServer, client, WIRE);

    const created = await h.start();
    const done = await until(h.tasks, created.taskId, 'failed');
    expect(done.status === 'failed' && done.error.message).toMatch(/cannot request input "confirm" \(elicitation\/create\)/);
});

verifies('tasks:failed:error-inlined', async ({ transport }: TestArgs) => {
    using h = harness(async handle => handle.fail({ code: -32_000, message: 'upstream down' }));
    const client = h.newClient();
    await using _ = await wire(transport, h.makeServer, client, WIRE);

    const created = await h.start();
    const done = await until(h.tasks, created.taskId, 'failed');
    expect(done.status === 'failed' && done.error).toEqual({ code: -32_000, message: 'upstream down' });
});

verifies('tasks:cancel:cooperative', async ({ transport }: TestArgs) => {
    let aborted = false;
    using h = harness(async handle => {
        await new Promise<void>(resolve => handle.signal.addEventListener('abort', () => resolve(), { once: true }));
        aborted = true;
        await handle.complete({ content: [] });
    });
    const client = h.newClient();
    await using _ = await wire(transport, h.makeServer, client, WIRE);

    const created = await h.start();
    await h.tasks.cancel(created.taskId);
    await until(h.tasks, created.taskId, 'cancelled');
    await vi.waitFor(() => expect(aborted).toBe(true));
    // The late `complete` is ignored, and cancelling again is acknowledged.
    await expect(h.tasks.get(created.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(h.tasks.cancel(created.taskId)).resolves.toBeUndefined();
});

verifies('tasks:errors:unknown-task', async ({ transport }: TestArgs) => {
    using h = harness(async () => {});
    const client = h.newClient();
    await using _ = await wire(transport, h.makeServer, client, WIRE);

    await expect(h.tasks.get('nope')).rejects.toMatchObject({ code: -32_602 });
    await expect(h.tasks.update('nope', {})).rejects.toMatchObject({ code: -32_602 });
    await expect(h.tasks.cancel('nope')).rejects.toMatchObject({ code: -32_602 });
});

verifies('tasks:capability:undeclared-refused', async ({ transport }: TestArgs) => {
    using h = harness(async () => {});
    const client = new Client(info); // no Tasks extension
    await using _ = await wire(transport, h.makeServer, client, WIRE);
    const call = (name: string, args: Record<string, unknown>) =>
        client.request({ method: 'tools/call', params: { name, arguments: args } }, loose);

    await expect(client.request({ method: 'tasks/get', params: { taskId: 'nope' } }, loose)).rejects.toMatchObject({ code: -32_021 });
    await expect(call('greet', { name: 'x' })).rejects.toMatchObject({ code: -32_021 });

    // A handle the tool minted itself is refused too, and its task is cancelled, not left running.
    const cancel = vi.spyOn(h.store, 'cancel');
    await expect(call('sneaky', {})).rejects.toMatchObject({ code: -32_021 });
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(h.store.get(cancel.mock.calls[0]![0])).resolves.toMatchObject({ status: 'cancelled' });
});

verifies('typescript:tasks:tool-with-output-schema', async ({ transport }: TestArgs) => {
    using h = harness(async handle => handle.complete({ content: [], structuredContent: { greeting: 'hello' } }), {
        outputSchema: z.object({ greeting: z.string() })
    });
    const client = h.newClient();
    await using _ = await wire(transport, h.makeServer, client, WIRE);

    const created = await h.start();
    expect(created.resultType).toBe('task');
    const done = await h.tasks.waitFor(created.taskId);
    expect(done.status === 'completed' && done.result).toMatchObject({ structuredContent: { greeting: 'hello' } });
});

verifies('typescript:tasks:with-skills', async ({ transport }: TestArgs) => {
    const SKILL_MD = '---\nname: release-notes\ndescription: Draft release notes.\n---\n# Release notes\n';
    using store = Object.assign(new InMemoryTaskStore(), { [Symbol.dispose]: () => store.close() });
    const tasks = new TasksExtension(store, { defaultPollIntervalMs: 5 });
    const skills = await SkillsExtension.load(memorySkillFiles({ 'release-notes/SKILL.md': SKILL_MD }));
    const makeServer = () => {
        const server = new McpServer(info, { extensions: [skills, tasks] });
        server.registerTool('draft_notes', { inputSchema: z.object({ version: z.string() }) }, async ({ version }, ctx) => {
            const task = await tasks.create(ctx);
            void store.handle(task.taskId).complete({ content: [{ type: 'text', text: `notes for ${version}` }] });
            return task;
        });
        return server;
    };
    const clientTasks = new TasksClientExtension();
    const client = new Client(info, { extensions: [clientTasks] });
    await using _ = await wire(transport, makeServer, client, WIRE);

    expect(client.getServerCapabilities()?.extensions).toEqual({
        'io.modelcontextprotocol/skills': { directoryRead: true },
        [TASKS_EXTENSION_ID]: {}
    });
    const { skills: entries } = await new SkillsClient(client).list();
    expect(entries.map(entry => entry.uri)).toEqual(['skill://release-notes/SKILL.md']);

    const outcome = await clientTasks.callTool({ name: 'draft_notes', arguments: { version: '2.4.0' } });
    if (outcome.kind !== 'task') throw new Error('expected a task handle');
    const done = await clientTasks.waitFor(outcome.task.taskId);
    expect(done.status === 'completed' && done.result).toEqual({ content: [{ type: 'text', text: 'notes for 2.4.0' }] });
});

verifies('typescript:tasks:legacy-era:not-served', async ({ transport }: TestArgs) => {
    using h = harness(async () => {});
    // Declares the extension, on a 2025-11-25 connection.
    const client = new Client(info, { capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } });
    await using _ = await wire(transport, h.makeServer, client, WIRE);

    await expect(client.request({ method: 'tasks/get', params: { taskId: 'x' } }, loose)).rejects.toMatchObject({ code: -32_601 });
    await expect(client.request({ method: 'tasks/update', params: { taskId: 'x', inputResponses: {} } }, loose)).rejects.toMatchObject({
        code: -32_601
    });
    // The refusal is a tool error here: 2025-11-25 does not define -32021.
    const refused = await client.callTool({ name: 'greet', arguments: { name: 'x' } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('it is not served on 2025-11-25');
});
