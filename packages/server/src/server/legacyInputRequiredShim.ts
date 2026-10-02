/**
 * The legacy `input_required` shim: serves write-once handlers on 2025-era
 * sessions. `Server` holds one instance and delegates to it from the
 * multi-round-trip seam when a handler returns an input-required result on a
 * 2025-era request: each embedded request goes out as a real server→client
 * request (`elicitation/create` / `sampling/createMessage` / `roots/list`,
 * stamped with the originating request id for stream association), and the
 * handler is re-entered with the collected `inputResponses` until it returns
 * a final result or the round cap is exhausted.
 *
 * Semantics mirror the modern client driver so a handler cannot tell which
 * era fulfilled it: per-round REPLACED `inputResponses`, byte-exact
 * `requestState` echo (re-verified by the configured hook each round), paced
 * requestState-only rounds. The loop lives inside the originating request's
 * lifetime — nothing is parked, cancellation chains through every leg.
 * Failures surface per family: tools/call → `isError` tool results,
 * prompts/resources → JSON-RPC errors; malformed results fail loudly as
 * server bugs. Package-internal — not exported from the index.
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

/**
 * Default handler re-entries per originating request — tighter than the
 * client driver's 10 because the shim holds a live wire request open.
 */
const DEFAULT_LEGACY_SHIM_MAX_ROUNDS = 8;

/** Default per-leg timeout: legs are human-paced, so the 60s protocol default is wrong. */
const DEFAULT_LEGACY_SHIM_ROUND_TIMEOUT_MS = 600_000;

/** The `ServerOptions.inputRequired` bag with defaults applied. */
export interface ResolvedLegacyShimOptions {
    maxRounds: number;
    roundTimeoutMs: number;
    legacyShim: boolean;
}

/** Resolves and validates `ServerOptions.inputRequired`, failing loudly at construction time. */
export function resolveLegacyShimOptions(
    options: { maxRounds?: number; roundTimeoutMs?: number; legacyShim?: boolean } | undefined
): ResolvedLegacyShimOptions {
    if (options?.maxRounds !== undefined && (!Number.isInteger(options.maxRounds) || options.maxRounds < 1)) {
        throw new RangeError(`inputRequired.maxRounds must be a positive integer (got ${options.maxRounds})`);
    }
    if (options?.roundTimeoutMs !== undefined && (!Number.isFinite(options.roundTimeoutMs) || options.roundTimeoutMs <= 0)) {
        throw new RangeError(`inputRequired.roundTimeoutMs must be a positive number (got ${options.roundTimeoutMs})`);
    }
    return {
        maxRounds: options?.maxRounds ?? DEFAULT_LEGACY_SHIM_MAX_ROUNDS,
        roundTimeoutMs: options?.roundTimeoutMs ?? DEFAULT_LEGACY_SHIM_ROUND_TIMEOUT_MS,
        legacyShim: options?.legacyShim ?? true
    };
}

/** The embedded input-request kinds the 2026-07-28 revision defines. */
export type EmbeddedInputRequestMethod = 'elicitation/create' | 'sampling/createMessage' | 'roots/list';

/** A coerced `inputRequests` entry: the kind-narrowed embedded request. */
export interface CoercedEmbeddedInputRequest {
    method: EmbeddedInputRequestMethod;
    params?: Record<string, unknown>;
}

/**
 * Validates one `inputRequests` entry: malformed or unknown kinds are server
 * bugs and fail loudly on both eras. Shared by the modern seam's capability
 * check and the shim's gate.
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
    return { embedded: embedded as CoercedEmbeddedInputRequest, required };
}

/**
 * The 2025-11-25 URL-mode wire shape requires an `elicitationId`; the 2026
 * in-band shape has none, so URL legs mint one (CSPRNG-backed, with a
 * getRandomValues fallback for runtimes without `randomUUID`).
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

/** Per-family surfacing: tools/call → isError result (the 2025 idiom); prompts/resources → JSON-RPC error. */
function legacyShimFailure(method: string, message: string): Result {
    if (method === 'tools/call') {
        return { content: [{ type: 'text', text: message }], isError: true };
    }
    throw new ProtocolError(ProtocolErrorCode.InternalError, message);
}

/**
 * Everything the shim needs from `Server`: the knobs, the per-request
 * resolved capability view (initialize state on sessionful legacy; empty on
 * per-request stateless instances), the requestState verify runner
 * (deny-on-error → the frozen `-32602`), and the 2025-era senders. The
 * shim's own gate is authoritative; elicitation accepted content passes
 * through UNVALIDATED for parity with the modern client driver.
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

/** The fulfilment loop — see the module doc for the contract. */
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

            // At-least-one re-check per round (server bug → loud, as on modern).
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
                // The shim's own capability pre-check (never gated on
                // enforceStrictCapabilities). The whole round gates before
                // any wire traffic, so a refusal has no side effects.
                const declared = this._host.resolvedClientCapabilities(ctx);
                const coerced: [string, CoercedEmbeddedInputRequest][] = [];
                for (const [key, entry] of Object.entries(inputRequests!)) {
                    const { embedded, required } = coerceEmbeddedInputRequest(method, key, entry);
                    // Request-carrying kinds need params; absent = server bug.
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

                // Fulfil concurrently (driver parity); first failure aborts siblings.
                const roundAbort = linkedRoundAbort(outerSignal);
                try {
                    const legOptions: RequestOptions = {
                        relatedRequestId: ctx.mcpReq.id,
                        timeout: roundTimeoutMs,
                        resetTimeoutOnProgress: true,
                        // The no-op handler stamps a progressToken on the leg —
                        // without one, resetTimeoutOnProgress could never fire.
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
                        // Cancelled requests are never answered — propagate.
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
                // requestState-only round: paced so the loop never hot-spins
                // (driver parity); counted in the same round cap.
                await sleep(REQUEST_STATE_ONLY_LEG_PACING_MS, outerSignal);
            }

            // Byte-exact requestState echo: build the round's context first,
            // verify against it (the order and view a modern wire retry
            // gets), then swap in the decoded payload. Deny-on-error → -32602.
            let ctxNext: ServerContext = {
                ...ctx,
                mcpReq: {
                    ...ctx.mcpReq,
                    // REPLACE semantics: this round's responses only — multi-step
                    // flows thread earlier answers through requestState.
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

            // Re-entry hits the same stored handler a wire retry would
            // (for McpServer: the full funnel).
            const next = await handler(request, ctxNext);
            if (!isInputRequiredResult(next)) {
                return next;
            }
            current = next;
        }
    }

    /** Routes one embedded request through the host's existing 2025-era senders (gate already ran). */
    private async _dispatchLeg(embedded: CoercedEmbeddedInputRequest, options: RequestOptions): Promise<unknown> {
        switch (embedded.method) {
            case 'elicitation/create': {
                let params = embedded.params as ElicitRequestFormParams | ElicitRequestURLParams;
                if (params.mode === 'url' && (params as ElicitRequestURLParams).elicitationId === undefined) {
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
