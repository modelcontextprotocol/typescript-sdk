/**
 * The era-granular wire-codec layer (Q1 increment 2).
 *
 * The SDK separates a revision-neutral model layer (the public types — no
 * `resultType`, no `_meta` envelope keys, no retry fields) from per-revision
 * WIRE CODECS that own revision-exact schemas, method registries, and the
 * decode (wire → neutral lift) / encode (neutral → wire stamp) transforms.
 * The codec is a pure function of the negotiated protocol version, which is
 * ordinary connection state on the `Protocol` instance: the client stores it
 * when its handshake completes, the server stores it at `_oninitialize` (and
 * modern-era server instances get it set at instance binding by the entry).
 * There is no side table — era resolution is `codecForVersion(<instance
 * state>)`, with the pre-negotiation window covered by the outbound method
 * pins in `bootstrap.ts`.
 *
 * REQUIRED DISCLOSURE (Q1-SD1, era granularity): "the negotiated version
 * determines which types are serialized/deserialized over the wire" cashes
 * out as "the negotiated wire ERA determines them". All five legacy protocol
 * versions (2024-10-07 … 2025-11-25) share one wire vocabulary and map to the
 * single 2025-era codec — exactly how the single schema set already served
 * all five — and '2026-07-28' maps to the 2026-era codec. A new codec exists
 * only when wire vocabulary actually diverges; intra-era vocabulary is NOT
 * keyed by exact version.
 *
 * Deletions are physical: registry membership is the deletion story. The
 * 2026-era registry has no `tasks/*`, `initialize`, `ping`, `logging/setLevel`,
 * `resources/(un)subscribe` or server→client wire-request entries, so an
 * inbound era-mismatched method falls to −32601 by absence — even when a
 * handler is registered — and an outbound one dies locally with a typed
 * `SdkError` before anything reaches the transport. The 2025-era registry has
 * no `server/discover`/`subscriptions/listen`/MRTR entries, symmetrically.
 *
 * Custom-handler shadowing policy (both directions): a method that belongs to
 * the SPEC-METHOD UNIVERSE — the union of every codec's registry, derived,
 * not hand-curated — is ALWAYS era-gated, so a custom handler registered for
 * a deleted spec method (e.g. `tasks/get`) serves it only on the era that
 * defines it. Methods outside the universe are consumer-owned extension
 * methods: they are era-blind and require explicit schemas, exactly as today.
 *
 * Everything in `wire/` is internal to the bundled, `private: true` core —
 * nothing per-revision is public surface, and nothing here may ever be
 * exported from `core/public`.
 */
import type * as z from 'zod/v4';

import type { SdkError } from '../errors/sdkErrors.js';
import type {
    MessageClassification,
    NotificationMethod,
    NotificationTypeMap,
    RequestMetaEnvelope,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap
} from '../types/types.js';
import { rev2025Codec } from './rev2025-11-25/codec.js';
import { rev2026Codec } from './rev2026-07-28/codec.js';

/** Wire eras with distinct vocabulary. */
export type WireEra = '2025-11-25' | '2026-07-28';

/**
 * The modern wire revision literal. Internal only — deliberately NOT a public
 * constant (G-D2-4: no public modern-version constant ships before era-aware
 * list semantics exist).
 */
export const MODERN_WIRE_REVISION = '2026-07-28';

/**
 * Wire-only material lifted off an inbound message by the protocol layer
 * before dispatch (the V-3 seam): the reserved `_meta` envelope keys and the
 * multi-round-trip driver fields. This is the typed driver-material channel
 * of the codec contract — handlers never see it; the protocol layer surfaces
 * it via `ctx.mcpReq.envelope` / `.inputResponses` / `.requestState`, and the
 * MRTR driver (M4.1) consumes the retry fields from here.
 */
export interface LiftedWireMaterial {
    // Partial: the lift surfaces whichever reserved keys the message actually
    // carried — a peer on an adjacent revision may legally send a subset, and
    // envelope requiredness is enforced per request at dispatch time
    // (`checkInboundEnvelope`), not by the lift.
    envelope?: Partial<RequestMetaEnvelope>;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
}

/** Result decode outcomes — the raw-first discrimination (V-1) lives in `decodeResult`. */
export type DecodedResult =
    | {
          kind: 'complete';
          /** The neutral result value: wire-only material consumed/stripped. */
          result: Result;
      }
    | {
          kind: 'input_required';
          /**
           * Driver-only material (never consumer-visible). The full
           * multi-round-trip driver is M4.1 scope; this seam carries the
           * discriminated payload to it.
           */
          inputRequests: Record<string, unknown>;
          requestState?: string;
      }
    | { kind: 'invalid'; error: SdkError };

/**
 * The per-era wire codec contract (design C §3, adapted to the live funnel
 * layout: the universal wire-only LIFT runs once in the protocol layer for
 * every message — spec, custom, and fallback paths alike — and codecs consume
 * the lifted material rather than re-implementing the strip per era).
 */
export interface WireCodec {
    readonly era: WireEra;

