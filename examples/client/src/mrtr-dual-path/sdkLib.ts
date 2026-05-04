/**
 * Stand-in for what the client SDK would ship for MRTR.
 *
 * Everything in this file is machinery the SDK provides. A client app
 * developer never writes any of it — they just call `withMrtr(client, handler)`
 * (or in the real SDK: register a handler the way they do today, and the
 * SDK's `callTool` does the retry loop internally).
 *
 * See clientDualPath.ts for the app-developer side — that file is short
 * on purpose.
 */

import type { CallToolResult, Client, ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/client';

// ───────────────────────────────────────────────────────────────────────────
// Type shims — see examples/server/src/mrtr-dual-path/shims.ts for the
// full set with commentary.
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
// The one SDK-surface export.
//
// Real SDK shape: the app registers via `setRequestHandler('elicitation/create', h)`
// exactly as today, and `client.callTool()` gains the retry loop internally,
// dispatching to that registered handler. No new API; the MRTR loop is
// invisible to the app.
//
// Demo shape: this helper does both — registers the handler on the SSE
// path AND returns a `callTool` that runs the MRTR retry loop using the
// same handler. One registration point, two dispatch paths, same as the
// real SDK would do but with the wiring visible.
// ───────────────────────────────────────────────────────────────────────────

export type ElicitationHandler = (params: ElicitRequestFormParams) => Promise<ElicitResult>;

export interface MrtrClientOptions {
    /**
     * Drop the SSE `elicitation/create` listener. Old servers that push
     * elicitation get method-not-found; the MRTR retry loop still works.
     * For cloud-hosted clients that can't hold the SSE backchannel anyway.
     */
    mrtrOnly?: boolean;
}

export function withMrtr(
    client: Client,
    handleElicitation: ElicitationHandler,
    options: MrtrClientOptions = {}
): { callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult> } {
    // Path 1: SSE push (old server, negotiated 2025-11). Today's plumbing,
    // unchanged. Skipped if mrtrOnly is set.
    if (!options.mrtrOnly) {
        client.setRequestHandler('elicitation/create', async request => {
            if (request.params.mode !== 'form') return { action: 'decline' };
            return handleElicitation(request.params);
        });
    }

    // Path 2: MRTR retry loop (new server, negotiated 2026-06). What the
    // real SDK's `callTool` would do internally. Calls the SAME handler
    // as path 1 — that's the whole point.
    async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
        let mrtr: MrtrParams = {};

        for (let round = 0; round < 8; round++) {
            const result = await client.callTool({ name, arguments: { ...args, _mrtr: mrtr } });

            const incomplete = unwrapIncomplete(result);
            if (!incomplete) return result as CallToolResult;

            const responses: InputResponses = {};
            for (const [key, req] of Object.entries(incomplete.inputRequests ?? {})) {
                responses[key] = { result: await handleElicitation(req.params) };
            }
            mrtr = { inputResponses: responses, requestState: incomplete.requestState };
        }

        throw new Error('MRTR retry loop exceeded round limit');
    }

    return { callTool };
}

// Protocol-layer parsing. Real SDK parses `JSONRPCIncompleteResultResponse`
// off the wire; this unwraps the JSON-text-block smuggle the server demos use.
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
