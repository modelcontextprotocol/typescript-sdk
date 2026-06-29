/**
 * Authoring helpers for multi-round-trip requests (protocol revision
 * 2026-07-28).
 *
 * A handler for one of the multi-round-trip methods (`tools/call`,
 * `prompts/get`, `resources/read`) requests additional client input by
 * returning an {@linkcode InputRequiredResult} instead of a final result. The
 * helpers here build that return value and its embedded requests as NEUTRAL
 * values; only the 2026-07-28 wire codec maps them to/from the wire. The
 * 2025-era codec has no input-required vocabulary — on a 2025-era request the
 * server's legacy shim (on by default) fulfils the embedded requests as real
 * server→client requests and re-enters the handler, so the same return shape
 * serves both eras; `ServerOptions.inputRequired.legacyShim: false` restores
 * the pre-shim loud failure.
 *
 * There is no nominal brand: `resultType: 'input_required'` is the
 * discriminator, and hand-built result literals are equally legal — the
 * server seam re-checks the at-least-one rule for them.
 */
import { isInputRequiredResult } from '../types/guards';
import type {
    CreateMessageRequestParams,
    CreateMessageResult,
    CreateMessageResultWithTools,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    InputRequest,
    InputRequests,
    InputRequiredResult,
    InputResponses,
    Root
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
): T | undefined;

/**
 * Schema-aware overload: validates the accepted content against the given
 * schema (any Standard Schema, e.g. a zod object) before returning it, so the
 * untrusted client value arrives in the handler already validated and typed.
 *
 * Returns `undefined` when the response is missing/declined/of another kind
 * (as the two-argument form does) AND when the accepted content fails schema
 * validation — handlers treat both the same way (re-issue the request or
 * give up). Only synchronous schemas are supported (zod schemas without async
 * refinements are synchronous); an asynchronously-validating schema throws a
 * `TypeError`.
 */
export function acceptedContent<S extends StandardSchemaV1>(
    responses: InputResponses | Record<string, unknown> | undefined,
    key: string,
    schema: S
): StandardSchemaV1.InferOutput<S> | undefined;

export function acceptedContent(
    responses: InputResponses | Record<string, unknown> | undefined,
    key: string,
    schema?: StandardSchemaV1
): unknown {
    const view = inputResponse(responses, key);
    if (view.kind !== 'elicit' || view.action !== 'accept' || view.content === undefined) return undefined;
    if (schema === undefined) return view.content;
    const outcome = schema['~standard'].validate(view.content);
    if (outcome instanceof Promise) {
        throw new TypeError('acceptedContent(responses, key, schema) requires a synchronously-validating schema');
    }
    return outcome.issues === undefined ? outcome.value : undefined;
}

/**
 * The discriminated view {@linkcode inputResponse} returns: which kind of
 * embedded response (if any) a retried request carried for a key. Bare
 * response objects are discriminated structurally — an `action` member means
 * an elicitation result, a `roots` array a roots listing, a `role` + `content`
 * pair a sampling result. A missing key or an entry that matches none of the
 * three shapes reads as `{ kind: 'missing' }`.
 */
export type InputResponseView =
    | { kind: 'missing' }
    | { kind: 'elicit'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
    | { kind: 'sampling'; result: CreateMessageResult | CreateMessageResultWithTools }
    | { kind: 'roots'; roots: Root[] };

/**
 * Reads one entry of a retried request's `inputResponses`
 * (`ctx.mcpReq.inputResponses`) as a discriminated view, covering
 * decline/cancel detection and the non-elicitation response kinds that
 * {@linkcode acceptedContent} does not surface.
 *
 * The values arrive from the client and are not re-validated here — treat
 * them as untrusted input (validate elicitation content with the
 * schema-aware {@linkcode acceptedContent} overload where it matters).
 */
export function inputResponse(responses: InputResponses | Record<string, unknown> | undefined, key: string): InputResponseView {
    if (responses === undefined || typeof responses !== 'object' || responses === null) return { kind: 'missing' };
    const entry = (responses as Record<string, unknown>)[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { kind: 'missing' };
    const candidate = entry as Record<string, unknown>;
    if (candidate['action'] === 'accept' || candidate['action'] === 'decline' || candidate['action'] === 'cancel') {
        const content = candidate['content'];
        return {
            kind: 'elicit',
            action: candidate['action'],
            ...(content !== null &&
                typeof content === 'object' &&
                !Array.isArray(content) && { content: content as Record<string, unknown> })
        };
    }
    if (Array.isArray(candidate['roots'])) {
        return { kind: 'roots', roots: candidate['roots'] as Root[] };
    }
    if (typeof candidate['role'] === 'string' && candidate['content'] !== undefined) {
        return { kind: 'sampling', result: candidate as unknown as CreateMessageResult | CreateMessageResultWithTools };
    }
    return { kind: 'missing' };
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
