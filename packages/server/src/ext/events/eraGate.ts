import type { ServerContext } from '@modelcontextprotocol/core-internal';
import { isModernProtocolVersion, PROTOCOL_VERSION_META_KEY, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core-internal';

// Events is served only on 2026-07-28 and later: a request without a modern envelope gets -32601.
export function assertModernRequest(ctx: ServerContext): void {
    if (!isModernProtocolVersion(ctx.mcpReq.envelope?.[PROTOCOL_VERSION_META_KEY] ?? '')) {
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Method not found');
    }
}
