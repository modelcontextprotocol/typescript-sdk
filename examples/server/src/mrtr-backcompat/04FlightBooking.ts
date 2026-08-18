/**
 * MRTR backwards-compatibility exploration — scenario 2b (linear wizard).
 *
 * A companion to `02ContinuationState.ts`. Where 02 demonstrates
 * *conditional* branching (the second question only exists if the first
 * answer was "Duplicate"), this demo shows *linear accumulation*: a
 * fixed-length wizard where each step adds to a growing bundle of
 * answers and the final step consumes the whole bundle.
 *
 * This is the most common shape of multi-elicitation tool in the wild —
 * booking wizards, setup flows, onboarding. The `requestState` story
 * here is dead simple: stuff every answer in, pass it back, read it
 * out on the next round.
 *
 * Worth noticing in the "after" handler:
 *
 *   - The state blob *grows* across rounds (route → route+dates →
 *     complete). This is the SEP's intended use: each IncompleteResult
 *     re-encodes everything gathered so far, so the retry is
 *     self-contained.
 *
 *   - Elicitation prompts can reference prior answers ("dates for
 *     LHR → SFO?"). In the "before" world those come from closure
 *     variables; under MRTR they're decoded from requestState. Same
 *     UX, different source.
 *
 *   - No branching → the state-machine logic is a flat sequence of
 *     "missing X? ask for X" checks. Much simpler than 02's
 *     conditional cascade. Most real-world migrations will look more
 *     like this file than like 02.
 *
 * Run with: pnpm tsx src/mrtr-backcompat/04FlightBooking.ts
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { acceptedContent, decodeState, elicitForm, encodeState, readMrtr, wrap } from './shims.js';

// ---------------------------------------------------------------------------
// Domain: a toy booking backend. Stateless lookups only — the actual
// "confirm booking" mutation is deferred until we have every answer, so
// it runs exactly once (no scenario-3 problems here).
// ---------------------------------------------------------------------------

interface Itinerary {
    from: string;
    to: string;
    depart: string;
    ret?: string;
    pax: number;
    cabin: 'economy' | 'premium' | 'business';
}

function quote(itin: Itinerary): number {
    const base = { economy: 120, premium: 340, business: 900 }[itin.cabin];
    const oneWay = !itin.ret;
    return base * itin.pax * (oneWay ? 1 : 2);
}

function confirmBooking(itin: Itinerary): string {
    // In reality: POST to the booking API. Happens once, at the very end,
    // with the full itinerary assembled — which is why this tool stays in
    // scenario 2 territory rather than scenario 3.
    const ref = `BK${(itin.from + itin.to).toUpperCase().slice(0, 4)}${Math.floor(Math.random() * 900 + 100)}`;
    const legs = itin.ret ? `${itin.depart} / ${itin.ret}` : itin.depart;
    return `Booked ${itin.from.toUpperCase()}→${itin.to.toUpperCase()} (${legs}), ${itin.pax}×${itin.cabin}. Ref ${ref}. Total $${quote(itin)}.`;
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'mrtr-04-flight-booking', version: '0.0.0' });

// ─────────────────────────────────────────────────────────────────────────────
// BEFORE: current SDK pattern.
//
// Three sequential `await elicitInput()` calls. Each answer lands in a
// local variable and is implicitly carried into the next prompt's
// message text. Clean and readable — this is the ergonomic baseline
// MRTR needs to match.
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
    'book_flight_before',
    {
        description: 'Flight booking wizard (pre-MRTR: three sequential awaits)',
        inputSchema: z.object({})
    },
    async (_args, ctx): Promise<CallToolResult> => {
        // Step 1: route
        const r1 = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: 'Where are you flying?',
            requestedSchema: {
                type: 'object',
                properties: {
                    from: { type: 'string', title: 'From (airport code)', minLength: 3, maxLength: 3 },
                    to: { type: 'string', title: 'To (airport code)', minLength: 3, maxLength: 3 }
                },
                required: ['from', 'to']
            }
        });
        if (r1.action !== 'accept' || !r1.content) {
            return { content: [{ type: 'text', text: 'Booking cancelled.' }] };
        }
        const from = r1.content.from as string;
        const to = r1.content.to as string;

        // Step 2: dates — prompt references step 1's answers (closure vars)
        const r2 = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `Dates for ${from.toUpperCase()} → ${to.toUpperCase()}? (leave return blank for one-way)`,
            requestedSchema: {
                type: 'object',
                properties: {
                    depart: { type: 'string', title: 'Departure date', format: 'date' },
                    ret: { type: 'string', title: 'Return date (optional)', format: 'date' }
                },
                required: ['depart']
            }
        });
        if (r2.action !== 'accept' || !r2.content) {
            return { content: [{ type: 'text', text: 'Booking cancelled.' }] };
        }
        const depart = r2.content.depart as string;
        const ret = r2.content.ret as string | undefined;

        // Step 3: passengers + cabin
        const r3 = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: 'Passengers and cabin class?',
            requestedSchema: {
                type: 'object',
                properties: {
                    pax: { type: 'integer', title: 'Passengers', minimum: 1, maximum: 9 },
                    cabin: { type: 'string', enum: ['economy', 'premium', 'business'], title: 'Cabin' }
                },
                required: ['pax', 'cabin']
            }
        });
        if (r3.action !== 'accept' || !r3.content) {
            return { content: [{ type: 'text', text: 'Booking cancelled.' }] };
        }
        const pax = r3.content.pax as number;
        const cabin = r3.content.cabin as Itinerary['cabin'];

        // All answers are locals — assemble and confirm.
        return { content: [{ type: 'text', text: confirmBooking({ from, to, depart, ret, pax, cabin }) }] };
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// AFTER: MRTR with requestState.
//
// The three closure variables above become a single serialised blob that
// round-trips through the client. Each invocation decodes it, merges the
// answer from this round's inputResponses, and either asks the next
// question (with the *grown* blob re-encoded) or completes.
//
// The shape is a fall-through chain of "have X yet?" checks. Because the
// wizard is linear, there's exactly one missing piece at any given time,
// so the merge logic stays trivial — we never have to reconcile
// out-of-order or partial answers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the wizard has collected so far. Grows monotonically:
 *   round 1 →  {}
 *   round 2 →  { from, to }
 *   round 3 →  { from, to, depart, ret? }
 *   final   →  full Itinerary (never encoded — we complete instead)
 *
 * Real implementations sign/encrypt this (see shims.ts). Size matters
 * too: an extravagant wizard with many steps would want to consider
 * whether a task store is cheaper than shipping a kilobyte-scale blob
 * through every HTTP round-trip.
 */
