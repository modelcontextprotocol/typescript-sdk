import type { ClientOptions } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/client';
import type { Implementation } from '@modelcontextprotocol/core';
import { STATEFUL_PROTOCOL_VERSIONS, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/core';

/**
 * A {@linkcode Client} that only advertises pre-2026 protocol versions, so
 * `connect()` skips the `server/discover` probe and goes straight to legacy
 * `initialize`. Use in tests that exercise the connection-model
 * (server-to-client RPCs via `Protocol`, `oninitialized`, in-band logging).
 */
export class LegacyTestClient extends Client {
    constructor(clientInfo: Implementation, options?: ClientOptions) {
        super(clientInfo, {
            ...options,
            supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS.filter(v => STATEFUL_PROTOCOL_VERSIONS.includes(v))
        });
    }
}
