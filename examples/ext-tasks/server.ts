/**
 * A minimal Tasks server (`io.modelcontextprotocol/tasks`), everything
 * in-process: `InMemoryTaskStore` holds the task records, and the work behind
 * a task is a plain async function driven by timers. The SDK owns the wire;
 * how the work runs is this file's own business.
 *
 * One tool, `bake_cake`: answers with a task handle at once, then mixes, asks
 * the client which frosting to use (`input_required`), bakes, and completes —
 * or stops at the next step when the client cancels.
 *
 * One binary, either transport — selected by `--http --port <N>` (defaults to
 * stdio). See `examples/CONTRIBUTING.md` for the canonical shape.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { TaskHandle } from '@modelcontextprotocol/server/ext/tasks';
import { InMemoryTaskStore, TasksExtension } from '@modelcontextprotocol/server/ext/tasks';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// One store for the process: tasks outlive the request (and, under
// `createMcpHandler`, the McpServer instance) that created them.
const store = new InMemoryTaskStore();
const tasks = new TasksExtension(store, { defaultPollIntervalMs: 50 });

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(new Error('cancelled'));
            },
            { once: true }
        );
    });

/** The work: reports progress, asks one question, honours cancellation between steps. */
async function bakeCake(handle: TaskHandle, layers: number): Promise<void> {
    try {
        await handle.status(`mixing ${layers} layers`);
        await sleep(30, handle.signal);

        const answers = await handle.requireInput({
            frosting: {
                method: 'elicitation/create',
                params: {
                    message: 'Which frosting?',
                    mode: 'form',
                    requestedSchema: { type: 'object', properties: { frosting: { type: 'string', enum: ['vanilla', 'chocolate'] } } }
                }
            }
        });
        const frosting = (answers['frosting'] as { content?: { frosting?: string } } | undefined)?.content?.frosting ?? 'plain';

        await handle.status(`baking with ${frosting} frosting`);
        await sleep(30, handle.signal);

        await handle.complete({
            content: [{ type: 'text', text: `${layers}-layer cake, ${frosting} frosting` }],
            structuredContent: { layers, frosting }
        });
    } catch (error) {
        // A cancelled task ignores later writes; anything else is a real failure.
        if (!handle.signal.aborted) await handle.fail({ code: -32_000, message: String(error) });
    }
}

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'tasks-example-server', version: '1.0.0' }, { extensions: [tasks] });

    mcp.registerTool(
        'bake_cake',
        {
            description: 'Bake a cake as a task: mixes, asks for a frosting, bakes.',
            inputSchema: z.object({ layers: z.number().int().min(1).max(5) })
        },
        async ({ layers }, ctx) => {
            // Create the task (bound to the caller's principal, if any) and
            // answer with its handle; the work starts in the background.
            const task = await tasks.create(ctx, { ttlMs: 60_000 });
            void bakeCake(store.handle(task.taskId), layers);
            return task;
        }
    );

    return mcp;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    // `createMcpHonoApp()` arms localhost host/origin validation by default;
    // bind loopback explicitly to match.
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
