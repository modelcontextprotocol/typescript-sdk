/**
 * Option C: explicit version branch in the handler body.
 *
 * No shim. Tool author checks `negotiatedVersion()` themselves and writes
 * both code paths inline. The SDK provides nothing except the version
 * accessor and the raw primitives for each path.
 *
 * Author experience: everything is visible. Both protocol behaviours are
 * right there in the source, separated by an `if`. No hidden re-entry,
 * no magic wrappers. A reader can trace exactly what happens for each
 * client version.
 *
 * The cost is also visible: the elicitation schema is duplicated, the
 * cancel-handling is duplicated, and there's now a conditional at the top
 * of every handler that uses elicitation. For one tool, fine. For twenty,
 * it's twenty copies of the same `if (supportsMrtr())` branch.
 *
 * This is one reading of "have clients implement both paths (i.e. not
 * something we hide in the SDK)" from the thread.
 *
 * Run: DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx src/mrtr-dual-path/optionCExplicitVersionBranch.ts
 *      DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/optionCExplicitVersionBranch.ts
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { acceptedContent, elicitForm, readMrtr, supportsMrtr, wrap } from './shims.js';

type Units = 'metric' | 'imperial';

function lookupWeather(location: string, units: Units): string {
    const temp = units === 'metric' ? '22°C' : '72°F';
    return `Weather in ${location}: ${temp}, partly cloudy.`;
}

const unitsSchema = {
    type: 'object' as const,
    properties: { units: { type: 'string' as const, enum: ['metric', 'imperial'], title: 'Units' } },
    required: ['units']
};

const server = new McpServer({ name: 'mrtr-option-c', version: '0.0.0' });

server.registerTool(
    'weather',
    {
        description: 'Weather lookup (Option C: explicit version branch)',
        inputSchema: z.object({ location: z.string(), _mrtr: z.unknown().optional() })
    },
    async ({ location, _mrtr }, ctx): Promise<CallToolResult> => {
        // ───────────────────────────────────────────────────────────────────
        // This is what the tool author writes. The branch is the whole story.
        // ───────────────────────────────────────────────────────────────────

        if (supportsMrtr()) {
            // MRTR path: check inputResponses, return IncompleteResult if missing.
            const { inputResponses } = readMrtr({ _mrtr });
            const prefs = acceptedContent<{ units: Units }>(inputResponses, 'units');
            if (!prefs) {
                return wrap({
                    inputRequests: { units: elicitForm({ message: 'Which units?', requestedSchema: unitsSchema }) }
                });
            }
            return { content: [{ type: 'text', text: lookupWeather(location, prefs.units) }] };
        }

        // SSE path: inline await, blocks on the POST response stream.
        const result = await ctx.mcpReq.elicitInput({ mode: 'form', message: 'Which units?', requestedSchema: unitsSchema });
        if (result.action !== 'accept' || !result.content) {
            return { content: [{ type: 'text', text: 'Cancelled.' }] };
        }
        const units = result.content.units as Units;
        return { content: [{ type: 'text', text: lookupWeather(location, units) }] };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[option-C] ready');
