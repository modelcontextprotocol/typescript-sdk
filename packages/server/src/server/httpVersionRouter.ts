import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { isJSONRPCRequest } from '@modelcontextprotocol/core';

import type { McpServer } from './mcp.js';
import type { McpEra, TransportMeta, VersionRouterOptions } from './versionRouter.js';
import { McpVersionRouter } from './versionRouter.js';

export class HttpVersionRouter extends McpVersionRouter {
    constructor(mcpServer: McpServer, options?: VersionRouterOptions) {
        super(mcpServer, options);
    }

    classify(message: JSONRPCMessage, meta?: TransportMeta): McpEra {
        // server/discover is always modern
        if (isJSONRPCRequest(message) && message.method === 'server/discover') {
            return 'modern';
        }

        // Mcp-Method header is the definitive HTTP discriminator (SEP-2243).
        if (meta?.httpHeaders?.['mcp-method']) {
            return 'modern';
        }

        return 'legacy';
    }
}
