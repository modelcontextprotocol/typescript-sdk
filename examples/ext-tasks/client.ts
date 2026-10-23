/**
 * Connects to `./server.ts` with the Tasks client extension, calls `bake_cake`
 * twice, and asserts both outcomes: one task followed to completion through
 * `waitFor` (answering the frosting question on the way), one cancelled
 * mid-bake.
 *
 * Spawns the sibling `server.ts` over stdio by default, or connects to a
 * running endpoint under `--http <url>`. See `examples/CONTRIBUTING.md` for
 * the canonical shape.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TasksClientExtension } from '@modelcontextprotocol/client/ext/tasks';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url } = parseExampleArgs();

const tasks = new TasksClientExtension();
const client = new Client(
    { name: 'tasks-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' }, extensions: [tasks] }
);

await client.connect(
    transport === 'stdio'
        ? new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] })
        : new StreamableHTTPClientTransport(new URL(url))
);

check.ok('io.modelcontextprotocol/tasks' in (client.getServerCapabilities()?.extensions ?? {}));

// 1. A task followed to the end. `tools/call` answers a handle at once.
const started = await tasks.callTool({ name: 'bake_cake', arguments: { layers: 3 } });
check.equal(started.kind, 'task');
if (started.kind !== 'task') throw new Error('unreachable');
console.log(`[client] task ${started.task.taskId} created: ${started.task.status}`);

const seen: string[] = [];
const done = await tasks.waitFor(started.task.taskId, {
    onUpdate: async task => {
        seen.push(`${task.status}${task.statusMessage ? ` (${task.statusMessage})` : ''}`);
        if (task.status === 'input_required') {
            // The server asked which frosting; answer through tasks/update.
            check.deepEqual(Object.keys(task.inputRequests), ['frosting']);
            await tasks.update(task.taskId, { frosting: { action: 'accept', content: { frosting: 'chocolate' } } });
        }
    }
});
console.log(`[client] saw: ${[...new Set(seen)].join(' -> ')}`);
check.equal(done.status, 'completed');
if (done.status !== 'completed') throw new Error('unreachable');
check.deepEqual(done.result['structuredContent'], { layers: 3, frosting: 'chocolate' });
check.ok(seen.some(s => s.startsWith('input_required')));

// 2. A task cancelled while it waits for the frosting answer.
const second = await tasks.callTool({ name: 'bake_cake', arguments: { layers: 1 } });
if (second.kind !== 'task') throw new Error('expected a task handle');
await tasks
    .waitFor(second.task.taskId, {
        onUpdate: async task => {
            if (task.status === 'input_required') await tasks.cancel(task.taskId);
        }
    })
    .then(task => {
        console.log(`[client] task ${task.taskId} ended: ${task.status}`);
        check.equal(task.status, 'cancelled');
    });

// 3. Unknown task ids are -32602.
await tasks.get('no-such-task').then(
    () => check.fail('expected tasks/get to reject'),
    (error: unknown) => check.equal((error as { code?: number }).code, -32_602)
);

await client.close();