    /** Registry membership — the deletion story (inbound −32601 by absence; outbound typed local error). */
    hasRequestMethod(method: string): boolean;
    hasNotificationMethod(method: string): boolean;

    /**
     * Era-exact dispatch schemas, resolved at dispatch time (never at
     * registration time). The method-literal overloads carry the typed parse
     * result for statically known spec methods, so call sites need no type
     * assertion; `undefined` means the method has no entry on this era's
     * registry.
     */
    requestSchema<M extends RequestMethod>(method: M): z.ZodType<RequestTypeMap[M]> | undefined;
    requestSchema(method: string): z.ZodType | undefined;
    resultSchema<M extends RequestMethod>(method: M): z.ZodType<ResultTypeMap[M]> | undefined;
    resultSchema(method: string): z.ZodType | undefined;
    notificationSchema<M extends NotificationMethod>(method: M): z.ZodType<NotificationTypeMap[M]> | undefined;
    notificationSchema(method: string): z.ZodType | undefined;

    /**
     * In-band (de-JSON-RPC'd) input-request vocabulary of this era — the
     * embedded requests a multi-round-trip `input_required` result may carry
     * and the bare responses that answer them. `undefined` means the method
     * is not in-band vocabulary on this era (the 2025-era codec has none:
     * elicitation/sampling/roots are wire request methods there). These do
     * NOT grant registry membership — a peer sending one of these as a wire
     * request on an era that demoted it still gets −32601 by absence.
     */
    inputRequestSchema<M extends RequestMethod>(method: M): z.ZodType<RequestTypeMap[M]> | undefined;
    inputRequestSchema(method: string): z.ZodType | undefined;
    inputResponseSchema<M extends RequestMethod>(method: M): z.ZodType<ResultTypeMap[M]> | undefined;
    inputResponseSchema(method: string): z.ZodType | undefined;

    /**
     * Step 1 of result decoding: RAW `resultType` handling BEFORE any schema
     * validation (V-1's structural home). Era postures (Q1-SD3):
     * - 2026 era: required discriminator — absent ⇒ typed error naming the
     *   spec violation; `input_required` ⇒ driver payload; unknown ⇒ invalid,
     *   no retry; `complete` ⇒ consume + lift.
     * - 2025 era: `resultType` is foreign vocabulary ⇒ strip-on-lift.
     */
    decodeResult(method: string, raw: unknown): DecodedResult;

    /**
     * Outbound result mapping (the stamp seam). The 2025-era codec is the
     * identity — it has NO stamp code path (the never-stamp guarantee). The
     * 2026-era codec strictly enforces the 2026 wire shape for the known
     * deleted-field set (`execution.taskSupport`, `capabilities.tasks` —
     * Q1-SD3 iii), stamps `resultType`, and fills the required
     * `ttlMs`/`cacheScope` fields on cacheable results.
     */
    encodeResult(method: string, result: Result): Result;

    /**
     * Inbound envelope enforcement for era-classified traffic: validates the
     * lifted envelope material of a request. Returns an error message when
     * the era requires an envelope and it is missing/invalid (→ −32602 at the
     * dispatch layer); `undefined` when acceptable. The 2025 era never
     * requires an envelope.
     */
    checkInboundEnvelope(material: LiftedWireMaterial): string | undefined;
}

/**
 * Era resolution, many-to-one (Q1-SD1): all `SUPPORTED_PROTOCOL_VERSIONS`
 * (the five legacy versions) → the 2025-era codec; '2026-07-28' → the
 * 2026-era codec; `undefined`/unknown → legacy (the DV-13 default posture —
 * hand-constructed instances and unclassified traffic are legacy-era).
 *
 */
export function codecForVersion(version: string | undefined): WireCodec {
    return version === MODERN_WIRE_REVISION ? rev2026Codec : rev2025Codec;
}

/**
 * The wire era an edge classification names (Q2 — produced at the
 * transport/entry edge; this layer only CONSUMES it). The dispatch funnel no
 * longer resolves a codec FROM the classification: era is instance state, and
 * a classified inbound message is VALIDATED against the instance era — a
 * mismatch is an entry/routing error, never a per-message era switch. The
 * exact `revision` wins over the coarse era flag when both are present.
 */
export function classifiedWireEra(classification: MessageClassification): WireEra {
    if (classification.revision !== undefined) return codecForVersion(classification.revision).era;
    return classification.era === 'modern' ? rev2026Codec.era : rev2025Codec.era;
}

/**
 * The derived spec-method universe: the union of every codec registry. A
 * method in this set is era-gated at dispatch and send time; a method outside
 * it is a consumer-owned extension method (era-blind, schema-explicit).
 * Derived from the registries — never hand-curated (the LEGACY_ONLY_METHODS
 * table class is exactly what registry membership replaces).
 */
export function isSpecRequestMethod(method: string): boolean {
    return ALL_CODECS.some(codec => codec.hasRequestMethod(method));
}

export function isSpecNotificationMethod(method: string): boolean {
    return ALL_CODECS.some(codec => codec.hasNotificationMethod(method));
}

const ALL_CODECS: readonly WireCodec[] = [rev2025Codec, rev2026Codec];
