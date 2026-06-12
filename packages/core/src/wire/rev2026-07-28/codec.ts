/**
 * The 2026-era wire codec (protocol revision 2026-07-28).
 *
 * Decode = raw-first `resultType` discrimination (the structural V-1 home:
 * the RAW value is inspected BEFORE any schema validation, so a non-complete
 * result can never be masked into a hollow success by a tolerant schema),
 * then wire-exact parse, then lift (drop the wire member). Encode = the
 * stamp seam: `resultType: 'complete'` is stamped on outbound results, and
 * the known deleted-field set is strictly enforced (Q1-SD3 iii) — the 2026
 * wire types have no slot for `execution.taskSupport` or
 * `capabilities.tasks`, so the encode mapping deletes them; era-blind
 * handlers stay era-invisible while deleted vocabulary cannot cross eras
 * through the parse-free outbound path.
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
 *
 * The ttlMs/cacheScope stamping content (M3.2) lands in `encodeResult` —
 * this seam is its final home.
 */
import { SdkError, SdkErrorCode } from '../../errors/sdkErrors.js';
import type { Result } from '../../types/types.js';
import type { DecodedResult, LiftedWireMaterial, NarrowResultKey, WireCodec } from '../codec.js';
import {
    getNotificationSchema2026,
    getRequestSchema2026,
    getResultSchema2026,
    hasNotificationMethod2026,
    hasRequestMethod2026,
    narrowResultSchemas2026
} from './registry.js';
import type { ResultSchema } from './schemas.js';
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

    requestSchema: method => getRequestSchema2026(method),
    resultSchema: method => getResultSchema2026(method),
    notificationSchema: method => getNotificationSchema2026(method),

    narrowResultSchema: (key: NarrowResultKey) => narrowResultSchemas2026[key],

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
            const inputRequests = raw['inputRequests'];
            return {
                kind: 'input_required',
                inputRequests: isPlainObject(inputRequests) ? inputRequests : {},
                ...(typeof raw['requestState'] === 'string' && { requestState: raw['requestState'] })
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
        const wireSchema = WIRE_RESULT_SCHEMAS[method];
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
        // The stamp seam: outbound results carry the required discriminator.
        // (Handler-authored resultType for methods whose vocabulary exceeds
        // 'complete' is MRTR scope — #13 extends this seam.)
        return { ...enforceDeletedFields(method, result), resultType: 'complete' } as Result;
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
const WIRE_RESULT_SCHEMAS: Record<string, typeof ResultSchema> = {
    'tools/call': CallToolResultSchema as unknown as typeof ResultSchema,
    'tools/list': ListToolsResultSchema as unknown as typeof ResultSchema,
    'prompts/get': GetPromptResultSchema as unknown as typeof ResultSchema,
    'prompts/list': ListPromptsResultSchema as unknown as typeof ResultSchema,
    'resources/list': ListResourcesResultSchema as unknown as typeof ResultSchema,
    'resources/templates/list': ListResourceTemplatesResultSchema as unknown as typeof ResultSchema,
    'resources/read': ReadResourceResultSchema as unknown as typeof ResultSchema,
    'completion/complete': CompleteResultSchema as unknown as typeof ResultSchema,
    'server/discover': DiscoverResultSchema as unknown as typeof ResultSchema
};
