/**
 * Shared types for the e2e suite.
 */

export const ALL_TRANSPORTS = ['inMemory', 'stdio', 'streamableHttp', 'streamableHttpStateless'] as const;
export type Transport = (typeof ALL_TRANSPORTS)[number];

export const ALL_SPEC_VERSIONS = ['2025-11-25'] as const;
export type SpecVersion = (typeof ALL_SPEC_VERSIONS)[number];

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

    /** First / last spec versions a requirement applies to; changed behaviors are sibling entries linked via `supersedes`. */
    addedInSpecVersion?: SpecVersion;
    removedInSpecVersion?: SpecVersion;
    /** Requirement id this entry replaces (for behaviors changed by a spec release). */

    supersedes?: string;
    knownFailures?: readonly KnownFailure[];

    deferred?: string;
}
