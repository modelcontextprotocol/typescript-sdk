/**
 * Option H: ContinuationStore — `await ctx.elicit()` is genuinely linear.
 *
 * Counterpart to python-sdk#2322's option_h_linear.py. The Option B
 * footgun was: `await elicit()` LOOKS like a suspension point but is
 * actually a re-entry point, so everything above it runs twice. This
 * fixes that by making it a REAL suspension point — the Promise chain
 * is held in a `ContinuationStore` across MRTR rounds, keyed by
 * `request_state`.
 *
 * Handler code stays exactly as it was in the SSE era. Side-effects
 * above the await fire once because the function never restarts — it
 * resumes. Zero migration, zero footgun.
 *
 * Trade-off: the server holds the frame in memory between rounds.
 * Client still sees pure MRTR (no SSE, independent HTTP requests),
 * but the server is stateful *within a tool call*. Horizontal scale
 * needs sticky routing on the `request_state` token. Same operational
 * shape as Option A's SSE hold, without the long-lived connection.
 *
 * When to reach for this: migrating SSE-era tools to MRTR wire protocol
 * without rewriting the handler, or when the linear style is genuinely
 * clearer than guard-first (complex branching, many rounds). If the
 * deployment can do sticky routing (most can — hash the token), this
 * is strictly better than B: same ergonomics, no footgun.
 *
 * When not to: if you need true statelessness across server instances
 * (lambda, ephemeral workers, no sticky routing). Use E/F/G — they
 * encode everything in `request_state` itself.
 *
 * Run: DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/optionHContinuationStore.ts
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { LinearCtx } from './shims.js';
import { ContinuationStore, linearMrtr, readMrtr, wrap } from './shims.js';

type Units = 'metric' | 'imperial';

function lookupWeather(location: string, units: Units): string {
    const temp = units === 'metric' ? '22°C' : '72°F';
    return `Weather in ${location}: ${temp}, partly cloudy.`;
}

let auditCount = 0;
function auditLog(location: string): void {
    auditCount++;
    console.error(`[audit] lookup requested for ${location} (count=${auditCount})`);
}

// ───────────────────────────────────────────────────────────────────────────
// This is what the tool author writes. Linear, front-to-back, no re-entry
// contract to reason about. The `auditLog` above the await fires exactly
// once — the await is a real suspension point, not a goto.
//
// Compare to Option B where the same `auditLog` line fires twice. Here
// it's safe because the function never restarts. The ContinuationStore
// holds the suspended Promise; the retry's `inputResponses` resolves it.
// ───────────────────────────────────────────────────────────────────────────

async function weather(args: { location: string }, ctx: LinearCtx): Promise<string> {
    auditLog(args.location);

    const prefs = await ctx.elicit<{ units: Units }>('Which units?', {
        type: 'object',
        properties: { units: { type: 'string', enum: ['metric', 'imperial'], title: 'Units' } },
        required: ['units']
    });

    return lookupWeather(args.location, prefs.units);
}

// ───────────────────────────────────────────────────────────────────────────
// Registration. The store is a per-process Map<token, Continuation>.
// Unlike the Python version this doesn't need an explicit context
// manager — Node's event loop keeps pending Promises alive without
// a task group. TTL (default 5min) cleans up abandoned frames.
// ───────────────────────────────────────────────────────────────────────────

const store = new ContinuationStore();
const weatherHandler = linearMrtr(weather, store);

const server = new McpServer({ name: 'mrtr-option-h', version: '0.0.0' });

server.registerTool(
    'weather',
    {
        description: 'Weather lookup (Option H: ContinuationStore, genuinely linear await)',
        inputSchema: z.object({ location: z.string(), _mrtr: z.unknown().optional() })
    },
    async ({ location, _mrtr }) => wrap(await weatherHandler({ location }, readMrtr({ _mrtr }), undefined as never))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[option-H] ready');
