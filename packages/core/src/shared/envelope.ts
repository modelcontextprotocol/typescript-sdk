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
 */
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '../types/constants.js';
import { RequestMetaEnvelopeSchema } from '../wire/rev2026-07-28/schemas.js';

/** A single self-identifying problem found while validating a per-request `_meta` envelope. */
export interface EnvelopeIssue {
    /**
     * The envelope key the problem is about: one of the reserved `_meta` keys,
     * or a dotted path inside one (e.g. `io.modelcontextprotocol/clientInfo.name`).
     */
    key: string;
    /** A short description of what is wrong with that key (`missing`, or a validation message). */
    problem: string;
}

/** The reserved `_meta` keys an envelope must carry (in reporting order). */
const REQUIRED_ENVELOPE_KEYS: readonly string[] = [PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY];

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
    const issues: EnvelopeIssue[] = [];

    for (const key of REQUIRED_ENVELOPE_KEYS) {
        if (!(key in meta)) {
            issues.push({ key, problem: 'missing' });
        }
    }

    const parsed = RequestMetaEnvelopeSchema.safeParse(meta);
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            const path = issue.path.map(String);
            const key = path.length > 0 ? path.join('.') : '_meta';
            // Missing required keys were already reported above in canonical order.
            if (path.length === 1 && issues.some(existing => existing.key === key && existing.problem === 'missing')) {
                continue;
            }
            issues.push({ key, problem: issue.message });
        }
    }

    return issues;
}
