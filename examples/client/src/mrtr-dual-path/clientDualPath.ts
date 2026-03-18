/**
 * Client-side dual-path: new SDK, old server.
 *
 * This is the "new client → old server" direction (point 2 from the SEP-2322
 * thread). A client on the 2026-06 SDK connects to a 2025-11 server. Version
 * negotiation settles on 2025-11. The server pushes elicitation over SSE the
 * old way. The client needs to handle that — and also handle `IncompleteResult`
 * when talking to new servers.
 *
 * Unlike the server side (options A–E in examples/server/src/mrtr-dual-path/),
 * there's only one sensible approach here. The elicitation handler has the
 * same signature either way — "given an elicitation request, produce a
 * response" — so the SDK routes to one user-supplied function from both
 * paths. No version check in app code, no dual registration, no shim footguns.
 *
 * What the SDK keeps: the existing `setRequestHandler('elicitation/create', ...)`
 * plumbing. What the SDK adds: a retry loop in `callTool` that unwraps
 * `IncompleteResult` and calls the same handler for each `InputRequest`.
 *
 * Run against any of the optionA–E servers (cwd: examples/client):
 *   DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx src/mrtr-dual-path/clientDualPath.ts
 *   DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/clientDualPath.ts
 */

import type { CallToolResult, ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/client';
import { Client, getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client';

// ───────────────────────────────────────────────────────────────────────────
// Inlined MRTR type shims. See examples/server/src/mrtr-dual-path/shims.ts
// for the full set with commentary — only the three the client side touches
// are repeated here.
// ───────────────────────────────────────────────────────────────────────────

type InputRequest = { method: 'elicitation/create'; params: ElicitRequestFormParams };
type InputResponses = { [key: string]: { result: ElicitResult } };

interface IncompleteResult {
    inputRequests?: { [key: string]: InputRequest };
    requestState?: string;
}

interface MrtrParams {
    inputResponses?: InputResponses;
    requestState?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// The ONE handler. This is the whole client-side story.
//
// Shape: `(params: ElicitRequestFormParams) => Promise<ElicitResult>`.
// Nothing about this signature cares whether the request arrived as an SSE
// push or inside an `IncompleteResult`. The SDK calls it from either path;
// the app code is identical.
// ───────────────────────────────────────────────────────────────────────────

async function handleElicitation(params: ElicitRequestFormParams): Promise<ElicitResult> {
    // Real client: present `params.requestedSchema` as a form, collect user input.
    // Demo: hardcode an answer so the weather tool completes.
    console.error(`[elicit] server asks: ${params.message}`);
    return { action: 'accept', content: { units: 'metric' } };
}

// ───────────────────────────────────────────────────────────────────────────
// Path 1 of 2: SSE push (old server, negotiated 2025-11).
//
// This is today's API, unchanged. The SDK receives `elicitation/create` as
// a JSON-RPC request on the SSE stream and invokes the registered handler.
// The new SDK keeps this registration — it's cheap to carry and it's what
// makes the upgrade non-breaking for the client → old server direction.
// ───────────────────────────────────────────────────────────────────────────

function registerSseElicitation(client: Client): void {
    client.setRequestHandler('elicitation/create', async request => {
        if (request.params.mode !== 'form') {
            return { action: 'decline' };
        }
        return handleElicitation(request.params);
    });
}

// ───────────────────────────────────────────────────────────────────────────
// Path 2 of 2: MRTR retry loop (new server, negotiated 2026-06).
//
// The SDK's `callTool` would do this internally. When the result is
// `IncompleteResult`, iterate `inputRequests`, call the SAME handler for
// each `ElicitRequest` inside, pack results into `inputResponses`, re-issue
// the tool call. Repeat until complete.
//
// Note where `handleElicitation` appears: same function, same call shape.
// The loop is SDK machinery; the app-supplied handler doesn't know which
// path it's serving.
// ───────────────────────────────────────────────────────────────────────────

async function callToolMrtr(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let mrtr: MrtrParams = {};

    for (let round = 0; round < 8; round++) {
        const result = await client.callTool({ name, arguments: { ...args, _mrtr: mrtr } });

        const incomplete = unwrapIncomplete(result);
        if (!incomplete) {
            return result as CallToolResult;
        }

        const responses: InputResponses = {};
        for (const [key, req] of Object.entries(incomplete.inputRequests ?? {})) {
            // The same handler as the SSE path. No adapter, no version check.
            responses[key] = { result: await handleElicitation(req.params) };
        }

        mrtr = { inputResponses: responses, requestState: incomplete.requestState };
    }

    throw new Error('MRTR retry loop exceeded round limit');
}

// Reverse of the server-side `wrap()` shim. Real SDK would parse
// `JSONRPCIncompleteResultResponse` at the protocol layer; this just
// unwraps the JSON-text-block smuggle the server demos use.
function unwrapIncomplete(result: Awaited<ReturnType<Client['callTool']>>): IncompleteResult | undefined {
    const first = (result as CallToolResult).content?.[0];
    if (first?.type !== 'text') return undefined;
    try {
        const parsed = JSON.parse(first.text) as { __mrtrIncomplete?: true } & IncompleteResult;
        return parsed.__mrtrIncomplete ? parsed : undefined;
    } catch {
        return undefined;
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Caitie's point 2: MRTR-only mode.
//
// Cloud-hosted clients (claude.ai class) can't hold the SSE backchannel
// even today, so for them SSE elicitation was never available and MRTR is
// the first time it becomes possible. Those clients would skip
// `registerSseElicitation` entirely — the real SDK shape would be a
// constructor flag, something like:
//
//   new Client({ name, version }, { capabilities: { elicitation: {} }, sseElicitation: false })
//
// With that set, the SDK doesn't register the `elicitation/create` handler.
// An old server that tries to push one gets method-not-found. The MRTR
// retry loop still works. Tree-shaking drops the SSE listener code.
// ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const client = new Client({ name: 'mrtr-dual-path-client', version: '0.0.0' }, { capabilities: { elicitation: {} } });

    // Enables the SSE path. Comment this out for MRTR-only mode.
    registerSseElicitation(client);

    const transport = new StdioClientTransport({
        command: 'pnpm',
        args: ['tsx', '../server/src/mrtr-dual-path/optionAShimMrtrCanonical.ts'],
        env: { ...getDefaultEnvironment(), DEMO_PROTOCOL_VERSION: process.env.DEMO_PROTOCOL_VERSION ?? '2026-06' }
    });
    await client.connect(transport);

    // One call site. Which path fires under the hood depends on the server:
    // old server → SSE handler invoked mid-call; new server → MRTR retry loop
    // runs. The app code here is identical either way.
    const result = await callToolMrtr(client, 'weather', { location: 'Tokyo' });
    console.error('[result]', JSON.stringify(result.content, null, 2));

    await client.close();
}

try {
    await main();
} catch (error) {
    console.error(error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
