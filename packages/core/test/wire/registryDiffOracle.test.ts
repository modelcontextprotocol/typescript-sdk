/**
 * Registry-diff oracle (Q1 increment 3 — generation as ORACLE, never source).
 *
 * The per-era method registries are HAND-WRITTEN (a generator walking anchor
 * method literals would silently re-admit the 2026-demoted server→client
 * methods — the flavor-(b) trap). This oracle derives each revision's method
 * universe FROM THE ANCHOR SOURCE at test time and fails LOUD — with the
 * exact diff — whenever the anchor and the hand registry disagree, modulo a
 * documented seed-decision list that is stale-checked in both directions.
 *
 * Seed decisions (every entry is a deliberate, owned divergence):
 * - 2026 DEMOTIONS: `sampling/createMessage`, `elicitation/create`,
 *   `roots/list` keep method literals in the anchor but are NOT wire request
 *   methods in 2026 — the server→client JSON-RPC request channel is deleted
 *   (`ServerRequest` has no 2026 export; the shapes survive only as in-band
 *   `InputRequest` payloads, M4.1/#13).
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { rev2025NotificationMethods, rev2025RequestMethods } from '../../src/wire/rev2025-11-25/registry.js';
import { rev2026NotificationMethods, rev2026RequestMethods } from '../../src/wire/rev2026-07-28/registry.js';

const ANCHORS = {
    '2025-11-25': path.resolve(__dirname, '../../src/types/spec.types.2025-11-25.ts'),
    '2026-07-28': path.resolve(__dirname, '../../src/types/spec.types.2026-07-28.ts')
} as const;

/** Extract every `method: '<literal>'` from an anchor source. */
function anchorMethods(revision: keyof typeof ANCHORS): { requests: string[]; notifications: string[] } {
    const source = fs.readFileSync(ANCHORS[revision], 'utf8');
    const literals = [...source.matchAll(/method:\s*'([^']+)'/g)].map(m => m[1]!);
    const unique = [...new Set(literals)].sort();
    return {
        requests: unique.filter(m => !m.startsWith('notifications/')),
        notifications: unique.filter(m => m.startsWith('notifications/'))
    };
}

/** Anchor-side methods deliberately NOT in the hand registry (reason per entry). */
const SEED_EXCLUSIONS: Record<string, Record<string, string>> = {
    '2025-11-25': {},
    '2026-07-28': {
        'sampling/createMessage': 'DEMOTED to an in-band InputRequest payload (M4.1/#13) — not a 2026 wire request',
        'elicitation/create': 'DEMOTED to an in-band InputRequest payload (M4.1/#13) — not a 2026 wire request',
        'roots/list': 'DEMOTED to an in-band InputRequest payload (M4.1/#13) — not a 2026 wire request'
    }
};

const REGISTRIES = {
    '2025-11-25': { requests: rev2025RequestMethods, notifications: rev2025NotificationMethods },
    '2026-07-28': { requests: rev2026RequestMethods, notifications: rev2026NotificationMethods }
} as const;

describe.each(['2025-11-25', '2026-07-28'] as const)('registry-diff oracle %s', revision => {
    const anchor = anchorMethods(revision);
    const registry = REGISTRIES[revision];
    const exclusions = SEED_EXCLUSIONS[revision]!;

    test('every anchor method is in the hand registry or a documented seed exclusion', () => {
        const missing = [...anchor.requests, ...anchor.notifications].filter(method => {
            const inRegistry = registry.requests.includes(method) || registry.notifications.includes(method);
            return !inRegistry && !(method in exclusions);
        });
        expect(
            missing,
            `Anchor methods absent from the ${revision} registry with NO seed decision — ` +
                `wire them or add a documented exclusion (this is the loud failure the oracle exists for)`
        ).toEqual([]);
    });

    test('the hand registry contains nothing beyond the anchor universe', () => {
        const anchorSet = new Set([...anchor.requests, ...anchor.notifications]);
        const extra = [...registry.requests, ...registry.notifications].filter(method => !anchorSet.has(method));
        expect(extra, `Registry methods with no ${revision} anchor literal — era leak or typo`).toEqual([]);
    });

    test('seed exclusions are not stale (still in the anchor, still not in the registry)', () => {
        for (const [method, reason] of Object.entries(exclusions)) {
            const inAnchor = anchor.requests.includes(method) || anchor.notifications.includes(method);
            expect(inAnchor, `${method}: exclusion no longer matches any anchor literal — remove it (${reason})`).toBe(true);
            const inRegistry = registry.requests.includes(method) || registry.notifications.includes(method);
            expect(inRegistry, `${method}: now wired in the registry — remove the stale exclusion (${reason})`).toBe(false);
        }
    });

    test('the anchor universe is fully partitioned (sanity: counts add up)', () => {
        const total = anchor.requests.length + anchor.notifications.length;
        const covered =
            registry.requests.filter(m => anchor.requests.includes(m)).length +
            registry.notifications.filter(m => anchor.notifications.includes(m)).length +
            Object.keys(exclusions).length;
        expect(covered).toBe(total);
    });
});
