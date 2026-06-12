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
import type { Result } from '../../types/types.js';
import type { DecodedResult, LiftedWireMaterial, NarrowResultKey, WireCodec } from '../codec.js';
import {
    getNotificationSchema,
    getRequestSchema,
    getResultSchema,
    hasNotificationMethod2025,
    hasRequestMethod2025,
    narrowResultSchemas2025
} from './registry.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const rev2025Codec: WireCodec = {
    era: '2025-11-25',

    hasRequestMethod: hasRequestMethod2025,
    hasNotificationMethod: hasNotificationMethod2025,

    requestSchema: method => getRequestSchema(method),
    resultSchema: method => getResultSchema(method),
    notificationSchema: method => getNotificationSchema(method),

    narrowResultSchema: (key: NarrowResultKey) => narrowResultSchemas2025[key],

    decodeResult(_method: string, raw: unknown): DecodedResult {
        // Strip-on-lift (Q1-SD3 ii): a foreign `resultType` on the 2025 leg is
        // dropped before validation, whatever its value. There is no
        // discrimination on this era — `resultType` carries no meaning here.
        if (isPlainObject(raw) && 'resultType' in raw) {
            const stripped = { ...raw };
            delete stripped['resultType'];
            return { kind: 'complete', result: stripped as Result };
        }
        return { kind: 'complete', result: raw as Result };
    },

    // The never-stamp guarantee: identity. No stamp code path exists.
    encodeResult: (_method: string, result: Result): Result => result,

    // The 2025 era never requires a per-request envelope.
    checkInboundEnvelope: (_material: LiftedWireMaterial): string | undefined => undefined
};
