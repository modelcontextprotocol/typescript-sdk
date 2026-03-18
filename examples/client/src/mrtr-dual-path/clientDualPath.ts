/**
 * Client-side dual-path: new SDK, old server.
 *
 * Everything here is what the APP DEVELOPER writes. The SDK machinery
 * (retry loop, IncompleteResult parsing, SSE listener wiring) lives in
 * sdkLib.ts — that file is a stand-in for what the real SDK ships.
 *
 * The point: the app-facing code is identical to today's. You write one
 * elicitation handler, you register it, you call tools. The SDK routes
 * your handler from either the SSE push path (old server) or the MRTR
 * retry loop (new server). Which path fires is invisible to this file.
 *
 * Run against the server demos (cwd: examples/client):
 *   DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx src/mrtr-dual-path/clientDualPath.ts
 *   DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/clientDualPath.ts
 */

import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/client';
import { Client, getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client';

import { withMrtr } from './sdkLib.js';

// ───────────────────────────────────────────────────────────────────────────
// The one thing the app owns: given an elicitation request, produce a
// response. In a real client this presents `requestedSchema` as a form.
// The signature is identical whether the request arrived via SSE push
// or inside an IncompleteResult — the SDK dispatches to this from both.
// ───────────────────────────────────────────────────────────────────────────

async function handleElicitation(params: ElicitRequestFormParams): Promise<ElicitResult> {
    console.error(`[elicit] server asks: ${params.message}`);
    return { action: 'accept', content: { units: 'metric' } };
}

// ───────────────────────────────────────────────────────────────────────────

const client = new Client({ name: 'mrtr-dual-path-client', version: '0.0.0' }, { capabilities: { elicitation: {} } });

// One registration. Both paths dispatch to `handleElicitation`.
// Pass `{ mrtrOnly: true }` to drop the SSE listener (cloud-hosted clients
// that can't hold the backchannel — Caitie's point 2).
const { callTool } = withMrtr(client, handleElicitation);

const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['tsx', '../server/src/mrtr-dual-path/optionAShimMrtrCanonical.ts'],
    env: { ...getDefaultEnvironment(), DEMO_PROTOCOL_VERSION: process.env.DEMO_PROTOCOL_VERSION ?? '2026-06' }
});
await client.connect(transport);

// Same call site as today. Which path fires under the hood — SSE push or
// MRTR retry — depends on the server, not on anything in this file.
const result = await callTool('weather', { location: 'Tokyo' });
console.error('[result]', JSON.stringify(result.content, null, 2));

await client.close();
