/**
 * MRTR (Multi Round-Trip Request) type shims.
 *
 * These types approximate the shapes proposed in the SEP
 * (https://github.com/modelcontextprotocol/transports-wg/pull/12) and exist
 * solely to support the backwards-compatibility exploration in this folder.
 * They are NOT part of the SDK API and will be replaced once the SEP lands
 * and the real schema/types are generated.
 *
 * The core idea: instead of `await server.elicitInput(...)` inside a tool
 * handler (which requires holding an SSE stream open across a server→client
 * round-trip), the handler returns an `IncompleteResult` describing what
 * input it needs. The client resolves those inputs and retries the entire
 * tool call with `inputResponses` (and optionally `requestState`) attached.
 * Any server instance can then process the retry without shared storage or
 * sticky routing.
 */

import type { CallToolResult, ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/server';

/**
 * A server-initiated request that would previously have been sent as a
 * separate JSON-RPC request on the POST SSE stream. The SEP lists
 * elicitation and sampling as the primary cases; these demos only need
 * form elicitation, so we keep the union narrow.
 *
 * Note: in the real schema this will NOT include the JSON-RPC `id` field
 * (the SEP has a TODO to define `ServerInputRequest` for exactly this
 * reason). Here we reuse the existing params types directly.
 */
export type InputRequest = {
    method: 'elicitation/create';
    params: ElicitRequestFormParams;
};

/**
 * Map of server-chosen keys → input requests.
 *
 * Keys are arbitrary strings chosen by the server. The client echoes each
 * key back in `inputResponses` with the matching result. Using a map (rather
 * than an array) structurally guarantees key uniqueness.
 */
export type InputRequests = { [key: string]: InputRequest };

/**
 * Map of server-chosen keys → client responses.
 *
 * For each key the server issued in `inputRequests`, the client returns a
 * response under the same key. We only model elicitation results here.
 */
export type InputResponses = { [key: string]: { result: ElicitResult } };

/**
 * The result a tool returns when it cannot complete yet.
 *
 * At least one of `inputRequests` or `requestState` must be present;
 * a result with neither would be indistinguishable from an empty
 * `CallToolResult`.
 */
export interface IncompleteResult {
    /**
     * Requests the client must resolve before retrying.
     * When absent the client MAY retry immediately (e.g. load-shedding).
     */
    inputRequests?: InputRequests;

    /**
     * Opaque blob the server wants echoed back on retry.
     *
     * The server encodes whatever continuation state it needs here so that
     * any instance handling the retry can resume without re-doing work.
     * Real implementations SHOULD sign/encrypt this and bind it to the
     * authenticated user; the demos use plain base64-JSON for clarity.
     */
    requestState?: string;
}

/**
 * Extra parameters the MRTR workflow attaches to a retried tool call.
 *
 * Today these would live under `params` alongside `name` and `arguments`
 * (see the SEP's `RetryAugmentedRequestParams`). Since the SDK doesn't
 * thread them through yet, the demos read them from `arguments._mrtr`
 * as a stand-in — see `readMrtr()` below.
 */
export interface MrtrParams {
    inputResponses?: InputResponses;
    requestState?: string;
}

/**
 * The handler's return type under MRTR: either the real result, or an
 * indication that another round-trip is needed.
 *
 * Ideally the SDK would accept this union directly from `registerTool`
 * callbacks and translate `IncompleteResult` into the wire-level
 * `JSONRPCIncompleteResultResponse`. For now callers use `wrap()` to
 * smuggle it through as a `CallToolResult`.
 */
export type MrtrToolResult = CallToolResult | IncompleteResult;

/**
 * Pull `_mrtr` out of the tool arguments.
 *
 * This is the stand-in for `ctx.mcpReq.inputResponses` / `ctx.mcpReq.requestState`
 * that a real SDK integration would surface. Passing MRTR params via a
 * reserved argument key keeps the demos runnable against the current SDK
 * without transport changes, and keeps the "before" and "after" tools
 * side-by-side on one server.
 */
export function readMrtr(args: Record<string, unknown> | undefined): MrtrParams {
    const raw = (args as { _mrtr?: MrtrParams } | undefined)?._mrtr;
    return raw ?? {};
}

/**
 * Type guard: does this look like an IncompleteResult?
 *
 * The presence of either `inputRequests` or `requestState` is the
 * discriminator the SEP proposes; `content` is absent on incomplete results.
 */
export function isIncomplete(r: MrtrToolResult): r is IncompleteResult {
    return ('inputRequests' in r && r.inputRequests !== undefined) || ('requestState' in r && r.requestState !== undefined);
}

/**
 * Helper: build a form-elicitation InputRequest.
 *
 * Purely sugar to keep the demo callsites tidy; the object shape is
 * identical to what `server.elicitInput({ mode: 'form', ... })` takes today.
 */
export function elicitForm(params: Omit<ElicitRequestFormParams, 'mode'>): InputRequest {
    return { method: 'elicitation/create', params: { mode: 'form', ...params } };
}

/**
 * Read a typed, accepted elicitation response.
 *
 * Returns `undefined` when the key is missing, the user declined/cancelled,
 * or no content was supplied. Callers treat `undefined` as "not yet provided"
 * and issue the corresponding `InputRequest` again.
 */
export function acceptedContent<T extends Record<string, unknown>>(responses: InputResponses | undefined, key: string): T | undefined {
    const entry = responses?.[key];
    if (!entry) return undefined;
    const { result } = entry;
    if (result.action !== 'accept' || !result.content) return undefined;
    return result.content as T;
}

/**
 * Encode request state as base64 JSON.
 *
 * **Demo-only.** Real servers MUST sign and/or encrypt this blob (the SEP
 * recommends AES-GCM or a signed JWT) because the client is an untrusted
 * intermediary. State containing per-user data MUST be cryptographically
 * bound to the authenticated user to prevent replay/hijacking.
 */
export function encodeState(state: unknown): string {
    return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

/**
 * Decode request state previously produced by `encodeState`.
 *
 * Returns `undefined` for malformed input rather than throwing, because
 * the appropriate recovery per the SEP is simply to re-request the
 * missing information (not to fail the tool call).
 */
export function decodeState<T>(blob: string | undefined): T | undefined {
    if (!blob) return undefined;
    try {
        return JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as T;
    } catch {
        // Invalid/tampered state: behave as if none was provided and
        // let the handler re-request what it needs.
        return undefined;
    }
}

/**
 * Wrap an MRTR-aware handler result into something the current `registerTool`
 * callback signature accepts.
 *
 * The SDK doesn't yet know how to serialise `IncompleteResult`, so for the
 * demos we emit it as a `CallToolResult` with a JSON text payload that the
 * paired demo client knows how to interpret. This is strictly a shim for
 * exploration — the real implementation would emit a
 * `JSONRPCIncompleteResultResponse` at the protocol layer.
 */
export function wrap(result: MrtrToolResult): CallToolResult {
    if (!isIncomplete(result)) return result;
    return {
        content: [
            {
                type: 'text',
                // Non-standard marker so the demo client can unwrap.
                // Real transport emits a dedicated response type instead.
                text: JSON.stringify({ __mrtrIncomplete: true, ...result })
            }
        ]
    };
}
