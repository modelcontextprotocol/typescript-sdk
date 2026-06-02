import { describe, expect, it } from 'vitest';

import { DRAFT_PROTOCOL_VERSION, isStatefulProtocolVersion, STATEFUL_PROTOCOL_VERSIONS } from '../../src/types/constants.js';
import { LATEST_PROTOCOL_VERSION as FROZEN_2025_11_25_PROTOCOL_VERSION } from '../../src/types/spec.types.2025-11-25.js';
import { LATEST_PROTOCOL_VERSION as DRAFT_SPEC_LATEST_PROTOCOL_VERSION } from '../../src/types/spec.types.draft.js';

describe('protocol version constants', () => {
    it('pins the draft wire literal to the draft specification schema', () => {
        expect(DRAFT_PROTOCOL_VERSION).toBe(DRAFT_SPEC_LATEST_PROTOCOL_VERSION);
    });

    it('classifies the draft specification revision as stateless', () => {
        expect(isStatefulProtocolVersion(DRAFT_SPEC_LATEST_PROTOCOL_VERSION)).toBe(false);
    });

    it('classifies every released revision up to 2025-11-25 as stateful, newest first', () => {
        expect(STATEFUL_PROTOCOL_VERSIONS[0]).toBe(FROZEN_2025_11_25_PROTOCOL_VERSION);
        expect(STATEFUL_PROTOCOL_VERSIONS).toEqual([...STATEFUL_PROTOCOL_VERSIONS].sort().reverse());
        for (const version of STATEFUL_PROTOCOL_VERSIONS) {
            expect(isStatefulProtocolVersion(version)).toBe(true);
        }
    });
});
