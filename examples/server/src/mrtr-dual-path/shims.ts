/**
 * MRTR dual-path exploration — shared shims.
 *
 * This file extends the types from #1597's mrtr-backcompat/shims.ts with the
 * machinery needed to demonstrate five approaches to the "top-left quadrant"
 * from the SEP-2322 thread (comment 4083481545): a server that CAN hold SSE,
 * talking to a 2025-11 client, running MRTR-era tool code.
 *
 * Everything here is a stand-in for what the SDK would eventually provide.
 * None of it is production-grade; the point is to make the API surface area
 * of each option concrete enough to compare.
 *
 * Builds on: typescript-sdk#1597 (pcarleton's mrtr-backcompat demos).
 * See that PR's shims.ts for the baseline IncompleteResult / InputRequests
 * types — those are copied here unchanged so this folder is self-contained.
 */

import type { CallToolResult, ElicitRequestFormParams, ElicitResult, ServerContext } from '@modelcontextprotocol/server';

// ───────────────────────────────────────────────────────────────────────────
// Baseline MRTR types (copied from #1597 — see that PR for full commentary)
// ───────────────────────────────────────────────────────────────────────────

export type InputRequest = {
    method: 'elicitation/create';
    params: ElicitRequestFormParams;
};

export type InputRequests = { [key: string]: InputRequest };
export type InputResponses = { [key: string]: { result: ElicitResult } };

export interface IncompleteResult {
    inputRequests?: InputRequests;
    requestState?: string;
}

export interface MrtrParams {
    inputResponses?: InputResponses;
    requestState?: string;
}

export type MrtrToolResult = CallToolResult | IncompleteResult;

export function isIncomplete(r: MrtrToolResult): r is IncompleteResult {
    return ('inputRequests' in r && r.inputRequests !== undefined) || ('requestState' in r && r.requestState !== undefined);
}

export function elicitForm(params: Omit<ElicitRequestFormParams, 'mode'>): InputRequest {
    return { method: 'elicitation/create', params: { mode: 'form', ...params } };
}

export function acceptedContent<T extends Record<string, unknown>>(responses: InputResponses | undefined, key: string): T | undefined {
    const entry = responses?.[key];
    if (!entry) return undefined;
    const { result } = entry;
    if (result.action !== 'accept' || !result.content) return undefined;
    return result.content as T;
}

// ───────────────────────────────────────────────────────────────────────────
// New for dual-path: negotiated version stand-in
// ───────────────────────────────────────────────────────────────────────────

/**
 * The two protocol versions the demos care about.
 *
 * Real SDK would surface the negotiated version from the initialize handshake.
 * Today's SDK does track it internally but doesn't expose it to tool handlers,
 * so we read it from an env var to keep the demos runnable.
 */
export type ProtocolVersion = '2025-11' | '2026-06';

export const MRTR_MIN_VERSION: ProtocolVersion = '2026-06';

/**
 * Stand-in for `ctx.protocolVersion` or similar.
 *
 * Drive with `DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx optionAShimMrtrCanonical.ts` to simulate
 * an old-client session against the same handler code.
 */
export function negotiatedVersion(): ProtocolVersion {
    const v = process.env.DEMO_PROTOCOL_VERSION;
    return v === '2025-11' ? '2025-11' : '2026-06';
}

export function supportsMrtr(v: ProtocolVersion = negotiatedVersion()): boolean {
    return v >= MRTR_MIN_VERSION;
}

// ───────────────────────────────────────────────────────────────────────────
// Option A machinery: SDK emulates the MRTR retry loop over SSE
// ───────────────────────────────────────────────────────────────────────────

/**
 * The signature an MRTR-native handler would have once the SDK threads
 * `inputResponses` / `requestState` through natively.
 *
 * This is what tool authors write under Option A. One function, re-entrant
 * by construction: check `inputResponses`, return `IncompleteResult` if
 * something's missing, compute the real result otherwise.
 */
export type MrtrHandler<TArgs> = (args: TArgs, mrtr: MrtrParams, ctx: ServerContext) => Promise<MrtrToolResult>;

