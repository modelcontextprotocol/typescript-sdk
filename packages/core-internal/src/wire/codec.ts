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
import type { SdkError } from '../errors/sdkErrors';
import { isModernProtocolVersion } from '../shared/protocolEras';
import type {
    CallToolResult,
    ClientCapabilities,
    CreateMessageResult,
    CreateMessageResultWithTools,
    Implementation,
    LoggingLevel,
    MessageClassification,
    NotificationMethod,
    NotificationTypeMap,
    RequestMetaEnvelope,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap
} from '../types/types';
import { rev2025Codec } from './rev2025-11-25/codec';
import { rev2026Codec } from './rev2026-07-28/codec';

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

/**
 * Tri-state validation outcome — the function-only contract for what the
 * schema-getter pair (`hasRequestMethod` ⇒ −32601-by-absence; `…Schema(m)
 * .parse` throw ⇒ −32602) used to encode in two pieces. Preserving the split
 * is the point: collapsing 'absent from this era's registry' into 'invalid'
 * would make the in-band fallback chain (validate → on `not-in-era` fall to
 * validateInputRequest) treat absence as failure and never fall through.
 */
export type ValidateOutcome<T> =
    | { readonly ok: true; readonly value: T }
    /**
     * Method is spec vocabulary but absent from THIS era's registry. Callers
     * map to −32601 (inbound) or a typed local SdkError (outbound), or fall
     * through to the in-band validator.
     */
    | { readonly ok: false; readonly reason: 'not-in-era' }
    /**
     * Method is in this era's registry; payload failed the era-exact schema.
     * Callers map to −32602.
     */
    | { readonly ok: false; readonly reason: 'invalid'; readonly message: string };

/** A single self-identifying problem found while validating a per-request `_meta` envelope. */
export interface EnvelopeIssue {
    /**
     * The envelope key the problem is about: one of the reserved `_meta`
     * keys, or a dotted path inside one.
     */
    readonly key: string;
    /** A short description of what is wrong with that key (`missing`, or a validation message). */
    readonly problem: string;
}

/** Material a Client supplies for an era to build its per-request `_meta` envelope from. */
export interface OutboundEnvelopeMaterial {
    readonly protocolVersion: string;
    readonly clientInfo: Implementation;
    readonly clientCapabilities: ClientCapabilities;
    readonly logLevel?: LoggingLevel;
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
    hasInputRequestMethod(method: string): boolean;

    // ── Function-only validation surface ──────────────────────────────────
    // The validator-agnostic contract: callers never see a Zod schema, only a
    // tri-state outcome. The method-literal overloads carry the typed parse
    // result exactly as the (now-deprecated) *Schema getters did.

    /** Era-exact request validation. `not-in-era` ≡ −32601-by-absence; `invalid` ≡ −32602. */
    validateRequest<M extends RequestMethod>(method: M, raw: unknown): ValidateOutcome<RequestTypeMap[M]>;
    validateRequest(method: string, raw: unknown): ValidateOutcome<unknown>;

    /** Era-exact result validation (same registry as `validateRequest`). */
    validateResult<M extends RequestMethod>(method: M, raw: unknown): ValidateOutcome<ResultTypeMap[M]>;
    validateResult(method: string, raw: unknown): ValidateOutcome<unknown>;

    /** Era-exact notification validation. */
    validateNotification<M extends NotificationMethod>(method: M, raw: unknown): ValidateOutcome<NotificationTypeMap[M]>;
    validateNotification(method: string, raw: unknown): ValidateOutcome<unknown>;

    /**
     * In-band (de-JSON-RPC'd) input-request validation — the embedded
     * requests a multi-round-trip `input_required` result may carry. Always
     * `not-in-era` on the 2025 era (elicitation/sampling/roots are wire
     * request methods there). Does NOT grant registry membership.
     */
    validateInputRequest<M extends RequestMethod>(method: M, raw: unknown): ValidateOutcome<RequestTypeMap[M]>;
    validateInputRequest(method: string, raw: unknown): ValidateOutcome<unknown>;

    /** In-band bare-response validation answering an embedded input request. */
    validateInputResponse<M extends RequestMethod>(method: M, raw: unknown): ValidateOutcome<ResultTypeMap[M]>;
    validateInputResponse(method: string, raw: unknown): ValidateOutcome<unknown>;

