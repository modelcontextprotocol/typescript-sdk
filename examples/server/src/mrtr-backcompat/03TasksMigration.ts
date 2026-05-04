/**
 * MRTR backwards-compatibility exploration — scenario 3 of 3.
 *
 * "Persistent" case: the tool performs a mutation *before* the elicitation.
 * If the client retries the entire tool call from scratch (as MRTR requires),
 * that mutation happens twice. This is the class of handler that the
 * ephemeral MRTR workflow **cannot** rescue on its own.
 *
 * Migration verdict: these tools should move to the Tasks workflow. The
 * mutation becomes the "create task" step (happens exactly once, gets a
 * durable ID), the elicitation is expressed via `status: input_required`
 * on that task, and the final step runs when the client delivers the
 * response via `tasks/input_response`.
 *
 * This demo registers the unsafe-to-retry "before" tool so the hazard is
 * visible at runtime. The "after" side is a **sketch** of the Tasks shape
 * — see `simpleTaskInteractive.ts` in this same folder for a fully wired
 * Tasks server. Duplicating that plumbing here would obscure the
 * comparison rather than clarify it.
 *
 * Run with: pnpm tsx src/mrtr-backcompat/03TasksMigration.ts
 */

import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Simulated provisioning backend.
//
// `createVm()` is the kind of expensive, externally-visible side effect
// (billing, quota, audit trail) that makes naive retry unacceptable.
// ---------------------------------------------------------------------------

interface Vm {
    id: string;
    name: string;
    attached: boolean;
}

const provisioned: Vm[] = [];

function createVm(name: string): Vm {
    const vm: Vm = { id: `vm-${randomUUID().slice(0, 8)}`, name, attached: false };
    provisioned.push(vm);
    console.error(`[backend] provisioned ${vm.id} (total now: ${provisioned.length})`);
    return vm;
}

function attachDisk(vmId: string): void {
    const vm = provisioned.find(v => v.id === vmId);
    if (vm) vm.attached = true;
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'mrtr-03-tasks-migration', version: '0.0.0' });

// ─────────────────────────────────────────────────────────────────────────────
// BEFORE: current SDK pattern — and why it's unsafe under MRTR.
//
// mutation → await elicitInput → mutation. Under today's protocol the
// handler's async frame stays alive across the elicitation round-trip, so
// `createVm()` runs exactly once. Under MRTR the client would re-invoke
// the *entire* handler on retry, and the second invocation would call
// `createVm()` again → two VMs, one orphaned.
//
// You cannot fix this with requestState alone: by the time you're asked
// to return an IncompleteResult, the VM already exists. Encoding its ID
// into requestState helps the *retry* skip the create, but does nothing
// if the client abandons the flow — the orphan is still there.
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
    'provision_vm_before',
    {
        description: 'Provision a VM (pre-MRTR: UNSAFE to naively convert to MRTR)',
        inputSchema: z.object({
            name: z.string()
        })
    },
    async ({ name }, ctx): Promise<CallToolResult> => {
        // Mutation BEFORE elicitation. This is the problematic pattern.
        const vm = createVm(name);

        const result = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `Attach a persistent disk to ${vm.id}?`,
            requestedSchema: {
                type: 'object',
                properties: { attach: { type: 'boolean', title: 'Attach disk' } },
                required: ['attach']
            }
        });

        if (result.action === 'accept' && result.content?.attach === true) {
            attachDisk(vm.id);
        }

        return {
            content: [{ type: 'text', text: `Ready: ${vm.id} (disk ${vm.attached ? 'attached' : 'detached'})` }]
        };
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// AFTER: Tasks-workflow shape (sketch).
//
// The SEP prescribes Tasks for persistent tools: the task ID *is* the
// handle to the already-performed mutation. The client can poll, cancel,
// or let the task time out — none of which the ephemeral MRTR flow can
// model. The key structural shift:
//
//   - createTask:   perform the mutation ONCE, persist the task, return ID.
//   - getTask:      report `input_required` when waiting on the client.
//   - tasks/result: surface the InputRequests payload.
//   - tasks/input_response: accept the InputResponses, resume work.
//   - getTaskResult: return the final CallToolResult once `completed`.
//
// The sketch below shows the handler shape against the SDK's experimental
// `ToolTaskHandler`. It uses an in-process store and does NOT implement
// the `tasks/input_response` plumbing — that requires transport-level
// changes the SEP introduces. See `../simpleTaskInteractive.ts` for the
// full message-queue wiring today's SDK needs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-task state the handler persists. In production this lives in the
 * real TaskStore (Redis, Postgres, etc.) so any server instance can
 * handle any phase.
 */
