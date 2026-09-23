/**
 * MRTR backwards-compatibility exploration — scenario 2 of 3.
 *
 * "Continuation state" case: the tool performs a multi-step conversation
 * where each elicitation depends on the answers that came before. In the
 * pre-MRTR world the handler's local variables hold that accumulated
 * context across `await elicitInput()` calls. Under MRTR the handler
 * must be re-entrant, so that context has to be serialised into
 * `requestState` and threaded back through the client.
 *
 * Migration verdict: manageable but non-trivial. The handler becomes a
 * small state machine: on each entry it decodes `requestState`, figures
 * out which step it's on, and either asks the next question or completes.
 * Nothing about the *business logic* changes, only where the intermediate
 * state lives (serialised blob vs. local variables).
 *
 * The demo mirrors the ADO "custom rules" example from the SEP: resolving
 * a work item triggers a cascade of conditionally-required fields.
 *
 * Run with: pnpm tsx src/mrtr-backcompat/02ContinuationState.ts
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { InputRequests } from './shims.js';
import { acceptedContent, decodeState, elicitForm, encodeState, readMrtr, wrap } from './shims.js';

// ---------------------------------------------------------------------------
// Domain model — the simulated ADO rules from the SEP's real-world example.
// Rule 1: State→Resolved requires `resolution`.
// Rule 2: resolution=Duplicate requires `duplicateOfId`.
// ---------------------------------------------------------------------------

type Resolution = 'Fixed' | "Won't Fix" | 'Duplicate' | 'By Design';

interface WorkItemUpdate {
    workItemId: number;
    newState: 'Resolved';
    resolution?: Resolution;
    duplicateOfId?: number;
}

function applyUpdate(u: Required<Pick<WorkItemUpdate, 'workItemId' | 'newState'>> & Partial<WorkItemUpdate>): string {
    // In reality: a PATCH to the ADO REST API. Deferred until we have every
    // required field, so it runs exactly once.
    const extra = u.resolution === 'Duplicate' ? ` of #${u.duplicateOfId}` : '';
    return `Work item #${u.workItemId} → ${u.newState} (${u.resolution}${extra}).`;
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'mrtr-02-continuation-state', version: '0.0.0' });

// ─────────────────────────────────────────────────────────────────────────────
// BEFORE: current SDK pattern.
//
// Sequential awaits. Each answer lands in a local (`resolution`,
// `dupeId`), naturally carrying context into the next question.
// This is the ergonomic win of the current model — but it's exactly what
// makes the handler non-resumable across server instances.
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
    'resolve_work_item_before',
    {
        description: 'Resolve a work item (pre-MRTR: sequential await elicitInput)',
        inputSchema: z.object({
            workItemId: z.number().int()
        })
    },
    async ({ workItemId }, ctx): Promise<CallToolResult> => {
        // Step 1 — rule 1 fires unconditionally on Resolve.
        const r1 = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `Resolving #${workItemId} requires a resolution. How was this bug resolved?`,
            requestedSchema: {
                type: 'object',
                properties: {
                    resolution: {
                        type: 'string',
                        enum: ['Fixed', "Won't Fix", 'Duplicate', 'By Design'],
                        title: 'Resolution'
                    }
                },
                required: ['resolution']
            }
        });
        if (r1.action !== 'accept' || !r1.content) {
            return { content: [{ type: 'text', text: 'Cancelled.' }] };
        }
        const resolution = r1.content.resolution as Resolution;

        // Step 2 — rule 2 fires only if resolution was Duplicate.
        // `resolution` is a local variable: free continuation state.
        let duplicateOfId: number | undefined;
        if (resolution === 'Duplicate') {
            const r2 = await ctx.mcpReq.elicitInput({
                mode: 'form',
                message: 'Since this is a duplicate, which work item is the original?',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        duplicateOfId: { type: 'number', title: 'Duplicate of (work item ID)' }
                    },
                    required: ['duplicateOfId']
                }
            });
            if (r2.action !== 'accept' || !r2.content) {
                return { content: [{ type: 'text', text: 'Cancelled.' }] };
            }
            duplicateOfId = r2.content.duplicateOfId as number;
        }

        return {
            content: [{ type: 'text', text: applyUpdate({ workItemId, newState: 'Resolved', resolution, duplicateOfId }) }]
        };
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// AFTER: MRTR pattern with requestState.
//
// The handler is a resumable state machine. Each entry:
//   1. Decodes `requestState` (if any) to recover prior answers.
//   2. Merges in any new `inputResponses` from this round-trip.
//   3. Decides: can we complete? If not, what's the *next* thing to ask?
//   4. Encodes the merged state back into `requestState` for the next round.
//
// Note the trade-off vs. scenario 1: we *could* skip requestState and
// simply re-ask for resolution every time (it's not expensive for the
// server). But that means re-prompting the user, which is bad UX. The
// requestState mechanism exists precisely so the client doesn't have to
// re-answer things it already answered.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Continuation state shape. Keep this small — everything here round-trips
 * through the client, so size matters for latency.
 *
 * In production this would be signed/encrypted (see shims.ts).
 */
