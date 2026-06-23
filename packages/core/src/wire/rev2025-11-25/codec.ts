/**
 * The 2025-era wire codec: decode/encode ≈ identity.
 *
 * This codec serves every legacy protocol version (2024-10-07 … 2025-11-25).
 * It is BEHAVIOR-FROZEN behind the Q10-L2 byte-identity suite — its schemas
 * are today's schemas, its registry is today's method map, and its encode
 * path is the identity.
 *
 * Never-stamp guarantee: this module NEVER WRITES 2026 vocabulary
 * (`resultType`, `ttlMs`, `cacheScope`, the `_meta` envelope keys) — there is
 * no code path that can. `encodeResult` is the identity for every result
 * EXCEPT the SEP-2106 `tools/list` projection: when a tool's neutral
 * `outputSchema` has a non-object root, the 2025 wire shape requires
 * `type:'object'` there, so the codec PROJECTS the public superset down by
 * wrapping the advertised schema as `{type:'object',
 * properties:{result:<natural>}, required:['result']}`. That projection
 * narrows neutral→2025-wire; it never adds 2026 vocabulary.
 *
 * One deliberate exception to "no 2026 code path" (Q1-SD3 ii, amending the
 * V-2 'no code path at all' design claim): `decodeResult` STRIPS a foreign
 * `resultType` key from inbound results before validation (strip-on-lift).
 * `resultType` is not 2025 vocabulary — a 2025 peer that sends it is
 * misbehaving — and the ruled posture is tolerate-and-drop so the foreign key
 * can neither surface to consumers (the neutral types have no slot for it)
 * nor leak through the retained loose-object passthrough. This is the ONLY
 * 2026-vocabulary code path in the 2025 codec, it exists on the decode side
 * only, and it deletes — never reads, maps, or emits — the foreign value.
 */
import type * as z from 'zod/v4';

import type { CallToolResult, Result } from '../../types/types.js';
import type { DecodedResult, EnvelopeIssue, LiftedWireMaterial, OutboundEnvelopeMaterial, ValidateOutcome, WireCodec } from '../codec.js';
import { appendTextFallbackForNonObject } from '../codec.js';
import { isNonObjectJsonSchemaRoot, wrapOutputSchemaForLegacy } from './legacyWrap.js';
import { getNotificationSchema, getRequestSchema, getResultSchema, hasNotificationMethod2025, hasRequestMethod2025 } from './registry.js';
import { CreateMessageResultSchema, CreateMessageResultWithToolsSchema } from './schemas.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Tri-state wrap of an optional Zod schema lookup (the function-only contract). */
function triState<T>(schema: z.ZodType<T> | undefined, raw: unknown): ValidateOutcome<T> {
    if (schema === undefined) return { ok: false, reason: 'not-in-era' };
    const parsed = schema.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid', message: String(parsed.error) };
}

const NOT_IN_ERA: ValidateOutcome<never> = { ok: false, reason: 'not-in-era' };

/** Whether a `tools/list` entry advertises a non-object `outputSchema` root that needs the SEP-2106 legacy wrap. */
function toolNeedsLegacyWrap(t: unknown): t is { outputSchema: Record<string, unknown> } {
    return isPlainObject(t) && isPlainObject(t['outputSchema']) && isNonObjectJsonSchemaRoot(t['outputSchema']);
}

/** The wire→neutral trust boundary: a decoded 2025-era wire result is adopted as the neutral `Result` here (the module's single deliberate assertion). */
function toNeutralResult(value: unknown): Result {
    return value as Result;
}

