/**
 * The multi-round-trip auto-fulfilment ENGINE (protocol revision 2026-07-28):
 * the wiring between the protocol layer's response funnel, the
 * already-registered input handlers, and the pure {@link runInputRequiredDriver}
 * loop. The engine is what the `Client` plugs into the funnel's
 * `_resolveNonCompleteResult` extension point — `Protocol` itself only knows
 * the input-required branch exists.
 *
 * Relocated here so the shared `Protocol` base stays generic: the only
 * MRTR-specific code that remains in `protocol.ts` is the irreducible
 * input-required branch in the response path, the type surface (the
 * `allowInputRequired` request option and the `inputResponses`/`requestState`/
 * `droppedInputResponseKeys` context fields), and the named extension point.
 */
import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type { InputRequiredResult, JSONRPCRequest, RequestMeta, Result } from '../types/types.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import type { WireCodec } from '../wire/codec.js';
import type {
    InputRequiredDriverHooks,
    InputRequiredPayload,
    InputRequiredRetryLegOptions,
    ResolvedInputRequiredDriverConfig
} from './inputRequiredDriver.js';
import { runInputRequiredDriver } from './inputRequiredDriver.js';
import type { BaseContext, NonCompleteResultFlow, RequestOptions } from './protocol.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Splits a retried request's `inputResponses` map into the BARE response
 * entries the spec defines and everything else. The spec's embedded responses
 * are the bare result objects (an `ElicitResult`, `CreateMessageResult`, or
 * `ListRootsResult`); a wrapped `{method, result}` envelope (a shape some
 * peers emit) is never accepted as a response — its key is recorded so the
 * handler can re-issue the corresponding input request.
 */
export function partitionInputResponses(inputResponses: unknown): { accepted: Record<string, unknown>; droppedKeys: string[] } {
    const accepted: Record<string, unknown> = {};
    const droppedKeys: string[] = [];
    if (!isPlainObject(inputResponses)) {
        return { accepted, droppedKeys };
    }
    for (const [key, entry] of Object.entries(inputResponses)) {
        // Bare responses never carry `method` or `result` members — both are
        // the signature of the wrapped (JSON-RPC-shaped) form.
        if (!isPlainObject(entry) || 'method' in entry || 'result' in entry) {
            droppedKeys.push(key);
            continue;
        }
        accepted[key] = entry;
    }
    return { accepted, droppedKeys };
}

/**
 * Related send/notify are unavailable inside an embedded input-request
 * handler: the request is fulfilled locally by the multi-round-trip driver,
 * so there is no live peer request to relate messages to.
 */
function relatedMessagingUnavailable(member: string): never {
    throw new SdkError(
        SdkErrorCode.SendFailed,
        `ctx.mcpReq.${member} is not available while fulfilling an embedded input request: ` +
            `the request is fulfilled locally and has no related peer request`
    );
}

/**
 * The synthesized {@linkcode BaseContext} for an embedded input request: the
 * id is the `inputRequests` key (correlation only — it is not a JSON-RPC
 * message id), the supplied abort signal chains the originating call's signal
 * through, and related `send`/`notify` are unavailable because there is no
 * live peer request to relate them to.
 */
export function synthesizeInputRequestContext(
    key: string,
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
    sessionId: string | undefined
): BaseContext {
    return {
        sessionId,
        mcpReq: {
            id: key,
            method,
            _meta: params?.['_meta'] as RequestMeta | undefined,
            signal,
            send: (() => relatedMessagingUnavailable('send')) as BaseContext['mcpReq']['send'],
            notify: () => relatedMessagingUnavailable('notify')
        }
    };
}

/**
 * Hooks the engine needs from the consuming role class (the `Client`): how to
 * look up a registered handler and how to enrich a base context.
 */
export interface InputRequiredEngineHost {
    /** The handler registered for the given method, or `undefined`. */
    getRequestHandler(method: string): ((request: JSONRPCRequest, ctx: unknown) => Promise<Result>) | undefined;
    /** Builds the role-specific context from a {@linkcode BaseContext}. */
    buildContext(baseCtx: BaseContext): unknown;
    /** The transport's session identifier, when there is one. */
    sessionId: string | undefined;
}

/**
 * Dispatches one embedded (de-JSON-RPC'd) input request to the locally
 * registered handler for its method and resolves with the bare response.
 *
 * The handler runs through the same stored handler chain as a wire request
 * (including role-specific validation installed by `_wrapHandler`), with a
 * synthesized context (see {@link synthesizeInputRequestContext}).
 */