/**
 * Wraps an MRTR-native handler so it also works for 2025-11 clients.
 *
 * Mechanism: when the negotiated version is pre-MRTR and the handler returns
 * `IncompleteResult`, this wrapper drives the retry loop *locally* — it sends
 * each `InputRequest` as a real `elicitation/create` over the SSE stream (via
 * the existing `ctx.mcpReq.elicitInput()`), collects the answers, and
 * re-invokes the handler with `inputResponses` populated. Repeat until the
 * handler returns a complete result.
 *
 * This is the "⚠️ clunky but possible" shim from the comment's matrix. The
 * tool author doesn't see the loop; they write MRTR-native code and it
 * transparently works for old clients too.
 *
 * This is only valid on server infra that can actually hold SSE — the
 * `ctx.mcpReq.elicitInput()` call below is a real SSE round-trip. On a
 * horizontally-scaled deployment that can't (the whole reason to adopt
 * MRTR in the first place), this shim fails at runtime when an old client
 * connects — the elicit goes out on a stream the LB has already dropped,
 * or was never held open. Nothing at registration time catches that; it's
 * a deployment-time constraint living far from the tool code. If that's
 * the deployment, use option E instead.
 *
 * Hidden cost: the handler is silently re-invoked. The MRTR shape makes that
 * safe *by construction* (re-entry point is explicit — the `if (!prefs)`
 * guard), but it's still invisible machinery.
 */
export function sseRetryShim<TArgs>(mrtrHandler: MrtrHandler<TArgs>): (args: TArgs, ctx: ServerContext) => Promise<CallToolResult> {
    return async (args, ctx) => {
        // Fast path: new client — just pass IncompleteResult through.
        // (In the real SDK this would emit JSONRPCIncompleteResultResponse on the wire.)
        if (supportsMrtr()) {
            const result = await mrtrHandler(args, {}, ctx);
            return wrap(result);
        }

        // Old client: drive the retry loop locally, using real SSE for each elicit.
        const responses: InputResponses = {};
        let requestState: string | undefined;

        // Bounded to catch handlers that never converge. A well-formed MRTR handler
        // asks for strictly fewer things each round; an unbounded loop is a bug.
        for (let round = 0; round < 8; round++) {
            const result = await mrtrHandler(args, { inputResponses: responses, requestState }, ctx);

            if (!isIncomplete(result)) {
                return result;
            }

            requestState = result.requestState;

            // No new questions but still incomplete: nothing more we can do here.
            // Return a tool-level error rather than looping on an empty ask.
            if (!result.inputRequests || Object.keys(result.inputRequests).length === 0) {
                return errorResult('Tool returned IncompleteResult with no inputRequests on a pre-MRTR session.');
            }

            // Fulfil each InputRequest via the *existing* SSE elicitation path.
            // This is the one place the shim actually needs SSE-capable infra:
            // `ctx.mcpReq.elicitInput()` issues `elicitation/create` on the POST
            // response stream and blocks until the client answers.
            for (const [key, req] of Object.entries(result.inputRequests)) {
                const answer = await ctx.mcpReq.elicitInput(req.params);
                responses[key] = { result: answer };
            }
        }

        return errorResult('MRTR retry loop exceeded round limit (handler never converged).');
    };
}

// ───────────────────────────────────────────────────────────────────────────
// Option B machinery: exception-based shim, `await elicit()` canonical
// ───────────────────────────────────────────────────────────────────────────

/**
 * Sentinel thrown by `elicit()` when the session is MRTR-capable and the
 * answer wasn't pre-supplied in `inputResponses`.
 *
 * Control-flow-by-exception: the shim catches this at the top of the handler
 * wrapper, packages it as `IncompleteResult`, and returns. On retry the
 * handler runs *from the top again* and this time `elicit()` finds the answer.
 */
export class NeedsInputSignal extends Error {
    constructor(public readonly inputRequests: InputRequests) {
        super('NeedsInputSignal (control flow, not an error)');
    }
}

