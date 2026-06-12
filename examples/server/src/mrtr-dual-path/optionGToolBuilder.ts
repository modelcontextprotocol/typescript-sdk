/**
 * Option G: ToolBuilder — Marcelo's explicit step decomposition.
 *
 * The monolithic handler becomes a sequence of named step functions.
 * `incompleteStep` may return `IncompleteResult` (needs more input) or
 * a data object (satisfied, pass to next step). `endStep` receives
 * everything and runs exactly once — it's structurally unreachable
 * until every prior step has returned data.
 *
 * The footgun is eliminated by code shape, not discipline. There is
 * no "above the guard" zone because there is no guard — the SDK's
 * step-tracking (via `requestState`) is the guard. Side-effects go
 * in `endStep`; anything in an `incompleteStep` is documented as
 * must-be-idempotent, and the return-type split makes the distinction
 * visible at the function signature level.
 *
 * Boilerplate: two function definitions + `.build()` to replace
 * A/E's 3-line `if (!prefs) return`. Worth it at 3+ rounds or when
 * the side-effect story matters. Overkill for a single-question tool.
 *
 * Run: DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/optionGToolBuilder.ts
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { acceptedContent, elicitForm, readMrtr, ToolBuilder, wrap } from './shims.js';

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

const server = new McpServer({ name: 'mrtr-option-g', version: '0.0.0' });

// ───────────────────────────────────────────────────────────────────────────
// Step 1: ask for units. Returns IncompleteResult if not yet provided,
// or `{ units }` to pass forward. MUST be idempotent — it can re-run
// if requestState is tampered with (demo doesn't sign) or if the step
// before it isn't the most-recently-completed one. No side-effects here.
// ───────────────────────────────────────────────────────────────────────────

const askUnits = (_args: { location: string }, inputs: Parameters<typeof acceptedContent>[0]) => {
    const prefs = acceptedContent<{ units: Units }>(inputs, 'units');
    if (!prefs) {
        return {
            inputRequests: {
                units: elicitForm({
                    message: 'Which units?',
                    requestedSchema: {
                        type: 'object',
                        properties: { units: { type: 'string', enum: ['metric', 'imperial'], title: 'Units' } },
                        required: ['units']
                    }
                })
            }
        };
    }
    return { units: prefs.units };
};

// ───────────────────────────────────────────────────────────────────────────
// End step: has everything, does the work. Runs exactly once. This is
// where side-effects live — the SDK guarantees this function is not
// reached until `askUnits` (and any other incompleteSteps) have all
// returned data. The `auditLog` call here fires once regardless of how
// many MRTR rounds it took to collect the inputs.
// ───────────────────────────────────────────────────────────────────────────

const fetchWeather = ({ location }: { location: string }, collected: Record<string, unknown>): CallToolResult => {
    auditLog(location);
    const units = collected.units as Units;
    return { content: [{ type: 'text', text: lookupWeather(location, units) }] };
};

// ───────────────────────────────────────────────────────────────────────────
// Assembly. Steps are named (not ordinal) so reordering during
// development doesn't silently remap data. The builder is the
// MRTR-native handler; everything from A/E's dual-path discussion
// still applies (wrap in sseRetryShim for top-left, degrade for
// bottom-left). The footgun-prevention is orthogonal to that axis.
// ───────────────────────────────────────────────────────────────────────────

const weatherHandler = new ToolBuilder<{ location: string }>().incompleteStep('askUnits', askUnits).endStep(fetchWeather).build();

server.registerTool(
    'weather',
    {
        description: 'Weather lookup (Option G: ToolBuilder step decomposition)',
        inputSchema: z.object({ location: z.string(), _mrtr: z.unknown().optional() })
    },
    async ({ location, _mrtr }) => wrap(await weatherHandler({ location }, readMrtr({ _mrtr }), undefined as never))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[option-G] ready');
