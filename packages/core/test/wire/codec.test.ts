/**
 * `codecForVersion` era resolution: the era predicate, not an exact-match
 * literal. A pinned modern revision other than '2026-07-28' (e.g. a
 * `protocolVersionPin: '2026-09-01'`, or the first entry of a custom modern
 * supported-versions list) must resolve to the 2026-era codec — the probe
 * builder calls `codecForVersion(pin).outboundEnvelope(…)`, and an exact-match
 * resolver would silently return the 2025 codec (whose `outboundEnvelope` is
 * `undefined`), producing a probe with no `_meta` envelope and a silent
 * downgrade to the legacy connect path.
 */
import { describe, expect, test } from 'vitest';

import { codecForVersion, MODERN_WIRE_REVISION } from '../../src/wire/codec.js';

const MATERIAL = {
    protocolVersion: '2026-09-01',
    clientInfo: { name: 'probe-client', version: '0.0.0' },
    clientCapabilities: {}
};

describe('codecForVersion era resolution', () => {
    test('every modern revision (>= 2026-07-28) resolves to the 2026-era codec', () => {
        expect(codecForVersion(MODERN_WIRE_REVISION).era).toBe('2026-07-28');
        expect(codecForVersion('2026-09-01').era).toBe('2026-07-28');
        expect(codecForVersion('2027-01-01').era).toBe('2026-07-28');
    });

    test('a pinned modern revision other than the literal still produces the 3-key envelope (probe regression)', () => {
        const envelope = codecForVersion('2026-09-01').outboundEnvelope(MATERIAL);
        expect(envelope).toBeDefined();
        expect(Object.keys(envelope ?? {}).sort()).toEqual([
            'io.modelcontextprotocol/clientCapabilities',
            'io.modelcontextprotocol/clientInfo',
            'io.modelcontextprotocol/protocolVersion'
        ]);
    });

    test('every legacy revision and undefined resolve to the 2025-era codec', () => {
        for (const v of ['2024-10-07', '2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', undefined]) {
            expect(codecForVersion(v).era).toBe('2025-11-25');
            expect(codecForVersion(v).outboundEnvelope(MATERIAL)).toBeUndefined();
        }
    });
});
