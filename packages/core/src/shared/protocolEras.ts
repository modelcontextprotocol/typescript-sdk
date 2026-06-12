/**
 * Protocol-era helpers (pure module).
 *
 * The MCP wire protocol splits into two eras:
 *
 * - **legacy** — the 2025-11-25 family of revisions and earlier. Connections are
 *   established with the `initialize` handshake; the protocol version is negotiated
 *   once per connection.
 * - **modern** — protocol revision 2026-07-28 and later. There is no `initialize`
 *   handshake; servers advertise their supported versions via `server/discover` and
 *   every request carries a per-request `_meta` envelope.
 *
 * Era-aware supported-version list semantics: an operation that belongs to one era
 * must only ever consult that era's subset of a supported-versions list. In
 * particular, the `initialize` handshake (a legacy-era operation) must never accept
 * or counter-offer a modern revision — see {@linkcode legacyProtocolVersions} — and
 * the `server/discover` advertisement must only ever contain modern revisions — see
 * {@linkcode modernProtocolVersions}. This keeps modern version strings out of
 * 2025-era exchanges even when a single supported-versions list spans both eras.
 */

/**
 * The first protocol revision of the modern (2026-07-28) era.
 *
 * Revision identifiers are ISO dates, so lexicographic comparison orders them
 * chronologically.
 */
export const FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * Modern-era protocol revisions this SDK can negotiate via `server/discover`.
 *
 * Deliberately separate from {@linkcode SUPPORTED_PROTOCOL_VERSIONS} (the legacy
 * `initialize` list): the two lists feed era-disjoint code paths, so adding a
 * revision here can never leak a modern version string into a 2025-era handshake.
 *
 * Internal — not part of the public API surface.
 */
export const SUPPORTED_MODERN_PROTOCOL_VERSIONS = [FIRST_MODERN_PROTOCOL_VERSION];

/**
 * Whether the given protocol revision belongs to the modern (2026-07-28+) era.
 */
export function isModernProtocolVersion(version: string): boolean {
    return version >= FIRST_MODERN_PROTOCOL_VERSION;
}

/**
 * The legacy-era (pre-2026-07-28) subset of a supported-versions list, in the
 * list's own preference order.
 */
export function legacyProtocolVersions(versions: readonly string[]): string[] {
    return versions.filter(version => !isModernProtocolVersion(version));
}

/**
 * The modern-era (2026-07-28+) subset of a supported-versions list, in the list's
 * own preference order.
 */
export function modernProtocolVersions(versions: readonly string[]): string[] {
    return versions.filter(version => isModernProtocolVersion(version));
}