    /**
     * Param-conditional `sampling/createMessage` result validation — the one
     * spec result whose schema depends on REQUEST params (tools vs no tools).
     * The 2025 era owns the with-tools/plain frozen schemas; the 2026 era
     * returns `not-in-era` (sampling is in-band there — callers fall through
     * to `validateInputResponse`).
     */
    samplingResultVariant(hasTools: true, raw: unknown): ValidateOutcome<CreateMessageResultWithTools>;
    samplingResultVariant(hasTools: false, raw: unknown): ValidateOutcome<CreateMessageResult>;
    samplingResultVariant(hasTools: boolean, raw: unknown): ValidateOutcome<CreateMessageResult | CreateMessageResultWithTools>;

    /**
     * Outbound per-request `_meta` envelope encode. Returns the keyed object
     * to merge into `params._meta` on this era, or `undefined` when this era
     * carries no per-request envelope (the 2025 era — legacy wire stays
     * byte-identical).
     */
    outboundEnvelope(material: OutboundEnvelopeMaterial): Readonly<Record<string, unknown>> | undefined;

    /**
     * Structured envelope validation: maps a `_meta` object to
     * self-identifying issues. The 2025 era never requires an envelope and
     * always returns `[]`; the 2026 era owns the required-key pre-pass plus
     * the wire-exact `RequestMetaEnvelopeSchema` parse.
     */
    validateEnvelopeMeta(meta: Readonly<Record<string, unknown>>): EnvelopeIssue[];

    /**
     * Per-registration `tools/call` result projection. Two independent
     * decisions, both owned here so server-side code never re-derives them:
     *
     * - SEP-2106 §4.3 TextContent auto-append (EVERY era, value-shape-based):
     *   when `structuredContent` is a non-object value (array/primitive/
     *   `null`) and the handler authored no `type:'text'` block, append
     *   `{type:'text', text: JSON.stringify(value)}` so consumers that read
     *   only `content` still receive a rendering. The author opts out by
     *   returning any `text` block themselves.
     *
     * - `{result:…}` wrap (2025 era only): wrap as `{result:<value>}` when the
     *   value is non-object (the 2025 wire shape requires `structuredContent`
     *   to be an object — a schema-less tool returning `[1,2,3]` would
     *   otherwise ship wire-illegal bytes) OR when the tool's ADVERTISED
     *   `outputSchema` has a non-object root (so the result matches the
     *   `encodeResult('tools/list')` projection of the same tool). Identity on
     *   the 2026 era — the wire shape carries the natural value directly.
     */
    projectCallToolResult(result: CallToolResult, advertisedOutputSchema: Readonly<Record<string, unknown>> | undefined): CallToolResult;

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
     * Outbound error-code mapping (the error half of the stamp seam). A
     * handler-thrown `ProtocolError`'s numeric code passes through here on
     * its way to the JSON-RPC error response, so per-era wire-code selection
     * lives in the codec rather than in handler/funnel code. The current
     * mapping is identical on both eras (the `-32002` resource-not-found
     * domain code maps to `-32602` Invalid Params on the wire — the
     * 2026-07-28 spec MUST, and what the deployed v1.x SDK already emits on
     * earlier revisions); the seam is the structural home for any future
     * per-era divergence. Unknown codes pass through unchanged.
     */
    encodeErrorCode(code: number): number;

    /**
     * @deprecated Use {@link validateEnvelopeMeta}. Inbound envelope
     * enforcement for era-classified traffic: validates the lifted envelope
     * material of a request. Returns an error message when the era requires
     * an envelope and it is missing/invalid (→ −32602 at the dispatch
     * layer); `undefined` when acceptable. The 2025 era never requires an
     * envelope.
     */
    checkInboundEnvelope(material: LiftedWireMaterial): string | undefined;
}

/**
 * Era resolution, many-to-one (Q1-SD1): every modern-era revision
 * (`>= 2026-07-28`) → the 2026-era codec; every legacy revision (the five
 * `SUPPORTED_PROTOCOL_VERSIONS`) and `undefined`/unknown → the 2025-era
 * codec (the DV-13 default posture — hand-constructed instances and
 * unclassified traffic are legacy-era). This is the same era predicate the
 * rest of the SDK uses ({@link isModernProtocolVersion}); a pinned modern
 * revision other than the literal '2026-07-28' must still resolve modern.
 */
export function codecForVersion(version: string | undefined): WireCodec {
    return version !== undefined && isModernProtocolVersion(version) ? rev2026Codec : rev2025Codec;
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