interface ProvisionTaskRecord {
    status: 'working' | 'input_required' | 'completed';
    vmId: string;
    attachDecision?: boolean;
}

// Demo-only in-memory store. Real deployments back this with durable
// storage — which these tools already need for the VM lifecycle anyway,
// so the incremental cost of storing task state is low.
const taskRecords = new Map<string, ProvisionTaskRecord>();

// Reference the map so the example typechecks/lints as a runnable demo
// even though the sketch isn't wired into the transport.
void taskRecords;

/**
 * Sketch of the Tasks handler shape. Exported for reference from the
 * README; not registered on this demo server because the SDK's current
 * Tasks wiring (message queue + result handler) would triple the file
 * length without adding clarity to the comparison.
 */
export const provisionVmTaskHandlerSketch = {
    /**
     * Phase 1 — initial tools/call.
     *
     * Crucially: this runs ONCE. It allocates the VM, persists a task
     * record pointing at it, and returns the task envelope. The client
     * now holds a durable handle and will drive the rest via `tasks/*`.
     */
    createTask(args: { name: string }): { taskId: string } {
        const vm = createVm(args.name);
        const taskId = `task-${vm.id}`;
        taskRecords.set(taskId, { status: 'input_required', vmId: vm.id });
        // The real `ctx.task.store.createTask()` returns a full
        // CreateTaskResult (ttl, pollInterval, etc.); abbreviated here.
        return { taskId };
    },

    /**
     * Phase 2 — tasks/get.
     *
     * Reports status. When `input_required`, the client knows to call
     * `tasks/result` to fetch the InputRequests payload.
     */
    getTask(taskId: string): { status: ProvisionTaskRecord['status']; statusMessage: string } {
        const rec = taskRecords.get(taskId);
        if (!rec) throw new Error(`unknown task: ${taskId}`);
        return {
            status: rec.status,
            statusMessage:
                rec.status === 'input_required' ? 'Waiting for disk-attachment decision (call tasks/result)' : `Task ${rec.status}.`
        };
    },

    /**
     * Phase 2.5 — tasks/result while status=input_required.
     *
     * This is the SEP's integration point: instead of the CallToolResult,
     * the server returns an InputRequests payload (plus related-task
     * metadata). Shown as pseudo-JSON because the wire types don't exist
     * in the SDK yet.
     */
    // pseudo:
    //   getTaskResult(taskId) when input_required -->
    //     { inputRequests: { attach: elicitForm({...}) },
    //       _meta: { [RELATED_TASK_META_KEY]: { taskId } } }

    /**
     * Phase 3 — tasks/input_response (new method from the SEP).
     *
     * Client delivers InputResponses + task metadata; server updates the
     * record and flips status back to `working`/`completed`.
     */
    provideInputResponse(taskId: string, attach: boolean): void {
        const rec = taskRecords.get(taskId);
        if (!rec) throw new Error(`unknown task: ${taskId}`);
        rec.attachDecision = attach;
        if (attach) attachDisk(rec.vmId);
        rec.status = 'completed';
    },

    /**
     * Phase 4 — tasks/result while status=completed.
     */
    getTaskResult(taskId: string): CallToolResult {
        const rec = taskRecords.get(taskId);
        if (!rec || rec.status !== 'completed') throw new Error(`task ${taskId} not complete`);
        const vm = provisioned.find(v => v.id === rec.vmId);
        return {
            content: [{ type: 'text', text: `Ready: ${rec.vmId} (disk ${vm?.attached ? 'attached' : 'detached'})` }]
        };
    }
};

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mrtr-03] ready (provision_vm_before; see sketch for after-shape)');
