import { Client } from '@modelcontextprotocol/client';
import type { RequestOptions } from '@modelcontextprotocol/core';

/**
 * A {@linkcode Client} that skips `server/discover` and goes straight to the
 * legacy `initialize` handshake. Used by conformance scenarios that drive an
 * old-spec reference server.
 */
export class LegacyTestClient extends Client {
    protected override async _negotiate(options?: RequestOptions): Promise<void> {
        await this._initialize(options);
        this._setIsStateless(false);
    }
}
