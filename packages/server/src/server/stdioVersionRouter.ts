import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { isJSONRPCRequest } from '@modelcontextprotocol/core';

import type { McpServer } from './mcp.js';
import type { McpEra, TransportMeta, VersionRouterOptions } from './versionRouter.js';
import { McpVersionRouter } from './versionRouter.js';

export class StdioVersionRouter extends McpVersionRouter {
    private _connectionEra: McpEra | undefined;

    constructor(mcpServer: McpServer, options?: VersionRouterOptions) {
        super(mcpServer, options);
    }

    classify(message: JSONRPCMessage, _meta?: TransportMeta): McpEra {
        if (this._connectionEra) {
            return this._connectionEra;
        }

        if (isJSONRPCRequest(message)) {
            if (message.method === 'initialize') {
                this._connectionEra = 'legacy';
                return 'legacy';
            }

            if (message.method === 'server/discover') {
                this._connectionEra = 'modern';
                return 'modern';
            }

            if (message.params?._meta?.clientCapabilities) {
                this._connectionEra = 'modern';
                return 'modern';
            }
        }

        this._connectionEra = 'modern';
        return 'modern';
    }
}
