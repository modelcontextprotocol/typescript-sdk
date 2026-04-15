const _warned = new Set<string>();

/**
 * Emits a one-time deprecation warning to stderr. Subsequent calls with the
 * same `key` are no-ops for the lifetime of the process.
 *
 * Used by v1-compat shims to nudge consumers toward the v2-native API without
 * spamming logs on hot paths (e.g. per-tool registration).
 *
 * @internal
 */
export function deprecate(key: string, msg: string): void {
    if (_warned.has(key)) return;
    _warned.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[mcp-sdk] DEPRECATED: ${msg}`);
}

/** @internal exposed for tests */
export function _resetDeprecationWarnings(): void {
    _warned.clear();
}
