/**
 * End to end through a real `Client` against the stateless `createMcpHandler`
 * (a fresh `McpServer` per request), which is the deployment shape the Tasks
 * extension exists for: nothing about a running task lives on the server
 * instance that answered `tools/call`; the engine is the only shared state.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CLIENT_CAPABILITIES_META_KEY, createMcpHandler, McpServer, PROTOCOL_VERSION_META_KEY } from '../../../src/index';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import type { InputResponses, Step } from '../../../src/ext/tasks/index';
import {
    createTaskResultSchema,
    detailedTaskSchema,
    InMemoryTaskEngine,
    installTasks,
    NonRetryableError,
    TASKS_EXTENSION_ID
} from '../../../src/ext/tasks/index';

/**
 * The SDK `Client` consumes `resultType` (a wire-only field) before a caller
 * schema runs, so the client-side schemas are the neutral shapes.
 */
const ackSchema = z.looseObject({});

const TASKS_CAPABILITY = { extensions: { [TASKS_EXTENSION_ID]: {} } };

type Handler = (input: { name: string }, step: Step) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;

function createHarness(handler: Handler, options?: { declareExtension?: boolean }) {
    const engine = new InMemoryTaskEngine();
    const createServer = () => {
        const server = new McpServer({ name: 'tasks-test', version: '1.0.0' });
        const tasks = installTasks(server, { engine });
        tasks.registerTask(
            'greet',
            { description: 'greets, slowly', inputSchema: z.object({ name: z.string() }), retries: { baseDelayMs: 1, maxDelayMs: 2 } },
            handler
        );
        return server;
    };
    const mcpHandler = createMcpHandler(createServer);
    /**
     * `tools/call` is posted raw: the SDK `Client` decodes results before any
     * caller schema runs and rejects the extension's `resultType: "task"`
     * (typescript-sdk#2637) — the client half of the extension is the
     * ext-tasks package's job. Every other method goes through the real Client.
     */
    const startTask = async (name: string) => {
        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'greet',
                arguments: { name },
                _meta: {
                    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
                    [CLIENT_CAPABILITIES_META_KEY]: options?.declareExtension === false ? {} : TASKS_CAPABILITY
                }
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
                    'Mcp-Name': 'greet'
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
        const message = JSON.parse(payload ?? '{}') as { result?: unknown; error?: { code: number; message: string } };
        if (message.error !== undefined) throw Object.assign(new Error(message.error.message), { code: message.error.code });
        return createTaskResultSchema.parse(message.result);
    };
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
        fetch: (url, init) => mcpHandler.fetch(new Request(url, init))
    });
    const client = new Client(
        { name: 'harness', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' }, capabilities: options?.declareExtension === false ? {} : TASKS_CAPABILITY }
    );
    return { engine, client, transport, startTask };
}

const getTask = (client: Client, taskId: string) => client.request({ method: 'tasks/get', params: { taskId } }, detailedTaskSchema);

const updateTask = (client: Client, taskId: string, inputResponses: InputResponses) =>
    client.request({ method: 'tasks/update', params: { taskId, inputResponses } }, ackSchema);

const cancelTask = (client: Client, taskId: string) => client.request({ method: 'tasks/cancel', params: { taskId } }, ackSchema);

async function pollUntil(client: Client, taskId: string, predicate: (task: z.output<typeof detailedTaskSchema>) => boolean) {
    for (let i = 0; i < 200; i++) {
        const task = await getTask(client, taskId);
        if (predicate(task)) return task;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`task ${taskId} never reached the expected state`);
}