interface Continuation {
    resolution?: Resolution;
    // We don't store duplicateOfId here because as soon as we have it
    // (when needed) we can complete — there's no step after it.
}

server.registerTool(
    'resolve_work_item_after',
    {
        description: 'Resolve a work item (MRTR: re-entrant with requestState)',
        inputSchema: z.object({
            workItemId: z.number().int(),
            _mrtr: z.unknown().optional()
        })
    },
    async ({ workItemId, _mrtr }): Promise<CallToolResult> => {
        const { inputResponses, requestState } = readMrtr({ _mrtr });

        // (1) Recover prior state. Start from scratch if absent/invalid —
        //     the worst case is we ask the user again, which is the SEP's
        //     prescribed recovery for malformed state anyway.
        const prior = decodeState<Continuation>(requestState) ?? {};

        // (2) Merge new answers. The client only ever sends the responses
        //     for *this* round's inputRequests, so at most one of these
        //     will be present per invocation.
        const resolutionAnswer = acceptedContent<{ resolution: Resolution }>(inputResponses, 'resolution');
        const resolution = prior.resolution ?? resolutionAnswer?.resolution;

        // (3) State machine.

        // Step 1: no resolution yet → ask for it.
        if (!resolution) {
            return wrap({
                inputRequests: {
                    resolution: elicitForm({
                        message: `Resolving #${workItemId} requires a resolution. How was this bug resolved?`,
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                resolution: {
                                    type: 'string',
                                    enum: ['Fixed', "Won't Fix", 'Duplicate', 'By Design'],
                                    title: 'Resolution'
                                }
                            },
                            required: ['resolution']
                        }
                    })
                }
                // No requestState needed yet: the only thing we know is
                // `workItemId`, and that's already a tool argument.
            });
        }

        // Step 2: resolution=Duplicate and we still need duplicateOfId.
        if (resolution === 'Duplicate') {
            const dupAnswer = acceptedContent<{ duplicateOfId: number }>(inputResponses, 'duplicateOf');
            if (!dupAnswer) {
                const next: Continuation = { resolution };
                const inputRequests: InputRequests = {
                    duplicateOf: elicitForm({
                        message: 'Since this is a duplicate, which work item is the original?',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                duplicateOfId: { type: 'number', title: 'Duplicate of (work item ID)' }
                            },
                            required: ['duplicateOfId']
                        }
                    })
                };
                // Encode `resolution` into requestState so that whichever
                // server instance handles the retry doesn't have to ask
                // for it again. This is the crux of scenario 2.
                return wrap({ inputRequests, requestState: encodeState(next) });
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: applyUpdate({ workItemId, newState: 'Resolved', resolution, duplicateOfId: dupAnswer.duplicateOfId })
                    }
                ]
            };
        }

        // Step 2': resolution ≠ Duplicate → no further questions, complete now.
        return {
            content: [{ type: 'text', text: applyUpdate({ workItemId, newState: 'Resolved', resolution }) }]
        };
    }
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mrtr-02] ready (resolve_work_item_before, resolve_work_item_after)');
