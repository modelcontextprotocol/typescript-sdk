import { Client } from '@modelcontextprotocol/client';
import type { RequestOptions } from '@modelcontextprotocol/core';

/**
 * A {@linkcode Client} that skips `server/discover` and goes straight to the
 * legacy `initialize` handshake. Use in tests that exercise server-to-client
 * requests (sampling, elicitation, in-band logging), which the stateless model
 * does not support.
 *
 * Tests that want stateless mode use plain {@linkcode Client}: against a server
 * built with this SDK, {@linkcode Client.connect} discovers and negotiates
 * stateless automatically.
 */
export class LegacyTestClient extends Client {
    protected override async _negotiate(options?: RequestOptions): Promise<void> {
        await this._initialize(options);
        this._setIsStateless(false);
    }
}