export async function dispatchInputRequest(
    host: InputRequiredEngineHost,
    codec: WireCodec,
    key: string,
    entry: unknown,
    signal: AbortSignal
): Promise<unknown> {
    if (!isPlainObject(entry) || typeof entry['method'] !== 'string') {
        throw new SdkError(
            SdkErrorCode.InvalidResult,
            `Invalid input request '${key}': each inputRequests entry must be an embedded request object with a method`,
            { key }
        );
    }
    const method = entry['method'];
    if (!codec.hasInputRequestMethod(method)) {
        throw new SdkError(
            SdkErrorCode.InvalidResult,
            `Invalid input request '${key}': '${method}' is not an embedded request the ${codec.era} revision defines ` +
                `(expected elicitation/create, sampling/createMessage, or roots/list)`,
            { key, method }
        );
    }
    const handler = host.getRequestHandler(method);
    if (handler === undefined) {
        throw new SdkError(
            SdkErrorCode.CapabilityNotSupported,
            `Cannot fulfil input request '${key}': no handler is registered for '${method}' on this client. ` +
                `Declare the corresponding capability and register a handler, or handle input_required results manually.`,
            { key, method }
        );
    }

    const params = isPlainObject(entry['params']) ? (entry['params'] as Record<string, unknown>) : undefined;
    const synthesizedRequest: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: key,
        method,
        ...(params !== undefined && { params })
    };
    const ctx = host.buildContext(synthesizeInputRequestContext(key, method, params, signal, host.sessionId));
    return await handler(synthesizedRequest, ctx);
}

/**
 * Builds the per-retry-leg {@linkcode RequestOptions} from the originating
 * call's options.
 *
 * Only the fields that are correct to apply to every leg carry over (a
 * deliberate whitelist): the per-leg `timeout`, the (shrinking) total budget
 * `maxTotalTimeout`, the caller's `onprogress`/`resetTimeoutOnProgress`, and
 * the caller's abort `signal`. Everything else — in particular
 * `relatedRequestId`, `resumptionToken`, and `onresumptiontoken` — is scoped
 * to the originating wire leg and is NOT inherited by retries.
 */
export function buildRetryLegRequestOptions(options: RequestOptions | undefined, legOptions: InputRequiredRetryLegOptions): RequestOptions {
    return {
        ...(options?.signal !== undefined && { signal: options.signal }),
        ...(options?.onprogress !== undefined && { onprogress: options.onprogress }),
        ...(options?.resetTimeoutOnProgress !== undefined && { resetTimeoutOnProgress: options.resetTimeoutOnProgress }),
        // Per-request HTTP headers (SEP-2243 `Mcp-Param-*`) carry over: the
        // retry's `arguments` are byte-identical to the originating leg (the
        // driver only adds `inputResponses`/`requestState`), so the param
        // headers built for the first leg remain correct for every retry leg.
        ...(options?.headers !== undefined && { headers: options.headers }),
        ...(legOptions.timeout !== undefined && { timeout: legOptions.timeout }),
        ...(legOptions.maxTotalTimeout !== undefined && { maxTotalTimeout: legOptions.maxTotalTimeout }),
        // The driver re-enters the funnel with the manual primitive: a further
        // input_required answer is handed back to the loop instead of
        // recursing into another driver run (the round cap is global to the
        // flow).
        allowInputRequired: true
    };
}

/**
 * Runs the auto-fulfilment flow for one originating request whose response
 * came back as `input_required`: builds the driver hooks (embedded-request
 * dispatch + retry through the funnel) and hands them to
 * {@link runInputRequiredDriver}. Resolves with the final complete result
 * (already validated by the retry leg) or rejects with a typed error.
 */
export function runInputRequiredFlow<T extends StandardSchemaV1>(
    host: InputRequiredEngineHost,
    config: ResolvedInputRequiredDriverConfig,
    decoded: { inputRequests: Record<string, unknown>; requestState?: string },
    flow: NonCompleteResultFlow<T>
): Promise<unknown> {
    const { codec, request, options, flowStartedAt } = flow;
    const firstPayload: InputRequiredPayload = {
        inputRequests: decoded.inputRequests,
        ...(decoded.requestState !== undefined && { requestState: decoded.requestState })
    };
    const hooks: InputRequiredDriverHooks = {
        dispatchInputRequest: (key, entry, signal) => dispatchInputRequest(host, codec, key, entry, signal),
        retry: (params, legOptions) => flow.retry(params, buildRetryLegRequestOptions(options, legOptions))
    };
    return runInputRequiredDriver({
        config,
        method: request.method,
        originalParams: request.params,
        firstPayload,
        flowStartedAt,
        signal: options?.signal,
        requestOptions: {
            ...(options?.timeout !== undefined && { timeout: options.timeout }),
            ...(options?.maxTotalTimeout !== undefined && { maxTotalTimeout: options.maxTotalTimeout }),
            ...(options?.onprogress !== undefined && { onprogress: options.onprogress })
        },
        hooks
    });
}

/**
 * Builds the manual-mode {@linkcode InputRequiredResult} value from the
 * codec's decoded payload — what an `allowInputRequired: true` caller
 * receives instead of the auto-fulfilled complete result.
 */
export function manualInputRequiredValue(decoded: { inputRequests: Record<string, unknown>; requestState?: string }): InputRequiredResult {
    return {
        resultType: 'input_required',
        inputRequests: decoded.inputRequests as InputRequiredResult['inputRequests'],
        ...(decoded.requestState !== undefined && { requestState: decoded.requestState })
    };
}
