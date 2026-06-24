/**
 * The 2025-era wire codec: decode/encode ≈ identity.
 *
 * This codec serves every legacy protocol version (2024-10-07 … 2025-11-25).
 * It is BEHAVIOR-FROZEN behind the Q10-L2 byte-identity suite — its schemas
 * are today's schemas, its registry is today's method map, and its encode
 * path is the identity.
 *
 * Never-stamp guarantee: `encodeResult` is the identity function. There is no
 * stamp code path in this module — a 2025-era response cannot carry
 * `resultType`, `ttlMs`, `cacheScope`, or envelope keys because no code here
 * can write them, not because a stamping branch is gated off.
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

    // Identity stub in this commit. The SEP-2106 wrap (and the matching
    // `encodeResult('tools/list')` projection) is wired by the commit that
    // widens the public schemas — see `./legacyWrap.ts` for the helpers it
    // consumes. Kept identity here so both halves activate together.
    projectCallToolResult: (result: CallToolResult): CallToolResult => result,

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

    // The never-stamp guarantee: identity. No stamp code path exists.
    encodeResult: (_method: string, result: Result): Result => result,

    // The −32002 resource-not-found domain code maps to −32602 on the wire on
    // this era too (matching what the deployed v1.x SDK already emits — this
    // is not a behavior change for v1.x peers). There is deliberately no era
    // branch that preserves −32002.
    encodeErrorCode: (code: number): number => (code === -32_002 ? -32_602 : code),

    // The 2025 era never requires a per-request envelope.
    checkInboundEnvelope: (_material: LiftedWireMaterial): string | undefined => undefined
};
