/**
 * Shared types for the e2e suite.
 */

export const ALL_TRANSPORTS = ['inMemory', 'stdio', 'streamableHttp', 'streamableHttpStateless', 'sse'] as const;

/**
 * The createMcpHandler entry arms: the dual-era HTTP entry hosted in process
 * (injected fetch → `handler.fetch`), one arm per slot. `entryStateless` serves
 * a plain 2025-era client through the entry's `legacy: 'stateless'` slot;
 * `entryModern` serves a client that negotiates the 2026-07-28 revision through
 * the entry's modern (per-request envelope) path. Each arm is era-fixed, so it
 * registers cells on exactly one spec-version axis (see TRANSPORT_SPEC_VERSIONS).
 */
export const ENTRY_TRANSPORTS = ['entryStateless', 'entryModern'] as const;
export type EntryTransport = (typeof ENTRY_TRANSPORTS)[number];

export type Transport = (typeof ALL_TRANSPORTS)[number] | EntryTransport;

/**
 * Every spec version the manifest may reference — used for typing
 * `addedInSpecVersion` / `removedInSpecVersion` bounds and knownFailure
 * scoping. Includes versions that are not yet part of the active matrix.
 */
export const KNOWN_SPEC_VERSIONS = ['2025-11-25', '2026-07-28'] as const;
export type SpecVersion = (typeof KNOWN_SPEC_VERSIONS)[number];

/** The spec versions cells are registered for (the active matrix axis). */
export const ALL_SPEC_VERSIONS = ['2025-11-25', '2026-07-28'] as const satisfies readonly SpecVersion[];

/**
 * Spec versions a transport arm can serve. Transports without an entry serve
 * every spec version on the active axis; the entry arms are era-fixed (the
 * `legacy: 'stateless'` slot serves only 2025-era traffic, the modern path
 * serves only the 2026-07-28 revision), so each registers cells on exactly one
 * axis. `verifies()` intersects this with a requirement's own spec-version
 * bounds when forming cells.
 */
export const TRANSPORT_SPEC_VERSIONS: Partial<Record<Transport, readonly SpecVersion[]>> = {
    entryStateless: ['2025-11-25'],
    entryModern: ['2026-07-28']
};

/**
 * Arguments every test body receives. Expand with new matrix axes here so
 * test signatures don't churn — bodies destructure only what they use.
 */
export interface TestArgs {
    transport: Transport;
    protocolVersion: SpecVersion;
}

export interface KnownFailure {
    test?: string;
    transport?: Transport;
    specVersion?: SpecVersion;
    note: string;
}

/**
 * Machine-readable reasons a requirement is excluded from the createMcpHandler
 * entry arms. The exclusion list doubles as the acceptance checklist for the
 * entry features that have not landed yet: when one of them lands, its
 * reason's entries are the cells to re-admit. (Requirement families that the
 * per-request entry structurally cannot serve at all — server→client requests,
 * sessions/resumability, standalone GET streams, subscriptions — are already
 * expressed through their existing `transports` restrictions and never reach
 * the entry arms, so they need no annotation here.)
 *
 * - `requires-session` — needs a persistent connected server instance (or
 *   connection-level message delivery beyond one request/response exchange);
 *   the entry's modern path serves every request with a fresh instance.
 * - `method-not-in-modern-registry` — drives a method the 2026-07-28 registry
 *   deletes (ping, logging/setLevel, resources/subscribe,
 *   notifications/roots/list_changed, …); meaningful only for `entryModern`.
 * - `asserts-legacy-handshake` — asserts initialize/initialized handshake or
 *   initialize-based version-negotiation mechanics; the modern path negotiates
 *   via server/discover and never sends initialize, so the body would assert
 *   vacuously or fail. Meaningful only for `entryModern`.
 * - `legacy-only-vocabulary` — asserts wire vocabulary or advertisement flags
 *   the 2026-07-28 surface deliberately deletes or omits (tools[].execution,
 *   listChanged/subscribe capability flags on server/discover). Meaningful
 *   only for `entryModern`.
 * - `modern-error-surface` — asserts the 2025-era client-facing error surface
 *   (ProtocolError with the wire code) for dispatch-window errors; on the
 *   modern per-request path those errors ride mapped HTTP statuses and the
 *   client currently surfaces them as SdkHttpError (see the coverage report's
 *   GAPS FOUND). Meaningful only for `entryModern`.
 * - `drives-transport-directly` — the body builds and drives its own transport
 *   or hosting instead of the wired pair, so an entry cell would duplicate an
 *   existing cell without exercising the entry.
 */
export const ENTRY_EXCLUSION_REASONS = [
    'requires-session',
    'method-not-in-modern-registry',
    'asserts-legacy-handshake',
    'legacy-only-vocabulary',
    'modern-error-surface',
    'drives-transport-directly'
] as const;
export type EntryExclusionReason = (typeof ENTRY_EXCLUSION_REASONS)[number];

export interface EntryExclusion {
    /** The entry arm excluded; omit to exclude both arms. */
    arm?: EntryTransport;
    reason: EntryExclusionReason;
    /** Optional elaboration beyond the machine-readable reason. */
    note?: string;
}

export interface Requirement {
    source: string;
    behavior: string;
    transports?: readonly Transport[];
    /** Free-form rationale for how the entry is set up (e.g. why certain transports are excluded). */
    note?: string;

    /**
     * Exclusions from the createMcpHandler entry arms (`entryStateless` /
     * `entryModern`), each with a machine-readable reason. Only meaningful when
     * the requirement's transports would otherwise include the targeted arm
     * (the default `ALL_TRANSPORTS` does); an explicit `transports` list that
     * already omits the entry arms needs no annotation here.
     */
    entryExclusions?: readonly EntryExclusion[];

    /** First / last spec versions a requirement applies to; changed behaviors are sibling entries linked via `supersedes`/`supersededBy`. */
    addedInSpecVersion?: SpecVersion;
    removedInSpecVersion?: SpecVersion;
    /**
     * Requirement ids this (new) entry replaces. The structural link from a superseding entry to the
     * retired entries it covers: each listed id's `supersededBy` points back at this entry. Semantic
     * context about how/why the behavior changed belongs in `note`, not here.
     */
    supersedes?: readonly string[];
    /**
     * Requirement id of the entry that replaces this (retired) one. The structural link from a retired
     * entry to its successor: that entry's `supersedes` array includes this id. Semantic context about
     * how/why the behavior changed belongs in `note`, not here.
     */
    supersededBy?: string;
    knownFailures?: readonly KnownFailure[];

    deferred?: string;
}
