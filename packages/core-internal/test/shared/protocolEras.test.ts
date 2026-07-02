import { describe, expect, test } from 'vitest';

import {
    FIRST_MODERN_PROTOCOL_VERSION,
    isModernProtocolVersion,
    legacyProtocolVersions,
    modernProtocolVersions,
    SUPPORTED_MODERN_PROTOCOL_VERSIONS
} from '../../src/shared/protocolEras';
import { LATEST_LEGACY_PROTOCOL_VERSION, SUPPORTED_LEGACY_PROTOCOL_VERSIONS } from '../../src/types/constants';

describe('protocol era helpers', () => {
    test('every released (legacy-list) version is classified legacy', () => {
        for (const version of SUPPORTED_LEGACY_PROTOCOL_VERSIONS) {
            expect(isModernProtocolVersion(version)).toBe(false);
        }
        expect(legacyProtocolVersions(SUPPORTED_LEGACY_PROTOCOL_VERSIONS)).toEqual(SUPPORTED_LEGACY_PROTOCOL_VERSIONS);
        expect(modernProtocolVersions(SUPPORTED_LEGACY_PROTOCOL_VERSIONS)).toEqual([]);
    });

    test('the 2026-07-28 revision and later are classified modern', () => {
        expect(isModernProtocolVersion('2026-07-28')).toBe(true);
        expect(isModernProtocolVersion('2027-01-01')).toBe(true);
        expect(FIRST_MODERN_PROTOCOL_VERSION).toBe('2026-07-28');
    });

    test('subsetting preserves the list preference order', () => {
        const mixed = ['2026-07-28', LATEST_LEGACY_PROTOCOL_VERSION, '2025-06-18'];
        expect(modernProtocolVersions(mixed)).toEqual(['2026-07-28']);
        expect(legacyProtocolVersions(mixed)).toEqual([LATEST_LEGACY_PROTOCOL_VERSION, '2025-06-18']);
    });

    test('era-disjoint constants: the modern list never feeds the legacy initialize list', () => {
        // Ordering guard (counter-offer leak, server.ts counter-offer site): the
        // legacy SUPPORTED_LEGACY_PROTOCOL_VERSIONS constant must not contain modern
        // revisions; modern negotiation reads SUPPORTED_MODERN_PROTOCOL_VERSIONS,
        // which must contain only modern revisions.
        expect(SUPPORTED_LEGACY_PROTOCOL_VERSIONS.some(isModernProtocolVersion)).toBe(false);
        expect(SUPPORTED_MODERN_PROTOCOL_VERSIONS.every(isModernProtocolVersion)).toBe(true);
    });
});