export const rev2025Codec: WireCodec = {
    era: '2025-11-25',

    hasRequestMethod: hasRequestMethod2025,
    hasNotificationMethod: hasNotificationMethod2025,

    // ── Function-only validation surface ──
    validateRequest: (method: string, raw: unknown) => triState(getRequestSchema(method), raw),
    validateResult: (method: string, raw: unknown) => triState(getResultSchema(method), raw),
    validateNotification: (method: string, raw: unknown) => triState(getNotificationSchema(method), raw),
    // No in-band input-request vocabulary on this era: elicitation, sampling
    // and roots are real wire request methods here (see the registry).
    hasInputRequestMethod: (): boolean => false,
    validateInputRequest: (): ValidateOutcome<never> => NOT_IN_ERA,
    validateInputResponse: (): ValidateOutcome<never> => NOT_IN_ERA,

    // Arrow literals can't carry overload signatures; the cast is sound (the
    // boolean dispatches to exactly the schema each overload names).
    samplingResultVariant: ((hasTools: boolean, raw: unknown) =>
        triState(hasTools ? CreateMessageResultWithToolsSchema : CreateMessageResultSchema, raw)) as WireCodec['samplingResultVariant'],

    // The 2025 era carries no per-request `_meta` envelope — legacy wire
    // bytes stay identical (the never-stamp guarantee, outbound-request half).
    outboundEnvelope: (_material: OutboundEnvelopeMaterial): undefined => undefined,
    validateEnvelopeMeta: (_meta: Readonly<Record<string, unknown>>): EnvelopeIssue[] => [],

    projectCallToolResult(result: CallToolResult, advertisedOutputSchema): CallToolResult {
        // Era-agnostic SEP-2106 §4.3 TextContent auto-append first (value-shape-based).
        const withText = appendTextFallbackForNonObject(result);
        const sc = withText.structuredContent;
        if (sc === undefined) return withText;
        // SEP-2106 result-side projection. Wrap as `{result:<sc>}` when EITHER:
        //  - the value is non-object (array/primitive/`null`) — REGARDLESS of
        //    advertised schema, because the 2025 wire shape requires
        //    `structuredContent` to be an object (a schema-less tool returning
        //    `[1,2,3]` would otherwise ship wire-illegal bytes), or
        //  - the advertised `outputSchema` has a non-object root — so the
        //    result satisfies the wrapped schema this codec's
        //    `encodeResult('tools/list', …)` advertised for the same tool.
        const valueIsNonObject = typeof sc !== 'object' || sc === null || Array.isArray(sc);
        const schemaWrapped = advertisedOutputSchema !== undefined && isNonObjectJsonSchemaRoot(advertisedOutputSchema);
        if (!valueIsNonObject && !schemaWrapped) return withText;
        return { ...withText, structuredContent: { result: sc } };
    },

    decodeResult(_method: string, raw: unknown): DecodedResult {
        // Strip-on-lift (Q1-SD3 ii): a foreign `resultType` on the 2025 leg is
        // dropped before validation, whatever its value. There is no
        // discrimination on this era — `resultType` carries no meaning here.
        if (isPlainObject(raw) && 'resultType' in raw) {
            const stripped = { ...raw };
            delete stripped['resultType'];
            return { kind: 'complete', result: toNeutralResult(stripped) };
        }
        return { kind: 'complete', result: toNeutralResult(raw) };
    },

    // The never-stamp guarantee: never writes 2026 vocabulary. Identity for
    // every result EXCEPT the SEP-2106 `tools/list` projection (see header).
    // Copy-on-write: a listing with no non-object outputSchema roots returns
    // the same reference (the byte-identity suite pins this).
    encodeResult(method: string, result: Result): Result {
        if (method !== 'tools/list') return result;
        const tools = (result as { tools?: unknown }).tools;
        if (!Array.isArray(tools) || !tools.some(t => toolNeedsLegacyWrap(t))) return result;
        return {
            ...result,
            tools: tools.map(t => (toolNeedsLegacyWrap(t) ? { ...t, outputSchema: wrapOutputSchemaForLegacy(t.outputSchema) } : t))
        } as Result;
    },

    // The −32002 resource-not-found domain code maps to −32602 on the wire on
    // this era too (matching what the deployed v1.x SDK already emits — this
    // is not a behavior change for v1.x peers). There is deliberately no era
    // branch that preserves −32002.
    encodeErrorCode: (code: number): number => (code === -32_002 ? -32_602 : code),

    // The 2025 era never requires a per-request envelope.
    checkInboundEnvelope: (_material: LiftedWireMaterial): string | undefined => undefined
};
