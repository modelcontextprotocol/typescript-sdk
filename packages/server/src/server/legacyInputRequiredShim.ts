/**
 * The legacy `input_required` shim (write-once handlers on 2025-era
 * sessions), isolated from the core server: `Server` holds one
 * {@linkcode LegacyInputRequiredShim} which it delegates to from the
 * multi-round-trip seam when a handler returns an input-required result on a
 * 2025-era request.
 *
 * The shim converts each embedded input request of the return into a REAL
 * server→client request (`elicitation/create`, `sampling/createMessage`,
 * `roots/list`) over the live session — stamped with the originating
 * request's id so sessionful Streamable HTTP routes them onto the
 * originating POST's stream — then re-enters the handler with the collected
 * `inputResponses` and the echoed `requestState`, until the handler returns
 * a final result or the round cap is exhausted.
 *
 * Semantics mirror the modern client driver exactly, so a handler cannot
 * tell which era fulfilled it: `inputResponses` are per-round (REPLACED,
 * never accumulated), `requestState` is echoed byte-exact (and re-verified
 * by the configured hook each round, exactly as a wire retry would be),
 * requestState-only rounds are paced, and the round cap counts handler
 * re-entries.
 *
 * The loop lives entirely within the originating wire request's lifetime:
 * no awaits are parked, no state survives the request, and the caller's
 * cancellation chains through every leg.
 *
 * Failure surfacing is per family: `tools/call` failures (capability
 * refusal, leg failure, round-cap exhaustion) become `isError` tool
 * results — the 2025-era idiom hosts already render — while `prompts/get`
 * and `resources/read` failures surface as JSON-RPC errors. Server bugs
 * (malformed input-required results) fail loudly on both eras, and
 * requestState verification failures keep the frozen `-32602`.
 *
 * Not public API — package-internal, deliberately not exported from the
 * package index.
 */
import type {
    ClientCapabilities,
    CreateMessageRequest,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    JSONRPCRequest,
    RequestOptions,
    Result,
    ServerContext
} from '@modelcontextprotocol/core-internal';
import {
    inputRequiredRoundsExceededMessage,
    isInputRequiredResult,
    linkedRoundAbort,
    missingClientCapabilities,
    ProtocolError,
    ProtocolErrorCode,
    REQUEST_STATE_ONLY_LEG_PACING_MS,
    requestStateAccessor,
    requiredClientCapabilitiesForInputRequest,
    sleep,
    withRequestStateValue
} from '@modelcontextprotocol/core-internal';

/** The embedded input-request kinds the 2026-07-28 revision defines. */
export type EmbeddedInputRequestMethod = 'elicitation/create' | 'sampling/createMessage' | 'roots/list';

/** A coerced `inputRequests` entry: the kind-narrowed embedded request. */
export interface CoercedEmbeddedInputRequest {
    method: EmbeddedInputRequestMethod;
    params?: Record<string, unknown>;
}

/**
 * Validates one `inputRequests` entry of an input-required result: a
 * malformed entry or an unknown embedded-request kind is a server bug and
 * fails loudly (both eras — the vocabulary is the 2026-07-28 revision's
 * regardless of which era the request is served on). Returns the coerced
 * entry together with the client capabilities it requires. Shared by the
 * modern seam's capability check and the legacy shim's gate.
 */
export function coerceEmbeddedInputRequest(
    method: string,
    key: string,
    entry: unknown
): { embedded: CoercedEmbeddedInputRequest; required: ClientCapabilities } {
    if (entry === null || typeof entry !== 'object' || typeof (entry as { method?: unknown }).method !== 'string') {
        throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Handler for ${method} returned an invalid input request '${key}': each inputRequests entry must be an ` +
                `embedded elicitation/create, sampling/createMessage, or roots/list request`
        );
    }
    const embedded = entry as { method: string; params?: Record<string, unknown> };
    const required = requiredClientCapabilitiesForInputRequest(embedded);
    if (required === undefined) {
        throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Handler for ${method} returned an input request '${key}' of kind '${embedded.method}', which is not an ` +
                `embedded request the 2026-07-28 revision defines`
        );
    }
    // The cast records the invariant the check above just established:
    // requiredClientCapabilitiesForInputRequest answers undefined for any
    // method outside the three embedded kinds.
    return { embedded: embedded as CoercedEmbeddedInputRequest, required };
}

