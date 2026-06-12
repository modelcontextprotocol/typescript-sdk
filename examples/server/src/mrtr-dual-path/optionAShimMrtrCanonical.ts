/**
 * Option A: SDK shim, MRTR as canonical. Hidden retry loop.
 *
 * Tool author writes MRTR-native code only. The SDK wrapper (`sseRetryShim`)
 * detects the negotiated version:
 *   - 2026-06 client → pass `IncompleteResult` through, client drives retry
 *   - 2025-11 client → SDK emulates the retry loop locally, fulfilling each
 *     `InputRequest` via real SSE elicitation, re-invoking the handler until
 *     it returns a complete result
 *
 * Author experience: one code path. Re-entry is explicit in the source
 * (the `if (!prefs)` guard), so the handler is safe to re-invoke by
 * construction. But the *fact* that it's re-invoked for old clients is
 * invisible — the shim is doing work the author can't see.
 *
 * What makes this the "⚠️ clunky" cell: the SDK is running a loop on the
 * author's behalf. If the handler has a subtle ordering assumption between
 * rounds, or does something expensive before the guard, the author won't
 * find out until an old client connects in prod. It works, but it's magic.
 *
 * Run: DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx src/mrtr-dual-path/optionAShimMrtrCanonical.ts
 *      DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/optionAShimMrtrCanonical.ts
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { MrtrHandler } from './shims.js';
import { acceptedContent, elicitForm, sseRetryShim } from './shims.js';

type Units = 'metric' | 'imperial';

function lookupWeather(location: string, units: Units): string {
    const temp = units === 'metric' ? '22°C' : '72°F';
    return `Weather in ${location}: ${temp}, partly cloudy.`;
}

const server = new McpServer({ name: 'mrtr-option-a', version: '0.0.0' });

// ───────────────────────────────────────────────────────────────────────────
// This is what the tool author writes. One function, MRTR-native.
// No version check, no SSE awareness. The `if (!prefs)` guard IS the
// re-entry contract; the author sees it, but doesn't see the shim calling
// this function in a loop for 2025-11 sessions.
// ───────────────────────────────────────────────────────────────────────────

const weatherHandler: MrtrHandler<{ location: string }> = async ({ location }, { inputResponses }) => {
    const prefs = acceptedContent<{ units: Units }>(inputResponses, 'units');
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

    return { content: [{ type: 'text', text: lookupWeather(location, prefs.units) }] };
};

// ───────────────────────────────────────────────────────────────────────────
// Registration applies the shim. In a real SDK this could be a flag on
// `registerTool` itself, or inferred from the handler signature — the point
// is the author opts in once at registration, not per-call.
// ───────────────────────────────────────────────────────────────────────────

server.registerTool(
    'weather',
    {
        description: 'Weather lookup (Option A: SDK shim, MRTR canonical)',
        inputSchema: z.object({ location: z.string() })
    },
    sseRetryShim(weatherHandler)
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[option-A] ready');
