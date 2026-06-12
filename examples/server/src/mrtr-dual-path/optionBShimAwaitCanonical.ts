/**
 * Option B: SDK shim, `await elicit()` as canonical. The footgun direction.
 *
 * Tool author writes today's `await elicit(...)` style. The shim routes:
 *   - 2025-11 client → native SSE, blocks inline (today's behaviour exactly)
 *   - 2026-06 client → `elicit()` throws `NeedsInputSignal`, shim catches it,
 *     emits `IncompleteResult`. On retry the handler runs from the top, and
 *     this time `elicit()` finds the answer in `inputResponses`.
 *
 * Author experience: zero migration. Handlers that work today keep working.
 * The `await` reads linearly.
 *
 * The problem: the `await` is a lie on MRTR sessions. Everything above it
 * re-executes on retry. See the commented-out `auditLog()` below — uncomment
 * it and a 2026-06 client triggers *two* audit entries for one tool call.
 * A 2025-11 client triggers one. Same source, different observable behaviour,
 * and nothing in the code warns you.
 *
 * This is the "wrap legacy `await elicitInput()` so it behaves like MRTR
 * bucket-1" follow-up #1597's README raised. It works for idempotent
 * handlers. It breaks silently for everything else.
 *
 * Run: DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx src/mrtr-dual-path/optionBShimAwaitCanonical.ts
 *      DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/optionBShimAwaitCanonical.ts
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { mrtrExceptionShim, readMrtr, wrap } from './shims.js';

type Units = 'metric' | 'imperial';

function lookupWeather(location: string, units: Units): string {
    const temp = units === 'metric' ? '22°C' : '72°F';
    return `Weather in ${location}: ${temp}, partly cloudy.`;
}

// Pretend side-effect to make the hazard concrete. Uncomment the call in
// the handler and watch the count diverge between protocol versions.
let auditCount = 0;
function auditLog(location: string): void {
    auditCount++;
    console.error(`[audit] lookup requested for ${location} (count=${auditCount})`);
}
void auditLog;

const server = new McpServer({ name: 'mrtr-option-b', version: '0.0.0' });

// ───────────────────────────────────────────────────────────────────────────
// This is what the tool author writes. Looks linear. Isn't, on MRTR.
// ───────────────────────────────────────────────────────────────────────────

const weatherHandler = mrtrExceptionShim<{ location: string }>(async ({ location }, elicit): Promise<CallToolResult> => {
    // auditLog(location);
    //   ^^^^^^^^^^^^^^^^^
    //   On 2025-11: runs once. On 2026-06: runs once on the initial call,
    //   once more on the retry. The await below isn't a suspension point
    //   on MRTR — it's a re-entry point. Nothing in this syntax says so.

    const prefs = await elicit<{ units: Units }>('units', {
        message: 'Which units?',
        requestedSchema: {
            type: 'object',
            properties: { units: { type: 'string', enum: ['metric', 'imperial'], title: 'Units' } },
            required: ['units']
        }
    });

    if (!prefs) {
        return { content: [{ type: 'text', text: 'Cancelled.' }] };
    }

    return { content: [{ type: 'text', text: lookupWeather(location, prefs.units) }] };
});

server.registerTool(
    'weather',
    {
        description: 'Weather lookup (Option B: SDK shim, await-elicit canonical)',
        inputSchema: z.object({ location: z.string(), _mrtr: z.unknown().optional() })
    },
    async ({ location, _mrtr }, ctx) => wrap(await weatherHandler({ location }, readMrtr({ _mrtr }), ctx))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[option-B] ready');
