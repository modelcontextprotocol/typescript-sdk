import type { ServerCapabilities } from '@modelcontextprotocol/core-internal';

import type { Server } from './server';

// Extension ids each server serves only on protocol 2026-07-28 and later.
const modernOnly = new WeakMap<Server, Set<string>>();

// Keeps `id` out of the capabilities `server` advertises in a legacy `initialize` result.
export function markModernOnlyExtension(server: Server, id: string): void {
    const ids = modernOnly.get(server) ?? new Set<string>();
    ids.add(id);
    modernOnly.set(server, ids);
}

// `capabilities` without the extensions marked modern-only on `server`, and without `extensions` when none remain.
export function legacyAdvertisedCapabilities(server: Server, capabilities: ServerCapabilities): ServerCapabilities {
    const ids = modernOnly.get(server);
    if (ids === undefined || capabilities.extensions === undefined) return capabilities;
    const { extensions, ...rest } = capabilities;
    const kept = Object.fromEntries(Object.entries(extensions).filter(([id]) => !ids.has(id)));
    return Object.keys(kept).length === 0 ? rest : { ...rest, extensions: kept };
}
