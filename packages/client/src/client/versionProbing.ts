import type { Transport } from '@modelcontextprotocol/core';

import type { DiscoverResult } from './modernClientImpl.js';

/**
 * A transport that detects the server's protocol version during start().
 *
 * Implemented by StreamableHTTPClientTransport (HTTP) and
 * StdioClientTransport (stdio). Used by Client to decide between
 * ModernClientImpl and LegacyClient.
 */
export interface VersionProbingTransport extends Transport {
    readonly mode: 'modern' | 'legacy';
    getDiscoverResult(): DiscoverResult | undefined;
}

export function isVersionProbingTransport(transport: Transport): transport is VersionProbingTransport {
    return (
        'mode' in transport &&
        'getDiscoverResult' in transport &&
        typeof (transport as VersionProbingTransport).getDiscoverResult === 'function'
    );
}