/**
 * Synthesizes the `elicitationId` the 2025-11-25 URL-mode elicitation shape
 * requires: the 2026 in-band shape deliberately has none (correlation lives
 * in `requestState`), so a URL-mode leg the legacy shim sends must mint one
 * to be schema-valid toward conforming 2025 clients. Always CSPRNG-backed —
 * `randomUUID` where available, `getRandomValues` formatted as a v4 UUID
 * otherwise (the SDK already requires the Web Crypto API elsewhere).
 */
function syntheticElicitationId(): string {
    const webCrypto = globalThis.crypto;
    if (webCrypto?.randomUUID !== undefined) {
        return webCrypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Per-family failure surfacing for the legacy shim: `tools/call` failures
 * become `isError` tool results (the 2025-era idiom — hosts and models
 * already render them), `prompts/get` / `resources/read` failures surface as
 * JSON-RPC errors.
 */
function legacyShimFailure(method: string, message: string): Result {
    if (method === 'tools/call') {
        return { content: [{ type: 'text', text: message }], isError: true };
    }
    throw new ProtocolError(ProtocolErrorCode.InternalError, message);
}

/**
 * Everything the shim needs from `Server`, as a narrow contract:
 * the resolved knobs, the per-request resolved capability view (plan ruling
 * F-2 — `initialize` state on a sessionful legacy connection, empty on
 * per-request stateless instances), the requestState verify runner
 * (deny-on-error → the frozen `-32602`), and the three existing 2025-era
 * senders (capability-check-free cores; the shim's own gate is
 * authoritative, and elicitation accepted content passes through UNVALIDATED
 * for parity with the modern client driver).
 */
export interface LegacyInputRequiredShimHost {
    readonly maxRounds: number;
    readonly roundTimeoutMs: number;
    resolvedClientCapabilities(ctx: ServerContext): ClientCapabilities | undefined;
    verifyRequestState(state: string, ctx: ServerContext, method: string): Promise<unknown>;
    sendElicitation(params: ElicitRequestFormParams | ElicitRequestURLParams, options: RequestOptions): Promise<unknown>;
    sendSampling(params: CreateMessageRequest['params'], options: RequestOptions): Promise<unknown>;
    listRoots(params: Record<string, unknown> | undefined, options: RequestOptions): Promise<unknown>;
}

/**
 * The fulfilment loop, held by `Server` and delegated to from the
 * multi-round-trip seam (see the module doc for the full contract).
 */
export class LegacyInputRequiredShim {
    constructor(private readonly _host: LegacyInputRequiredShimHost) {}

    async fulfill(
        method: string,
        handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>,
        request: JSONRPCRequest,
        ctx: ServerContext,
        firstResult: Result
    ): Promise<Result> {
        const { maxRounds, roundTimeoutMs } = this._host;
        const outerSignal = ctx.mcpReq.signal;
        let current = firstResult;
        let round = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            round += 1;
            if (round > maxRounds) {
                return legacyShimFailure(method, inputRequiredRoundsExceededMessage(method, maxRounds));
            }

            // At-least-one re-check per round (hand-built results are legal;
            // a violation is a server bug and fails loudly, as on the modern
            // era).
            const inputRequests = current.inputRequests as Record<string, unknown> | null | undefined;
            const hasInputRequests = inputRequests != null && Object.keys(inputRequests).length > 0;
            const requestState = typeof current.requestState === 'string' ? current.requestState : undefined;
            if (!hasInputRequests && requestState === undefined) {
                throw new ProtocolError(
                    ProtocolErrorCode.InternalError,
                    `Handler for ${method} returned an input-required result with neither inputRequests nor requestState ` +
                        `(every InputRequiredResult must include at least one of the two)`
                );
            }

            let responses: Record<string, unknown> | undefined;
            if (hasInputRequests) {
                // The shim's OWN capability pre-check — never gated on
                // `enforceStrictCapabilities` — against the per-request
                // resolved view. The whole round gates BEFORE any wire
                // traffic, so a refusal has no side effects.
                const declared = this._host.resolvedClientCapabilities(ctx);
                const coerced: [string, CoercedEmbeddedInputRequest][] = [];
                for (const [key, entry] of Object.entries(inputRequests!)) {
                    const { embedded, required } = coerceEmbeddedInputRequest(method, key, entry);
                    // The wire legs need params for the request-carrying
                    // kinds; a hand-built entry without them is a server bug
                    // and fails loudly, like every other malformation.
                    if (embedded.method !== 'roots/list' && embedded.params === undefined) {
                        throw new ProtocolError(
                            ProtocolErrorCode.InternalError,
                            `Handler for ${method} returned an input request '${key}' of kind '${embedded.method}' without params`
                        );
                    }
                    const missing = missingClientCapabilities(required, declared);
                    if (missing !== undefined) {
                        return legacyShimFailure(
                            method,
                            `Cannot request input '${key}' (${embedded.method}): the client on this 2025-era connection did not ` +
                                `declare the required capability${declared === undefined ? ' (no client capabilities are available on this connection — per-request legacy serving cannot receive server-to-client requests)' : ''}`
                        );
                    }
                    coerced.push([key, embedded]);
                }

                // Fulfil concurrently (the embedded requests are independent,
                // mirroring the modern client driver); the first failure
                // aborts the sibling legs via the shared linked per-round
                // signal.
                const roundAbort = linkedRoundAbort(outerSignal);
                try {
                    const legOptions: RequestOptions = {
                        relatedRequestId: ctx.mcpReq.id,
                        timeout: roundTimeoutMs,
                        resetTimeoutOnProgress: true,
                        // The no-op handler makes the leg carry a
                        // progressToken, which is what lets a client that
                        // reports progress mid-leg actually reset the leg
                        // timeout — without it resetTimeoutOnProgress could
                        // never fire (no token, nothing to report against).
                        onprogress: () => {},
                        signal: roundAbort.signal
                    };
                    const fulfilled = await Promise.all(
                        coerced.map(async ([key, embedded]) => {
                            try {
                                return [key, await this._dispatchLeg(embedded, legOptions)] as const;
                            } catch (error) {
                                roundAbort.abort(error);
                                throw error;
                            }
                        })
                    );
                    responses = Object.fromEntries(fulfilled);
                } catch (error) {
                    if (outerSignal.aborted) {
                        // The originating request was cancelled: propagate so
                        // the protocol layer drops the response (cancelled
                        // requests are never answered).
                        throw error;
                    }
                    return legacyShimFailure(
                        method,
                        `Fulfilling input required by '${method}' failed: ${error instanceof Error ? error.message : String(error)}`
                    );
                } finally {
                    roundAbort.dispose();
                }
            } else {
                // requestState-only (load-shedding) round: fixed pacing so
                // the loop never hot-spins; counted in the same round cap
                // (mirrors the modern client driver).
                await sleep(REQUEST_STATE_ONLY_LEG_PACING_MS, outerSignal);
            }

            // Byte-exact requestState echo. The re-entry context carries this
            // round's material FIRST (raw state accessor + this round's
            // responses), then the configured verify hook runs against that
            // context — exactly the order and view a modern wire retry gets —
            // and its decoded payload replaces the accessor value.
            // Deny-on-error → the frozen -32602.
            let ctxNext: ServerContext = {
                ...ctx,
                mcpReq: {
                    ...ctx.mcpReq,
                    // REPLACE semantics: this round's responses only — never
                    // accumulated across rounds (parity with the modern
                    // client driver; multi-step flows thread earlier answers
                    // through requestState).
                    inputResponses: responses,
                    droppedInputResponseKeys: undefined,
                    requestState: requestStateAccessor(requestState)
                }
            };
            if (requestState !== undefined) {
                const decoded = await this._host.verifyRequestState(requestState, ctxNext, method);
                if (decoded !== undefined) {
                    ctxNext = withRequestStateValue(ctxNext, decoded);
                }
            }

            // Re-entry goes through the SAME stored handler the wire retry
            // would hit (for McpServer that is the full funnel: input
            // re-validation, output projection, tools/call error catch).
            const next = await handler(request, ctxNext);
            if (!isInputRequiredResult(next)) {
                return next;
            }
            current = next;
        }
    }

    /**
     * Routes one embedded input request through the host's existing 2025-era
     * senders — the same wire paths a hand-written era-branching handler
     * used. The shim's capability gate has already run.
     */
    private async _dispatchLeg(embedded: CoercedEmbeddedInputRequest, options: RequestOptions): Promise<unknown> {
        switch (embedded.method) {
            case 'elicitation/create': {
                let params = embedded.params as ElicitRequestFormParams | ElicitRequestURLParams;
                if (params.mode === 'url' && (params as ElicitRequestURLParams).elicitationId === undefined) {
                    // The 2026 in-band URL shape carries no elicitationId
                    // (correlation lives in requestState), but the 2025-11-25
                    // wire schema requires one — synthesize it so conforming
                    // 2025 clients accept the leg.
                    params = { ...(params as ElicitRequestURLParams), elicitationId: syntheticElicitationId() };
                }
                return await this._host.sendElicitation(params, options);
            }
            case 'sampling/createMessage': {
                return await this._host.sendSampling(embedded.params as CreateMessageRequest['params'], options);
            }
            case 'roots/list': {
                return await this._host.listRoots(embedded.params, options);
            }
        }
    }
}
