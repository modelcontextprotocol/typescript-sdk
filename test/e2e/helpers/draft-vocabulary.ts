/**
 * Draft-spec (2026-07-28) vocabulary that must never appear on 2025-era
 * exchanges.
 *
 * Hand-maintained: the entries are the set difference between the draft and
 * 2025-11-25 spec schemas (property names, reserved `_meta` keys, error-code
 * constants, revision strings, and `Mcp-*` header tokens), read off the spec
 * sources at the commit pinned in `packages/core/test/corpus` provenance.
 * Re-derive by hand whenever the vendored spec reference types are repinned —
 * the spec-types comparison tests changing is the prompt.
 *
 * Exemptions (deliberate): `io.modelcontextprotocol/related-task` and the
 * extensions namespace are normative 2025-11-25 vocabulary, not leaks.
 */

/** Property names that exist only in the 2026-07-28 wire schema. */
export const DRAFT_ONLY_FIELD_NAMES = [
    'cacheScope',
    'extensions',
    'inputRequests',
    'inputResponses',
    'notifications',
    'promptsListChanged',
    'requestState',
    'requested',
    'requiredCapabilities',
    'resourceSubscriptions',
    'resourcesListChanged',
    'resultType',
    'supported',
    'supportedVersions',
    'toolsListChanged',
    'ttlMs'
] as const;

/** Reserved `_meta` keys introduced by the 2026-07-28 revision (per-request envelope). */
export const DRAFT_ONLY_META_KEYS = [
    'io.modelcontextprotocol/clientCapabilities',
    'io.modelcontextprotocol/clientInfo',
    'io.modelcontextprotocol/logLevel',
    'io.modelcontextprotocol/protocolVersion'
] as const;

/** JSON-RPC error codes introduced by the 2026-07-28 revision. */
export const DRAFT_ONLY_ERROR_CODES = [-32_003, -32_004] as const;

/** Protocol-revision strings that must not appear on legacy-era exchanges. */
export const DRAFT_ONLY_PROTOCOL_VERSIONS = ['2026-07-28'] as const;

/** HTTP header names (lowercase) introduced by the 2026-07-28 revision. */
export const DRAFT_ONLY_HEADER_NAMES = ['mcp-method', 'mcp-name', 'mcp-param'] as const;

/** Lowercase prefixes of 2026-07-28 header families (e.g. `Mcp-Param-<name>`). */
export const DRAFT_ONLY_HEADER_PREFIXES = ['mcp-param-'] as const;
