/**
 * Shared types for the e2e suite.
 */

export const ALL_TRANSPORTS = ['inMemory', 'stdio', 'streamableHttp', 'streamableHttpStateless', 'sse'] as const;
export type Transport = (typeof ALL_TRANSPORTS)[number];

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
 * The revision the SDK's default (initialize-era) negotiation lands on. Bodies that do not
 * consume the `protocolVersion` axis exercise exactly this revision, so requirements without
 * an explicit `addedInSpecVersion` register cells here only — labelling a default-negotiation
 * run with a later revision would claim coverage the body does not exercise. Requirements
 * explicitly added in a later revision register across the bounds their fields admit (their
 * bodies pin that revision's behavior). The release that flips the SDK default revisits this
 * restriction together with the bodies it exists for.
 */
export const BASELINE_SPEC_VERSION = '2025-11-25' as const satisfies SpecVersion;

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

export interface Requirement {
    source: string;
    behavior: string;
    transports?: readonly Transport[];
    /** Free-form rationale for how the entry is set up (e.g. why certain transports are excluded). */
    note?: string;

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
