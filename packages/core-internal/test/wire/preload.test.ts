/**
 * preloadSchemas(): the explicit warm-up entry for the lazy wire-schema
 * layers (era factories + the memoized registry/codec lookup maps).
 *
 * The contract under test:
 *   - synchronous and idempotent — repeated calls keep returning the same
 *     memoized objects;
 *   - it warms the SAME memos every lazy consumer pulls through, so lookups
 *     after a preload serve reference-identical objects (no second
 *     construction, no parallel schema graph);
 *   - validation on both eras works normally after a preload.
 *
 * This file deliberately imports no eager schema shim (the per-era
 * `schemas.ts` re-export surfaces): vitest isolates module registries per
 * test file, so preloadSchemas() is the only thing that warms the memos here.
 */
import { describe, expect, it } from 'vitest';

import { codecForVersion, MODERN_WIRE_REVISION } from '../../src/wire/codec';
import { preloadSchemas } from '../../src/wire/preload';
import { buildSchemas2025 } from '../../src/wire/rev2025-11-25/buildSchemas';
import { getNotificationSchema, getRequestSchema } from '../../src/wire/rev2025-11-25/registry';
import { buildSchemas2026 } from '../../src/wire/rev2026-07-28/buildSchemas';
import { getInputRequestSchema2026 } from '../../src/wire/rev2026-07-28/inputRequired';
import { getRequestSchema2026 } from '../../src/wire/rev2026-07-28/registry';

// Module scope, mirroring the intended call site on isolate platforms.
preloadSchemas();

describe('preloadSchemas', () => {
    it('returns void, synchronously', () => {
        expect(preloadSchemas()).toBeUndefined();
    });

    it('is idempotent: repeated calls keep serving the same memoized objects', () => {
        const s2025 = buildSchemas2025();
        const s2026 = buildSchemas2026();
        const pingSchema = getRequestSchema('ping');
        const rootsInput = getInputRequestSchema2026('roots/list');

        preloadSchemas();
        preloadSchemas();

        expect(buildSchemas2025()).toBe(s2025);
        expect(buildSchemas2026()).toBe(s2026);
        expect(getRequestSchema('ping')).toBe(pingSchema);
        expect(getInputRequestSchema2026('roots/list')).toBe(rootsInput);
    });

    it('warms the same memos the lazy consumers pull through (reference identity, no parallel graph)', () => {
        // 2025 era: registry lookups serve objects out of the preloaded set.
        const s2025 = buildSchemas2025();
        expect(getRequestSchema('ping')).toBe(s2025.PingRequestSchema);
        expect(getRequestSchema('initialize')).toBe(s2025.InitializeRequestSchema);
        expect(getNotificationSchema('notifications/progress')).toBe(s2025.ProgressNotificationSchema);

        // 2026 era: the registry reads the dispatch maps straight off the
        // preloaded set, and the in-band response map serves the same objects.
        const s2026 = buildSchemas2026();
        expect(getRequestSchema2026('tools/list')).toBe(s2026.dispatchRequestSchemas['tools/list']);
        expect(getInputRequestSchema2026('roots/list')).toBeDefined();
    });

    it('leaves validation working normally on both eras', () => {
        const legacy = codecForVersion(undefined);
        expect(legacy.era).toBe('2025-11-25');
        expect(legacy.validateRequest('ping', { method: 'ping' })).toEqual({ ok: true, value: { method: 'ping' } });
        expect(legacy.validateNotification('notifications/initialized', { method: 'notifications/initialized' })).toMatchObject({
            ok: true
        });

        const modern = codecForVersion(MODERN_WIRE_REVISION);
        expect(modern.era).toBe('2026-07-28');
        expect(modern.validateRequest('tools/list', { method: 'tools/list' })).toMatchObject({ ok: true });
        // Warmed wire-result wrappers: decode step 2 parses against the
        // preloaded map (a shape violation still fails cleanly).
        expect(modern.decodeResult('tools/list', { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [] })).toMatchObject({
            kind: 'complete'
        });
        expect(
            modern.decodeResult('tools/list', { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: 'not-an-array' })
        ).toMatchObject({ kind: 'invalid' });
    });
});
