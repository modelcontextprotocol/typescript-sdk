import { isModernProtocolVersion, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core-internal';

import type { Server } from '../../server/server';

// Events is served only on 2026-07-28 and later: a server bound to an earlier revision answers -32601, whatever a request's `_meta` claims.
export function assertModernServer(server: Server): void {
    if (!isModernProtocolVersion(server.getNegotiatedProtocolVersion() ?? '')) {
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Method not found');
    }
}
