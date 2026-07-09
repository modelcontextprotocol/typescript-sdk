/**
 * Result-family keys that must never default into a `{content: []}` tools/call
 * success. Shared by the 2025 wire-seam schema and server normalization.
 * Leaf module (like `textFallback.ts`): imported by registry/server paths, so
 * it must NOT import from `./codec.js` — that would close a runtime cycle.
 */
export const TOOL_RESULT_FOREIGN_FAMILY_KEYS = ['task', 'inputRequests', 'requestState'] as const;

/**
 * Single owner of the v1-parity ruling: a plain-object tool result without `content` (and
 * without foreign-family keys) gains `content: []`. Shared by the 2025 wire seam and server-side handler normalization.
 */
export function normalizeContentlessToolResult(value: unknown): unknown {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        (value as { content?: unknown }).content !== undefined ||
        TOOL_RESULT_FOREIGN_FAMILY_KEYS.some(key => key in value)
    ) {
        return value;
    }
    return { ...value, content: [] };
}
