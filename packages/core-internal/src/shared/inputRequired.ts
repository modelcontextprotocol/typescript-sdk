/**
 * Authoring helpers for multi-round-trip requests (protocol revision
 * 2026-07-28).
 *
 * A handler for one of the multi-round-trip methods (`tools/call`,
 * `prompts/get`, `resources/read`) requests additional client input by
 * returning an {@linkcode InputRequiredResult} instead of a final result. The
 * helpers here build that return value and its embedded requests as NEUTRAL
 * values; only the 2026-07-28 wire codec maps them to/from the wire (the
 * 2025-era codec has no input-required vocabulary — on a 2025-era request the
 * server seam fails such a return loudly; a handler that serves both eras
 * branches on the served era and uses the push-style APIs toward 2025-era
 * requests).
 *
 * There is no nominal brand: `resultType: 'input_required'` is the
 * discriminator, and hand-built result literals are equally legal — the
 * server seam re-checks the at-least-one rule for them.
 */
import { isInputRequiredResult } from '../types/guards';
import type {
    CreateMessageRequestParams,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
    InputRequest,
    InputRequests,
    InputRequiredResult,
    InputResponses
} from '../types/types';
import type { StandardSchemaV1 } from '../util/standardSchema';

/** The shape accepted by {@linkcode inputRequired}. */
export interface InputRequiredSpec {
    /** Embedded requests the client must fulfil before retrying. */
    inputRequests?: InputRequests;
    /** Opaque server state echoed back verbatim by the client on retry. */
    requestState?: string;
}

interface InputRequiredBuilder {
    /**
     * Builds the input-required return value for a multi-round-trip handler.
     *
     * At least one of `inputRequests` or `requestState` must be provided
     * (spec: basic/patterns/mrtr, server requirements) — the builder throws a
     * `TypeError` otherwise, and the server seam re-checks the same rule for
     * hand-built results.
     *
     * `requestState` is opaque, server-minted state. It round-trips through
     * the client and comes back as attacker-controlled input: a server that
     * lets it influence authorization, resource access, or business logic
     * MUST integrity-protect it (e.g. HMAC or AEAD) and MUST reject state
     * that fails verification. The SDK does not do this for you.
     */
    (spec: InputRequiredSpec): InputRequiredResult;

    /** Builds an embedded form-mode elicitation request (`elicitation/create`). */
    elicit(params: Omit<ElicitRequestFormParams, 'mode'> & { mode?: 'form' }): InputRequest;

    /**
     * Builds an embedded URL-mode elicitation request (`elicitation/create`).
     * On the 2026-07-28 revision URL elicitation rides the multi-round-trip
     * flow — the `-32042` error of earlier revisions never appears on this
     * era's wire. The 2025-era `elicitationId` is not part of the 2026-07-28
     * URL-mode shape; correlation across retries is the server's own
     * identifier inside `requestState`.
     */
    elicitUrl(params: Omit<ElicitRequestURLParams, 'mode' | 'elicitationId'>): InputRequest;

    /** Builds an embedded sampling request (`sampling/createMessage`). */
    createMessage(params: CreateMessageRequestParams): InputRequest;

    /** Builds an embedded roots listing request (`roots/list`). */
    listRoots(): InputRequest;
}

function buildInputRequired(spec: InputRequiredSpec): InputRequiredResult {
    const hasInputRequests = spec.inputRequests !== undefined && Object.keys(spec.inputRequests).length > 0;
    const hasRequestState = typeof spec.requestState === 'string';
    if (!hasInputRequests && !hasRequestState) {
        throw new TypeError(
            'inputRequired() requires at least one of inputRequests (with at least one entry) or requestState ' +
                '(spec: every InputRequiredResult MUST include at least one of the two)'
        );
    }
    return {
        resultType: 'input_required',
        ...(spec.inputRequests !== undefined && { inputRequests: spec.inputRequests }),
        ...(spec.requestState !== undefined && { requestState: spec.requestState })
    };
}

