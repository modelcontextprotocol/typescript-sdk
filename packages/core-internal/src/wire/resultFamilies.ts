/**
 * Result-family keys that must never default into a `{content: []}` tools/call
 * success. Shared by the 2025 wire-seam schema and server normalization.
 * Leaf module (like `textFallback.ts`): imported by registry/server paths, so
 * it must NOT import from `./codec.js` — that would close a runtime cycle.
 */
export const TOOL_RESULT_FOREIGN_FAMILY_KEYS = ['task', 'inputRequests', 'requestState'] as const;
