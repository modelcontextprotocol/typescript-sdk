/**
 * Protocol-era helpers (pure module). The MCP wire protocol splits into two eras:
 * legacy (the 2025-11-25 family and earlier; the version is negotiated via the
 * `initialize` handshake) and modern (2026-07-28 and later; no `initialize` —
 * servers advertise versions via `server/discover` and every request carries a
 * `_meta` envelope).
 *
 * An operation that belongs to one era must only ever consult that era's subset
 * of a supported-versions list: `initialize` never accepts or counter-offers a
 * modern revision, and the `server/discover` advertisement only ever contains
 * modern revisions.
 */

/**
 * The protocol era of a connection: `'legacy'` for the 2025-11-25 family and
 * earlier (negotiated via `initialize`), `'modern'` for 2026-07-28 and later
 * (negotiated via `server/discover`; every request carries a `_meta` envelope).
 */
export type ProtocolEra = 'legacy' | 'modern';

/**
 * The first protocol revision of the modern (2026-07-28) era. Revision identifiers
 * are ISO dates, so lexicographic comparison orders them chronologically.
 */
export const FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * Modern-era protocol revisions this SDK can negotiate via `server/discover`.
 * Deliberately separate from {@linkcode SUPPORTED_PROTOCOL_VERSIONS} (the legacy
 * `initialize` list), so adding a revision here can never leak a modern version
 * string into a 2025-era handshake. Internal — not part of the public API surface.
 */
export const SUPPORTED_MODERN_PROTOCOL_VERSIONS = [FIRST_MODERN_PROTOCOL_VERSION];

/** Whether the given protocol revision belongs to the modern (2026-07-28+) era. */
export function isModernProtocolVersion(version: string): boolean {
    return version >= FIRST_MODERN_PROTOCOL_VERSION;
}

/** The legacy-era (pre-2026-07-28) subset of a supported-versions list, in the list's own preference order. */
export function legacyProtocolVersions(versions: readonly string[]): string[] {
    return versions.filter(version => !isModernProtocolVersion(version));
}

/** The modern-era (2026-07-28+) subset of a supported-versions list, in the list's own preference order. */
export function modernProtocolVersions(versions: readonly string[]): string[] {
    return versions.filter(version => isModernProtocolVersion(version));
}