type BookingState = Partial<Pick<Itinerary, 'from' | 'to' | 'depart' | 'ret'>>;

server.registerTool(
    'book_flight_after',
    {
        description: 'Flight booking wizard (MRTR: linear requestState accumulation)',
        inputSchema: z.object({
            _mrtr: z.unknown().optional()
        })
    },
    async ({ _mrtr }): Promise<CallToolResult> => {
        const { inputResponses, requestState } = readMrtr({ _mrtr });
        const prior = decodeState<BookingState>(requestState) ?? {};

        // Merge this round's answer (at most one key will be present).
        // We give each step a stable key so the merge is trivial and so
        // a misbehaving client sending a stale key is harmlessly ignored.
        const route = acceptedContent<{ from: string; to: string }>(inputResponses, 'route');
        const dates = acceptedContent<{ depart: string; ret?: string }>(inputResponses, 'dates');
        const details = acceptedContent<{ pax: number; cabin: Itinerary['cabin'] }>(inputResponses, 'details');

        const from = prior.from ?? route?.from;
        const to = prior.to ?? route?.to;
        const depart = prior.depart ?? dates?.depart;
        // `ret` is genuinely optional, so distinguish "not asked yet" from
        // "asked, user left it blank". We key off `depart` being known.
        const ret = prior.depart === undefined ? dates?.ret : prior.ret;

        // ── Step 1: need route? ─────────────────────────────────────────
        if (!from || !to) {
            return wrap({
                inputRequests: {
                    route: elicitForm({
                        message: 'Where are you flying?',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                from: { type: 'string', title: 'From (airport code)', minLength: 3, maxLength: 3 },
                                to: { type: 'string', title: 'To (airport code)', minLength: 3, maxLength: 3 }
                            },
                            required: ['from', 'to']
                        }
                    })
                }
                // No requestState: we haven't learned anything yet.
            });
        }

        // ── Step 2: need dates? ─────────────────────────────────────────
        if (!depart) {
            // State now carries the route so the next server instance can
            // (a) skip re-asking and (b) reference it in the prompt text.
            const state: BookingState = { from, to };
            return wrap({
                inputRequests: {
                    dates: elicitForm({
                        // Prompt references prior state — same UX as
                        // `before`'s closure-variable interpolation.
                        message: `Dates for ${from.toUpperCase()} → ${to.toUpperCase()}? (leave return blank for one-way)`,
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                depart: { type: 'string', title: 'Departure date', format: 'date' },
                                ret: { type: 'string', title: 'Return date (optional)', format: 'date' }
                            },
                            required: ['depart']
                        }
                    })
                },
                requestState: encodeState(state)
            });
        }

        // ── Step 3: need pax + cabin? ───────────────────────────────────
        if (!details) {
            // State has grown: route + dates. This is the "accumulation"
            // the demo exists to illustrate — contrast with 02 where the
            // blob is one field and the growth is in the question tree.
            const state: BookingState = { from, to, depart, ret };
            return wrap({
                inputRequests: {
                    details: elicitForm({
                        message: 'Passengers and cabin class?',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                pax: { type: 'integer', title: 'Passengers', minimum: 1, maximum: 9 },
                                cabin: { type: 'string', enum: ['economy', 'premium', 'business'], title: 'Cabin' }
                            },
                            required: ['pax', 'cabin']
                        }
                    })
                },
                requestState: encodeState(state)
            });
        }

        // ── Complete. ────────────────────────────────────────────────────
        // Everything we need is either in `prior` (decoded from the blob)
        // or in `details` (this round's inputResponses). Assemble and go.
        const itin: Itinerary = { from, to, depart, ret, pax: details.pax, cabin: details.cabin };
        return { content: [{ type: 'text', text: confirmBooking(itin) }] };
    }
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mrtr-04] ready (book_flight_before, book_flight_after)');
