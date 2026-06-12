/**
 * Option E: graceful degradation. The SDK default.
 *
 * Tool author writes MRTR-native code. Pre-MRTR clients get a tool-level
 * error for *this tool*: "requires a newer client." The server itself
 * works fine — version negotiation succeeds, tools/list is complete, every
 * other tool on the server is unaffected. Only elicitation is unavailable.
 *
 * Author experience: one code path, trivially understood. The version check
 * is one line at the top; everything below it is plain MRTR.
 *
 * This is the only option that works on horizontally-scaled (MRTR-only)
 * infra, and it's also correct on SSE-capable infra — the rows of the
 * quadrant collapse here. That's why it's the default: a server adopting
 * the new SDK gets this behaviour without asking for it. A/C/D are opt-in
 * for servers that want to carry SSE infra through the transition.
 *
 * Matches the position in comment 4083481545: the server is perfectly
 * 2025-11-compliant; it just doesn't use the client's declared
 * `elicitation: {}` capability. Servers are already allowed to do that —
 * no spec change, no new capability flags, no negotiation.
 *
 * Run: DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx src/mrtr-dual-path/optionEDegradeOnly.ts
 *      DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/optionEDegradeOnly.ts
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { acceptedContent, elicitForm, errorResult, MRTR_MIN_VERSION, readMrtr, supportsMrtr, wrap } from './shims.js';

type Units = 'metric' | 'imperial';

function lookupWeather(location: string, units: Units): string {
    const temp = units === 'metric' ? '22°C' : '72°F';
    return `Weather in ${location}: ${temp}, partly cloudy.`;
}

const server = new McpServer({ name: 'mrtr-option-e', version: '0.0.0' });

server.registerTool(
    'weather',
    {
        description: 'Weather lookup (Option E: degrade only, no SSE fallback)',
        inputSchema: z.object({ location: z.string(), _mrtr: z.unknown().optional() })
    },
    async ({ location, _mrtr }): Promise<CallToolResult> => {
        // ───────────────────────────────────────────────────────────────────
        // Pre-MRTR session: elicitation unavailable. Tool author chooses
        // what that means for *this* tool — not the SDK, not the spec.
        //
        // For weather, unit preference is nice-to-have. Defaulting to
        // metric and returning the answer is a better old-client
        // experience than "upgrade to check the weather."
        //
        // For a tool where the elicitation is essential — confirm a
        // destructive action, collect required auth — error instead:
        //
        //   return errorResult(
        //     `This tool requires interactive confirmation, which needs a ` +
        //     `client on protocol version ${MRTR_MIN_VERSION} or later.`
        //   );
        //
        // Either way: no SSE code path. The server is still valid 2025-11.
        // ───────────────────────────────────────────────────────────────────
        if (!supportsMrtr()) {
            return { content: [{ type: 'text', text: lookupWeather(location, 'metric') }] };
        }
        void errorResult;
        void MRTR_MIN_VERSION;

        const { inputResponses } = readMrtr({ _mrtr });
        const prefs = acceptedContent<{ units: Units }>(inputResponses, 'units');
        if (!prefs) {
            return wrap({
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
            });
        }

        return { content: [{ type: 'text', text: lookupWeather(location, prefs.units) }] };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[option-E] ready');
