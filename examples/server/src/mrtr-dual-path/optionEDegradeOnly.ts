/**
 * Option E: graceful degradation only. No SSE fallback.
 *
 * Tool author writes MRTR-native code. Pre-MRTR clients get a tool-level
 * error: "this tool requires a newer client." No shim, no dual path, no
 * SSE infrastructure used even though it's available.
 *
 * Author experience: one code path, trivially understood. The version check
 * is one line at the top; everything below it is plain MRTR.
 *
 * This is the position staked in comment 4083481545: "I'd argue for graceful
 * degradation instead." The server is perfectly 2025-11-compliant — it just
 * happens not to use the client's declared `elicitation: {}` capability,
 * which is something servers are already allowed to do.
 *
 * The cost is the obvious one: an old client that *could* have been served
 * (server holds SSE, client declared elicitation) isn't. Whether that's
 * acceptable is a product call, not an SDK one. For most tools — pure
 * request/response, no elicitation — this option and all the others are
 * identical. The difference only shows for the minority of tools that
 * actually elicit.
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
        // This guard is the entire top-left-quadrant story.
        //
        // Real SDK could surface this as a registration-time declaration
        // (`requiresMrtr: true`) so the check doesn't live in every handler
        // — or even filter the tool out of `tools/list` for old clients,
        // per gjz22's SEP-1442 tie-in. Either way, no SSE code path.
        // ───────────────────────────────────────────────────────────────────
        if (!supportsMrtr()) {
            return errorResult(
                `This tool requires interactive input, which needs a client on protocol version ${MRTR_MIN_VERSION} or later.`
            );
        }

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
