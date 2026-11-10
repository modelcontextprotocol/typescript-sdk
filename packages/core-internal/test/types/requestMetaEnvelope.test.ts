import { describe, expectTypeOf, it } from 'vitest';

import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    LOG_LEVEL_META_KEY,
    PROTOCOL_VERSION_META_KEY
} from '../../src/types/constants';
import type { ClientCapabilities, Implementation, LoggingLevel, RequestMetaEnvelope } from '../../src/types/types';

describe('RequestMetaEnvelope', () => {
    it('is keyed by the public meta-key constants', () => {
        expectTypeOf<keyof RequestMetaEnvelope>().toEqualTypeOf<
            typeof PROTOCOL_VERSION_META_KEY | typeof CLIENT_INFO_META_KEY | typeof CLIENT_CAPABILITIES_META_KEY | typeof LOG_LEVEL_META_KEY
        >();
        expectTypeOf<RequestMetaEnvelope[typeof PROTOCOL_VERSION_META_KEY]>().toEqualTypeOf<string>();
        expectTypeOf<RequestMetaEnvelope[typeof CLIENT_INFO_META_KEY]>().toEqualTypeOf<Implementation | undefined>();
        expectTypeOf<RequestMetaEnvelope[typeof CLIENT_CAPABILITIES_META_KEY]>().toEqualTypeOf<ClientCapabilities>();
        expectTypeOf<RequestMetaEnvelope[typeof LOG_LEVEL_META_KEY]>().toEqualTypeOf<LoggingLevel | undefined>();
    });
});