/**
 * The `await`-able elicit function for Option B handlers.
 *
 * - Pre-MRTR session → real SSE elicitation, blocks inline (today's behaviour)
 * - MRTR session, answer present → return it
 * - MRTR session, answer absent → throw NeedsInputSignal
 *
 * The third case is the footgun. The handler author wrote `await elicit(...)`
 * and assumed linear control flow. On MRTR retry, *everything above this line
 * runs again*. If that includes a mutation — a DB write, an HTTP POST — it
 * happens twice. The MRTR shape surfaces re-entry in the source text
 * (`if (!prefs) return`); this shape hides it behind `await`.
 */
export function makeElicit(ctx: ServerContext, mrtr: MrtrParams) {
    return async function elicit<T extends Record<string, unknown>>(
        key: string,
        params: Omit<ElicitRequestFormParams, 'mode'>
    ): Promise<T | undefined> {
        // Old client: native SSE, no trickery.
        if (!supportsMrtr()) {
            const result = await ctx.mcpReq.elicitInput({ mode: 'form', ...params });
            if (result.action !== 'accept' || !result.content) return undefined;
            return result.content as T;
        }

        // New client: check inputResponses first.
        const preSupplied = acceptedContent<T>(mrtr.inputResponses, key);
        if (preSupplied) return preSupplied;

        // Answer not pre-supplied → signal the shim to emit IncompleteResult.
        // Everything on the stack between here and `mrtrExceptionShim`'s catch
        // unwinds. On retry the handler re-executes from line one.
        throw new NeedsInputSignal({ [key]: elicitForm(params) });
    };
}

/**
 * Wrap an `await elicit()`-style handler so it emits `IncompleteResult` on
 * MRTR sessions.
 *
 * Catches `NeedsInputSignal`, packages as `IncompleteResult`. That's it.
 * The hidden re-entry on retry is the trade — zero migration for existing
 * tools, silent double-execution of everything above the await.
 */
export function mrtrExceptionShim<TArgs>(
    handler: (args: TArgs, elicit: ReturnType<typeof makeElicit>, ctx: ServerContext) => Promise<CallToolResult>
): (args: TArgs, mrtr: MrtrParams, ctx: ServerContext) => Promise<MrtrToolResult> {
    return async (args, mrtr, ctx) => {
        const elicit = makeElicit(ctx, mrtr);
        try {
            return await handler(args, elicit, ctx);
        } catch (error) {
            if (error instanceof NeedsInputSignal) {
                return { inputRequests: error.inputRequests };
            }
            throw error;
        }
    };
}

// ───────────────────────────────────────────────────────────────────────────
// Option D machinery: dual registration
// ───────────────────────────────────────────────────────────────────────────

/**
 * Two handlers, one per protocol era. SDK dispatches by negotiated version.
 * No shim, no magic — the author wrote both and the SDK just picks.
 */
export interface DualPathHandlers<TArgs> {
    mrtr: MrtrHandler<TArgs>;
    sse: (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;
}

export function dispatchByVersion<TArgs>(
    handlers: DualPathHandlers<TArgs>
): (args: TArgs, mrtr: MrtrParams, ctx: ServerContext) => Promise<MrtrToolResult> {
    return async (args, mrtr, ctx) => {
        if (supportsMrtr()) {
            return handlers.mrtr(args, mrtr, ctx);
        }
        return handlers.sse(args, ctx);
    };
}

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

export function errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Smuggle `IncompleteResult` through the current `registerTool` signature
 * as a JSON text block. Same hack as #1597 — real SDK would emit
 * `JSONRPCIncompleteResultResponse` at the protocol layer.
 */
export function wrap(result: MrtrToolResult): CallToolResult {
    if (!isIncomplete(result)) return result;
    return {
        content: [{ type: 'text', text: JSON.stringify({ __mrtrIncomplete: true, ...result }) }]
    };
}

/**
 * Stand-in for reading MRTR params off the retry request.
 * See #1597 for why this rides on `arguments._mrtr` today.
 */
export function readMrtr(args: Record<string, unknown> | undefined): MrtrParams {
    const raw = (args as { _mrtr?: MrtrParams } | undefined)?._mrtr;
    return raw ?? {};
}
