/**
 * The 2026-era wire codec (protocol revision 2026-07-28).
 *
 * Decode = raw-first `resultType` discrimination (the structural V-1 home:
 * the RAW value is inspected BEFORE any schema validation, so a non-complete
 * result can never be masked into a hollow success by a tolerant schema),
 * then wire-exact parse, then lift (drop the wire member). Encode = the
 * stamp seam: the known deleted-field set is strictly enforced (Q1-SD3 iii) —
 * the 2026 wire types have no slot for `execution.taskSupport` or
 * `capabilities.tasks`, so the encode mapping deletes them; era-blind
 * handlers stay era-invisible while deleted vocabulary cannot cross eras
 * through the parse-free outbound path — and then the encode contract steps
 * run (see `encodeContract.ts`): the `resultType` stamp (with handler
 * pass-through for the multi round-trip methods) followed by the required
 * `ttlMs`/`cacheScope` fill on cacheable results.
 *
 * Q1-SD3 postures implemented here:
 * (i)  absent `resultType` from a 2026-classified peer → typed error NAMING
 *      the violation. The spec's absent⇒complete bridge is scoped to
 *      EARLIER-revision servers (spec.types.2026-07-28.ts Result.resultType:
 *      "Servers implementing this protocol version MUST include this field")
 *      and is deliberately NOT extended to modern traffic.
 * (ii) `input_required` → the driver-seam payload (the multi-round-trip
 *      driver, M4.1/#13, consumes it; until then the protocol layer surfaces
 *      the discriminated kind as a typed local error, no retry).
 * (iii) unrecognized kinds → invalid, no retry (DQ5).
 */
import type * as z from 'zod/v4';

import { SdkError, SdkErrorCode } from '../../errors/sdkErrors.js';
import type { Result } from '../../types/types.js';
import type { DecodedResult, LiftedWireMaterial, WireCodec } from '../codec.js';
import { fillCacheFields, stampResultType } from './encodeContract.js';
import { getInputRequestSchema2026, getInputResponseSchema2026 } from './inputRequired.js';
import {
    getNotificationSchema2026,
    getRequestSchema2026,
    getResultSchema2026,
    hasNotificationMethod2026,
    hasRequestMethod2026
} from './registry.js';
import {
    CallToolResultSchema,
    CompleteResultSchema,
    DiscoverResultSchema,
    GetPromptResultSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListToolsResultSchema,
    ReadResourceResultSchema,
    RequestMetaEnvelopeSchema
} from './schemas.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strip the known deleted-field set from an outbound result (Q1-SD3 iii). */
function enforceDeletedFields(method: string, result: Result): Result {
    let next: Record<string, unknown> = result as Record<string, unknown>;
    let copied = false;
    const copy = () => {
        if (!copied) {
            next = { ...next };
            copied = true;
        }
        return next;
    };

    // tools arrays: execution (the taskSupport carrier) is deleted vocabulary.
    const tools = (result as { tools?: unknown }).tools;
    if (method === 'tools/list' && Array.isArray(tools) && tools.some(tool => isPlainObject(tool) && 'execution' in tool)) {
        copy().tools = tools.map(tool => {
            if (!isPlainObject(tool) || !('execution' in tool)) return tool;
            const rest = { ...tool };
            delete rest['execution'];
            return rest;
        });
    }

    // capability objects: the `tasks` capability is deleted vocabulary.
    const capabilities = (result as { capabilities?: unknown }).capabilities;
    if (isPlainObject(capabilities) && 'tasks' in capabilities) {
        const rest = { ...capabilities };
        delete rest['tasks'];
        copy().capabilities = rest;
    }

    return next as Result;
}