/**
 * Builder for the input-required return value of multi-round-trip handlers,
 * with per-kind constructors for the embedded requests
 * (`inputRequired.elicit`, `inputRequired.elicitUrl`,
 * `inputRequired.createMessage`, `inputRequired.listRoots`).
 *
 * @example Write-once tool requesting confirmation
 * ```ts
 * server.registerTool('deploy', { inputSchema: z.object({ env: z.string() }) }, async ({ env }, ctx) => {
 *     const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
 *     if (!confirmed) {
 *         return inputRequired({
 *             inputRequests: {
 *                 confirm: inputRequired.elicit({
 *                     message: `Deploy to ${env}?`,
 *                     requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
 *                 })
 *             }
 *         });
 *     }
 *     return { content: [{ type: 'text', text: `deployed to ${env}` }] };
 * });
 * ```
 */
export const inputRequired: InputRequiredBuilder = Object.assign(buildInputRequired, {
    elicit(params: Omit<ElicitRequestFormParams, 'mode'> & { mode?: 'form' }): InputRequest {
        return { method: 'elicitation/create', params: { ...params, mode: 'form' } };
    },
    elicitUrl(params: Omit<ElicitRequestURLParams, 'mode' | 'elicitationId'>): InputRequest {
        // The neutral ElicitRequestURLParams keeps `elicitationId` (it is required on the
        // frozen 2025-11-25 revision); the 2026-07-28 in-band shape does not carry it.
        return { method: 'elicitation/create', params: { ...params, mode: 'url' } as ElicitRequestURLParams };
    },
    createMessage(params: CreateMessageRequestParams): InputRequest {
        return { method: 'sampling/createMessage', params };
    },
    listRoots(): InputRequest {
        return { method: 'roots/list' };
    }
});

/**
 * Reads the accepted content of a form-mode elicitation response from a
 * retried request's `inputResponses` (`ctx.mcpReq.inputResponses`).
 *
 * Returns the response's `content` for `key` when the entry is an accepted
 * elicitation result, and `undefined` otherwise (missing key, declined or
 * cancelled elicitation, or a response of another kind). The values arrive
 * from the client and are not re-validated here — treat them as untrusted
 * input.
 */
export function acceptedContent<T extends Record<string, unknown> = Record<string, unknown>>(
    responses: InputResponses | Record<string, unknown> | undefined,
    key: string
): T | undefined {
    if (responses === undefined || typeof responses !== 'object' || responses === null) return undefined;
    const entry = (responses as Record<string, unknown>)[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const candidate = entry as Partial<ElicitResult> & Record<string, unknown>;
    if (candidate.action !== 'accept') return undefined;
    if (candidate.content === undefined || typeof candidate.content !== 'object' || candidate.content === null) return undefined;
    return candidate.content as T;
}

/**
 * Wraps a result schema so a request issued through `client.request()` /
 * `ctx.mcpReq.send()` with `allowInputRequired: true` is typed as either the
 * schema's result or an {@linkcode InputRequiredResult}.
 *
 * The manual multi-round-trip path: pass `{ allowInputRequired: true }` in the
 * request options so an `input_required` response is handed back to the
 * caller instead of being auto-fulfilled (or rejected), and wrap the result
 * schema with `withInputRequired()` so the returned value is typed and
 * validated correctly for both outcomes — `input_required` values pass
 * through as-is, complete results validate against the wrapped schema.
 */
export function withInputRequired<S extends StandardSchemaV1>(
    schema: S
): StandardSchemaV1<unknown, StandardSchemaV1.InferOutput<S> | InputRequiredResult> {
    return {
        '~standard': {
            version: 1,
            vendor: 'modelcontextprotocol',
            validate: (value: unknown, options?: StandardSchemaV1.Options) => {
                if (isInputRequiredResult(value)) {
                    return { value };
                }
                return schema['~standard'].validate(value, options) as
                    | StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S> | InputRequiredResult>
                    | Promise<StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S> | InputRequiredResult>>;
            }
        }
    };
}
