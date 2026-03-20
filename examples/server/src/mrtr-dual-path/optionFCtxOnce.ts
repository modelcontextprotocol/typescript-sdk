/**
 * Option F: ctx.once — idempotency guard inside the monolithic handler.
 *
 * Same MRTR-native shape as A/E, but side-effects get wrapped in
 * `ctx.once(key, fn)`. The guard lives in `requestState` — on retry,
 * keys marked executed skip their fn. Makes the hazard *visible* at
 * the call site without restructuring the handler.
 *
 * Opt-in: an unwrapped `db.write()` above the guard still fires twice.
 * The footgun isn't eliminated — it's made reviewable. `ctx.once('x', …)`
 * reads differently from a bare call; a reviewer can grep for effects
 * that aren't wrapped.
 *
 * When to reach for this over G (ToolBuilder): single elicitation, one
 * or two side-effects, handler fits in ten lines. When the step count
 * hits 3+, the ToolBuilder boilerplate pays for itself.
 *
 * Run: DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/optionFCtxOnce.ts
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { acceptedContent, elicitForm, MrtrCtx, readMrtr, wrap } from './shims.js';

type Units = 'metric' | 'imperial';

function lookupWeather(location: string, units: Units): string {
    const temp = units === 'metric' ? '22°C' : '72°F';
    return `Weather in ${location}: ${temp}, partly cloudy.`;
}

// The side-effect the footgun is about. In Option B this was commented
// out; here it's live, because the guard makes it safe.
let auditCount = 0;
function auditLog(location: string): void {
    auditCount++;
    console.error(`[audit] lookup requested for ${location} (count=${auditCount})`);
}

const server = new McpServer({ name: 'mrtr-option-f', version: '0.0.0' });

server.registerTool(
    'weather',
    {
        description: 'Weather lookup (Option F: ctx.once idempotency guard)',
        inputSchema: z.object({ location: z.string(), _mrtr: z.unknown().optional() })
    },
    async ({ location, _mrtr }): Promise<CallToolResult> => {
        const ctx = new MrtrCtx(readMrtr({ _mrtr }));

        // ───────────────────────────────────────────────────────────────────
        // This is the hazard line. In A/E it would run on every retry.
        // Here it runs once — `ctx.once` checks requestState, skips on retry.
        // A reviewer sees `ctx.once` and knows the author considered
        // re-entry. A bare `auditLog(location)` would be the red flag.
        // ───────────────────────────────────────────────────────────────────
        ctx.once('audit', () => auditLog(location));

        const prefs = acceptedContent<{ units: Units }>(ctx.inputResponses, 'units');
        if (!prefs) {
            // `ctx.incomplete()` encodes the executed-keys set into
            // requestState so the `once` guard holds across retry.
            return wrap(
                ctx.incomplete({
                    units: elicitForm({
                        message: 'Which units?',
                        requestedSchema: {
                            type: 'object',
                            properties: { units: { type: 'string', enum: ['metric', 'imperial'], title: 'Units' } },
                            required: ['units']
                        }
                    })
                })
            );
        }

        return { content: [{ type: 'text', text: lookupWeather(location, prefs.units) }] };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[option-F] ready');