export const rev2026Codec: WireCodec = {
    era: '2026-07-28',

    hasRequestMethod: hasRequestMethod2026,
    hasNotificationMethod: hasNotificationMethod2026,

    requestSchema: getRequestSchema2026,
    resultSchema: getResultSchema2026,
    notificationSchema: getNotificationSchema2026,

    // In-band multi-round-trip vocabulary: the demoted elicitation/sampling/
    // roots shapes carried inside `input_required` results (NOT wire request
    // methods on this era — registry membership is deliberately not granted).
    inputRequestSchema: getInputRequestSchema2026,
    inputResponseSchema: getInputResponseSchema2026,

    decodeResult(method: string, raw: unknown): DecodedResult {
        if (!isPlainObject(raw)) {
            return {
                kind: 'invalid',
                error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: not an object`, { method })
            };
        }

        // Step 1 — RAW discrimination, before any schema (V-1).
        const rawResultType = raw['resultType'];
        if (rawResultType === undefined) {
            // Q1-SD3 (i): hard error naming the violation.
            return {
                kind: 'invalid',
                error: new SdkError(
                    SdkErrorCode.InvalidResult,
                    `Invalid result for ${method}: missing required resultType — servers implementing protocol revision 2026-07-28 ` +
                        `MUST include it (the absent-means-complete bridge applies only to earlier-revision servers)`,
                    { method, violation: 'missing-resultType' }
                )
            };
        }
        if (typeof rawResultType !== 'string') {
            return {
                kind: 'invalid',
                error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: non-string resultType`, {
                    method,
                    resultType: rawResultType
                })
            };
        }
        if (rawResultType === 'input_required') {
            // The driver seam (#13 consumes this payload).
            const rawInputRequests = raw['inputRequests'];
            const inputRequests = isPlainObject(rawInputRequests) ? rawInputRequests : {};
            const requestState = raw['requestState'];
            if (Object.keys(inputRequests).length === 0 && typeof requestState !== 'string') {
                // At-least-one rule, client side: with neither inputRequests
                // nor requestState there is nothing to fulfil and nothing to
                // echo — retrying would only resend the original params until
                // the round cap is exhausted, so fail fast instead.
                return {
                    kind: 'invalid',
                    error: new SdkError(
                        SdkErrorCode.InvalidResult,
                        `Invalid result for ${method}: input_required carries neither inputRequests nor requestState ` +
                            `(every input_required result must include at least one of the two)`,
                        { method, violation: 'input-required-missing-both' }
                    )
                };
            }
            return {
                kind: 'input_required',
                inputRequests,
                ...(typeof requestState === 'string' && { requestState })
            };
        }
        if (rawResultType !== 'complete') {
            // Unrecognized kind ⇒ invalid, no retry (DQ5).
            return {
                kind: 'invalid',
                error: new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type '${rawResultType}' for ${method}`, {
                    resultType: rawResultType,
                    method
                })
            };
        }

        // Step 2 — wire-exact parse (registry methods), with resultType present.
        // Own-key lookup: `method` is peer-influenced on related-request
        // paths, and a prototype-chain hit (e.g. 'constructor') must not
        // masquerade as a schema and throw out of the decode hop.
        const wireSchema = Object.hasOwn(WIRE_RESULT_SCHEMAS, method) ? WIRE_RESULT_SCHEMAS[method] : undefined;
        if (wireSchema !== undefined) {
            const parsed = wireSchema.safeParse(raw);
            if (!parsed.success) {
                return {
                    kind: 'invalid',
                    error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: ${parsed.error}`, { method })
                };
            }
        }

        // Step 3 — lift: the wire discriminator is consumed.
        const lifted = { ...raw };
        delete lifted['resultType'];
        return { kind: 'complete', result: lifted as Result };
    },

    encodeResult(method: string, result: Result): Result {
        // The stamp seam, in pinned order: deleted-field strictness, then the
        // resultType stamp (handler pass-through only for methods whose
        // vocabulary goes beyond 'complete'), then the cache fill for the
        // cacheable operations (only on post-stamp 'complete' results).
        return fillCacheFields(method, stampResultType(method, enforceDeletedFields(method, result)));
    },

    checkInboundEnvelope(material: LiftedWireMaterial): string | undefined {
        if (material.envelope === undefined) {
            return (
                'Request is missing the required _meta envelope for protocol revision 2026-07-28 ' +
                '(io.modelcontextprotocol/protocolVersion, io.modelcontextprotocol/clientInfo, io.modelcontextprotocol/clientCapabilities)'
            );
        }
        const parsed = RequestMetaEnvelopeSchema.safeParse(material.envelope);
        if (!parsed.success) {
            return `Invalid _meta envelope for protocol revision 2026-07-28: ${parsed.error.issues.map(issue => issue.message).join('; ')}`;
        }
        return undefined;
    }
};

/** Wire-true result wrappers consulted by decode step 2, keyed by method. */
const WIRE_RESULT_SCHEMAS: Record<string, z.ZodType> = {
    'tools/call': CallToolResultSchema,
    'tools/list': ListToolsResultSchema,
    'prompts/get': GetPromptResultSchema,
    'prompts/list': ListPromptsResultSchema,
    'resources/list': ListResourcesResultSchema,
    'resources/templates/list': ListResourceTemplatesResultSchema,
    'resources/read': ReadResourceResultSchema,
    'completion/complete': CompleteResultSchema,
    'server/discover': DiscoverResultSchema
};
