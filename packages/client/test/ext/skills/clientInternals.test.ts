import { describe, expect, it } from 'vitest';

import { Client } from '../../../src/client/client';
import { clientSettings } from '../../../src/ext/skills/clientInternals';

const INFO = { name: 'c', version: '1.0.0' };

describe('clientSettings', () => {
    it('reads the private Client settings it relies on, and fails if they are renamed', () => {
        expect(clientSettings(new Client(INFO))).toEqual({ enforceStrictCapabilities: false, listMaxPages: 64 });
        expect(clientSettings(new Client(INFO, { enforceStrictCapabilities: true, listMaxPages: 3 }))).toEqual({
            enforceStrictCapabilities: true,
            listMaxPages: 3
        });
        const privates = new Client(INFO) as unknown as Record<string, unknown>;
        expect(privates).toHaveProperty('_enforceStrictCapabilities');
        expect(privates).toHaveProperty('_listMaxPages');
    });
});