describe('tasks end to end (stateless handler, in-memory engine)', () => {
    let cleanup: (() => void) | undefined;
    afterEach(() => cleanup?.());

    it('advertises the extension, answers a task handle, and completes through do/sleep/status', async () => {
        const calls: string[] = [];
        const h = createHarness(async ({ name }, step) => {
            const upper = await step.do('upper', () => {
                calls.push('upper');
                return name.toUpperCase();
            });
            await step.status(`greeting ${upper}`);
            await step.sleep('pause', 10);
            const text = await step.do('compose', () => `hello ${upper}`);
            return { content: [{ type: 'text', text }] };
        });
        cleanup = () => h.engine.close();
        await h.client.connect(h.transport);
        expect(h.client.getServerCapabilities()?.extensions).toEqual({ [TASKS_EXTENSION_ID]: {} });

        const created = await h.startTask('ada');
        expect(created.resultType).toBe('task');
        expect(created.status).toBe('working');
        expect(created.ttlMs).toBe(86_400_000);

        const done = await pollUntil(h.client, created.taskId, task => task.status === 'completed');
        expect(done.status === 'completed' && done.result).toEqual({ content: [{ type: 'text', text: 'hello ADA' }] });
        expect(done.statusMessage).toBe('greeting ADA');
        // The sleep suspended the first run; the resume replayed `upper` from the journal.
        expect(calls).toEqual(['upper']);
    });

    it('surfaces input_required, resumes on tasks/update, and inlines the answer', async () => {
        const h = createHarness(async ({ name }, step) => {
            const answer = await step.elicit('confirm', {
                method: 'elicitation/create',
                params: { message: `greet ${name}?`, mode: 'form', requestedSchema: { type: 'object', properties: {} } }
            });
            return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
        });
        cleanup = () => h.engine.close();
        await h.client.connect(h.transport);
        const created = await h.startTask('bob');
        const waiting = await pollUntil(h.client, created.taskId, task => task.status === 'input_required');
        expect(waiting.status === 'input_required' && Object.keys(waiting.inputRequests)).toEqual(['confirm']);

        await updateTask(h.client, created.taskId, { confirm: { action: 'accept', content: { ok: true } } });
        const done = await pollUntil(h.client, created.taskId, task => task.status === 'completed');
        expect(done.status === 'completed' && done.result).toEqual({
            content: [{ type: 'text', text: JSON.stringify({ action: 'accept', content: { ok: true } }) }]
        });
    });

    it('retries a failing step with the task policy and completes', async () => {
        let attempts = 0;
        const h = createHarness(async ({ name }, step) => {
            const text = await step.do('flaky', () => {
                attempts += 1;
                if (attempts < 3) throw new Error('transient');
                return `hi ${name}`;
            });
            return { content: [{ type: 'text', text }] };
        });
        cleanup = () => h.engine.close();
        await h.client.connect(h.transport);
        const created = await h.startTask('cy');
        const done = await pollUntil(h.client, created.taskId, task => task.status === 'completed');
        expect(attempts).toBe(3);
        expect(done.status === 'completed' && done.result).toEqual({ content: [{ type: 'text', text: 'hi cy' }] });
    });

    it('completes with isError for a handler throw, and NonRetryableError skips retries', async () => {
        let attempts = 0;
        const h = createHarness(async (_input, step) => {
            await step.do('boom', () => {
                attempts += 1;
                throw new NonRetryableError('bad input');
            });
            return { content: [] };
        });
        cleanup = () => h.engine.close();
        await h.client.connect(h.transport);
        const created = await h.startTask('x');
        const done = await pollUntil(h.client, created.taskId, task => task.status === 'completed');
        expect(attempts).toBe(1);
        expect(done.status === 'completed' && done.result).toEqual({
            content: [{ type: 'text', text: 'NonRetryableError: bad input' }],
            isError: true
        });
    });

    it('cancels cooperatively at the next step', async () => {
        const h = createHarness(async (_input, step) => {
            await step.sleep('long', 60_000);
            return { content: [] };
        });
        cleanup = () => h.engine.close();
        await h.client.connect(h.transport);
        const created = await h.startTask('x');
        await pollUntil(h.client, created.taskId, task => task.status === 'working');
        await new Promise(resolve => setTimeout(resolve, 10)); // let the run reach the sleep
        await cancelTask(h.client, created.taskId);
        const done = await pollUntil(h.client, created.taskId, task => task.status === 'cancelled');
        expect(done.status).toBe('cancelled');
        await expect(cancelTask(h.client, created.taskId)).resolves.toBeDefined(); // idempotent
    });

    it('answers -32602 for an unknown task and -32021 without the extension capability', async () => {
        const h = createHarness(async () => ({ content: [] }));
        cleanup = () => h.engine.close();
        await h.client.connect(h.transport);
        await expect(getTask(h.client, 'nope')).rejects.toMatchObject({ code: -32_602 });

        const plain = createHarness(async () => ({ content: [] }), { declareExtension: false });
        await plain.client.connect(plain.transport);
        await expect(getTask(plain.client, 'nope')).rejects.toMatchObject({ code: -32_021 });
        // The SDK's tool dispatch converts handler throws into isError results; the
        // -32021 refusal therefore reaches a non-declaring caller as a tool error.
        const refused = await plain.client.callTool({ name: 'greet', arguments: { name: 'x' } });
        expect(refused.isError).toBe(true);
        expect(refused.content).toEqual([{ type: 'text', text: expect.stringContaining(TASKS_EXTENSION_ID) }]);
        plain.engine.close();
    });
});
