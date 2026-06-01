import { describe, expect, it } from 'vitest';

import { DRAFT_PROTOCOL_VERSION_2026, isStatefulProtocolVersion } from '../../src/types/constants.js';
import { LATEST_PROTOCOL_VERSION as DRAFT_SPEC_LATEST_PROTOCOL_VERSION } from '../../src/types/spec.types.js';

describe('protocol version constants', () => {
    it('pins the draft wire literal to the draft specification schema', () => {
        expect(DRAFT_PROTOCOL_VERSION_2026).toBe(DRAFT_SPEC_LATEST_PROTOCOL_VERSION);
    });

    it('classifies the draft specification revision as stateless', () => {
        expect(isStatefulProtocolVersion(DRAFT_SPEC_LATEST_PROTOCOL_VERSION)).toBe(false);
    });
});
