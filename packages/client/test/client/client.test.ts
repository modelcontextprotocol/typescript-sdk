import { DRAFT_PROTOCOL_VERSION_2026, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';

import { Client } from '../../src/client/client.js';

describe('Client', () => {
    // The validation itself lives in the shared Protocol constructor (covered in depth by the core
    // package's protocol.test.ts); these are smoke tests that ClientOptions passes both keys through.
    describe('draft protocol version opt-in (allowDraftVersions)', () => {
        it('throws at construction when a draft version is listed without allowDraftVersions', () => {
            const construct = () =>
                new Client({ name: 'test-client', version: '1.0.0' }, { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION_2026] });

            expect(construct).toThrow(DRAFT_PROTOCOL_VERSION_2026);
            expect(construct).toThrow('allowDraftVersions');
        });

        it('constructs when a draft version is listed and allowDraftVersions is true', () => {
            const client = new Client(
                { name: 'test-client', version: '1.0.0' },
                {
                    supportedProtocolVersions: [LATEST_PROTOCOL_VERSION, DRAFT_PROTOCOL_VERSION_2026],
                    allowDraftVersions: true
                }
            );

            expect(client).toBeInstanceOf(Client);
        });
    });
});
