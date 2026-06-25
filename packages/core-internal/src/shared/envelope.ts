/**
 * Per-request `_meta` envelope claim helpers (protocol revision 2026-07-28).
 *
 * Pure, value-returning helpers used by the inbound HTTP classifier
 * (`classifyInboundRequest`): claim detection and envelope validation with
 * self-identifying issues. The envelope schema itself stays the wire layer's
 * single source of truth (`RequestMetaEnvelopeSchema`); this module only maps
 * its outcomes into the shapes the validation ladder emits.
 *
 * Claim detection is deliberately narrow: a message claims the 2026-07-28
 * envelope mechanism if and only if the reserved protocol-version `_meta` key
 * is present in `params._meta`. Other reserved keys (client info, client
 * capabilities, log level), a bare `progressToken`, or unrelated keys under
 * the `io.modelcontextprotocol/` prefix do NOT constitute a claim on their
 * own — but once the claim key is present, a malformed envelope is a
 * validation error, never a silent fall back to legacy handling.
 *
 * The wire-exact envelope schema, the required-key set, and the per-key issue
 * mapping live in the wire layer (the 2026-era codec's `validateEnvelopeMeta`).
 * This module never reaches into a per-revision wire module directly.
 */
import { PROTOCOL_VERSION_META_KEY } from '../types/constants.js';
import type { EnvelopeIssue } from '../wire/codec.js';
import { codecForVersion, MODERN_WIRE_REVISION } from '../wire/codec.js';

// Re-export from the wire layer (the canonical home): the issue shape is part
// of the function-only WireCodec contract. Imported above for the local return
// type, so the bare re-export form is used.
// eslint-disable-next-line unicorn/prefer-export-from
export type { EnvelopeIssue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The `_meta` object of a message's params, when present. */
export function requestMetaOf(params: unknown): Record<string, unknown> | undefined {
    if (!isPlainObject(params)) return undefined;
    const meta = params['_meta'];
    return isPlainObject(meta) ? meta : undefined;
}

/**
 * Whether a message's params carry the per-request envelope claim: the
 * reserved protocol-version `_meta` key is present (regardless of whether the
 * rest of the envelope is valid — validation is a separate, later step).
 */
export function hasEnvelopeClaim(params: unknown): boolean {
    const meta = requestMetaOf(params);
    return meta !== undefined && PROTOCOL_VERSION_META_KEY in meta;
}

/**
 * The protocol version named by a message's envelope claim, when the claim is
 * present and carries a string value. A present claim with a non-string value
 * still counts as a claim ({@linkcode hasEnvelopeClaim}); it surfaces as a
 * validation issue instead of a version.
 */
export function envelopeClaimVersion(params: unknown): string | undefined {
    const meta = requestMetaOf(params);
    const value = meta?.[PROTOCOL_VERSION_META_KEY];
    return typeof value === 'string' ? value : undefined;
}

/**
 * Validates a request's `_meta` object as a 2026-07-28 per-request envelope
 * and reports problems as self-identifying issues (which key, what problem).
 *
 * Returns an empty array when the envelope is valid. Missing required keys are
 * reported first (as `problem: 'missing'`), then schema violations inside
 * present keys, in a stable order.
 */
export function validateEnvelopeMeta(meta: Record<string, unknown>): EnvelopeIssue[] {
    // Delegate to the era codec: the required-key pre-pass and the wire-exact
    // `RequestMetaEnvelopeSchema` parse live in `wire/rev2026-07-28/` — this
    // module never reaches into per-revision wire vocabulary.
    return codecForVersion(MODERN_WIRE_REVISION).validateEnvelopeMeta(meta);
}
