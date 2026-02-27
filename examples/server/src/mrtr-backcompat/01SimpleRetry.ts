/**
 * MRTR backwards-compatibility exploration — scenario 1 of 3.
 *
 * "Simple" case: the tool is idempotent. All work before and after the
 * elicitation is pure / read-only, so if the client drops the connection
 * and re-invokes the tool from scratch, no harm is done. The only cost of
 * restarting is a little wasted compute.
 *
 * Migration verdict: trivial. The `await elicitInput(...)` call becomes a
 * one-shot "do I already have the answer?" check at the top of the
 * handler. No `requestState` is needed because the handler is cheap to
 * re-enter — the arguments plus the single elicitation response are
 * sufficient to compute the result.
 *
 * This demo registers two tools side-by-side on one server:
 *   - weather_before:  today's `await ctx.mcpReq.elicitInput(...)` style
 *   - weather_after:   MRTR style: return IncompleteResult, resume on retry
 *
 * Run with: pnpm tsx src/mrtr-backcompat/01SimpleRetry.ts
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { acceptedContent, elicitForm, readMrtr, wrap } from './shims.js';

// ---------------------------------------------------------------------------
// Simulated external lookup. Stateless, deterministic — restarting from
// scratch costs nothing but latency.
// ---------------------------------------------------------------------------

type Units = 'metric' | 'imperial';

function lookupWeather(location: string, units: Units): string {
    // In a real server this would be an HTTP GET to a weather API: no
    // side-effects, safe to call again on retry.
    const temp = units === 'metric' ? '22°C' : '72°F';
    return `Weather in ${location}: ${temp}, partly cloudy.`;
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'mrtr-01-simple-retry', version: '0.0.0' });

// ─────────────────────────────────────────────────────────────────────────────
// BEFORE: current SDK pattern.
//
// The handler awaits elicitInput mid-execution. Under the hood this issues
// an `elicitation/create` request on the POST SSE stream and blocks until
// the client delivers a matching response on a *separate* HTTP request.
// Works, but requires stateful routing (or shared storage) so that the
// elicitation response finds its way back to this in-flight await.
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
    'weather_before',
    {
        description: 'Weather lookup (pre-MRTR: inline await elicitInput)',
        inputSchema: z.object({
            location: z.string().describe('City name')
        })
    },
    async ({ location }, ctx): Promise<CallToolResult> => {
        // The tool needs the user's unit preference. Today it asks inline:
        const result = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: 'Which units?',
            requestedSchema: {
                type: 'object',
                properties: {
                    units: { type: 'string', enum: ['metric', 'imperial'], title: 'Units' }
                },
                required: ['units']
            }
        });

        if (result.action !== 'accept' || !result.content) {
            return { content: [{ type: 'text', text: 'Cancelled.' }] };
        }

        const units = result.content.units as Units;
        return { content: [{ type: 'text', text: lookupWeather(location, units) }] };
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// AFTER: MRTR pattern.
//
// Structural change: the handler is re-entrant. Every invocation starts by
// checking whether the elicitation response is already present (carried on
// the retry via `inputResponses`). If not, it describes what it needs and
// returns — no await, no in-memory state, no SSE dependency. The *entire*
// handler can run on any server instance because it consumes only what's
// in the request.
//
// The migration for this class of tool is nearly mechanical: invert the
// control flow from "await answer" to "check for answer, else ask".
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
    'weather_after',
    {
        description: 'Weather lookup (MRTR: return IncompleteResult, resume on retry)',
        inputSchema: z.object({
            location: z.string().describe('City name'),
            // Stand-in for the SEP's `params.inputResponses` until the
            // transport/SDK thread it through natively. Optional so the
            // initial call looks identical to a normal tool invocation.
            _mrtr: z.unknown().optional()
        })
    },
    async ({ location, _mrtr }): Promise<CallToolResult> => {
        const { inputResponses } = readMrtr({ _mrtr });

        // 1. Check: did the client already answer "units"?
        const prefs = acceptedContent<{ units: Units }>(inputResponses, 'units');
        if (!prefs) {
            // 2. Not yet — describe what we need and return immediately.
            //    No server-side state is retained; the client will retry
            //    with `inputResponses.units` populated.
            return wrap({
                inputRequests: {
                    units: elicitForm({
                        message: 'Which units?',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                units: { type: 'string', enum: ['metric', 'imperial'], title: 'Units' }
                            },
                            required: ['units']
                        }
                    })
                }
                // No requestState: `location` comes back on the retry as a
                // regular argument, and the lookup is cheap/idempotent, so
                // there's nothing worth carrying.
            });
        }

        // 3. We have everything. Compute and return the real result.
        return { content: [{ type: 'text', text: lookupWeather(location, prefs.units) }] };
    }
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr: stdout is reserved for the stdio transport's JSON-RPC frames.
console.error('[mrtr-01] ready (weather_before, weather_after)');
