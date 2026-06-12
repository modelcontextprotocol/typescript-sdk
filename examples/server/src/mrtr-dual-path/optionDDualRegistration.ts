/**
 * Option D: dual registration. Two handlers, SDK picks by version.
 *
 * Tool author writes two separate functions — one MRTR-native, one SSE-native
 * — and hands both to the SDK at registration. The SDK dispatches based on
 * negotiated version. No shim converts between them; each path is exactly
 * what the author wrote for that protocol era.
 *
 * Author experience: no hidden control flow, and unlike Option C the two
 * paths are structurally separated rather than tangled in one function body.
 * Shared logic (the schema, the lookup call) factors out naturally. Each
 * handler is readable in isolation.
 *
 * The cost: two functions per elicitation-using tool, both live until SSE
 * is deprecated. There's no mechanical link between them — if the MRTR
 * handler changes the elicitation schema and the SSE handler doesn't,
 * nothing catches it. Also: the registration API grows a shape that only
 * exists for the transition period.
 *
 * This is the other reading of "have clients implement both paths" — the
 * two paths are separate functions, not branches.
 *
 * Run: DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx src/mrtr-dual-path/optionDDualRegistration.ts
 *      DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/optionDDualRegistration.ts
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { MrtrHandler } from './shims.js';
import { acceptedContent, dispatchByVersion, elicitForm, readMrtr, wrap } from './shims.js';

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

const server = new McpServer({ name: 'mrtr-option-d', version: '0.0.0' });

// ───────────────────────────────────────────────────────────────────────────
// The tool author writes two functions. Each is clean in isolation.
// ───────────────────────────────────────────────────────────────────────────

const weatherMrtr: MrtrHandler<{ location: string }> = async ({ location }, { inputResponses }) => {
    const prefs = acceptedContent<{ units: Units }>(inputResponses, 'units');
    if (!prefs) {
        return {
            inputRequests: { units: elicitForm({ message: 'Which units?', requestedSchema: unitsSchema }) }
        };
    }
    return { content: [{ type: 'text', text: lookupWeather(location, prefs.units) }] };
};

const weatherSse = async ({ location }: { location: string }, ctx: Parameters<typeof weatherMrtr>[2]): Promise<CallToolResult> => {
    const result = await ctx.mcpReq.elicitInput({ mode: 'form', message: 'Which units?', requestedSchema: unitsSchema });
    if (result.action !== 'accept' || !result.content) {
        return { content: [{ type: 'text', text: 'Cancelled.' }] };
    }
    return { content: [{ type: 'text', text: lookupWeather(location, result.content.units as Units) }] };
};

// ───────────────────────────────────────────────────────────────────────────
// Registration takes both. The real SDK shape might be
//   server.registerTool('weather', opts, { mrtr: ..., sse: ... })
// or a decorator, or overloads — the point is both handlers are visible
// at the registration site and the SDK owns the switch.
// ───────────────────────────────────────────────────────────────────────────

const weatherHandler = dispatchByVersion({ mrtr: weatherMrtr, sse: weatherSse });

server.registerTool(
    'weather',
    {
        description: 'Weather lookup (Option D: dual registration)',
        inputSchema: z.object({ location: z.string(), _mrtr: z.unknown().optional() })
    },
    async ({ location, _mrtr }, ctx) => wrap(await weatherHandler({ location }, readMrtr({ _mrtr }), ctx))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[option-D] ready');
