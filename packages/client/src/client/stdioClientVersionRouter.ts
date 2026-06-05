import { ProtocolError, ProtocolErrorCode, ServerCapabilitiesSchema } from '@modelcontextprotocol/core';
import * as z from 'zod/v4';

import type { Client } from './client.js';
import type { ClientVersionRouterOptions, McpEra } from './clientVersionRouter.js';
import { ClientVersionRouter } from './clientVersionRouter.js';

/**
 * Permissive schema for the `server/discover` response.
 * We validate capabilities with the standard ServerCapabilitiesSchema, and
 * accept any object shape for the remaining fields we care about.
 */
const DiscoverResultSchema = z.object({
    capabilities: ServerCapabilitiesSchema.optional().default({}),
    serverInfo: z
        .object({
            name: z.string(),
            version: z.string()
        })
        .optional()
        .default({ name: 'unknown', version: '0.0.0' }),
    supportedVersions: z.array(z.string()).optional(),
    instructions: z.string().optional()
});

/**
 * Stdio-specific client version router.
 *
 * Probes the server by sending `server/discover` (a 2026-06-30 method).
 * If the server responds successfully, the connection is treated as modern.
 * If the server returns JSON-RPC -32601 (Method not found), the connection
 * falls back to legacy and the standard `initialize` handshake is performed
 * by the base class.
 */
export class StdioClientVersionRouter extends ClientVersionRouter {
    constructor(client: Client, options?: ClientVersionRouterOptions) {
        super(client, options);
    }

    protected async probe(): Promise<McpEra> {
        try {
            // Send server/discover — a custom (non-spec) method, so we pass the result schema explicitly.
            const result = await this.client.request(
                {
                    method: 'server/discover',
                    params: {
                        _meta: { protocolVersion: '2026-06-30' }
                    }
                },
                DiscoverResultSchema
            );

            // Store server info obtained from the discover response so the client
            // has capabilities/serverInfo without a separate initialize handshake.
            this.client.setServerInfo({
                capabilities: result.capabilities,
                serverInfo: result.serverInfo,
                instructions: result.instructions
            });

            return 'modern';
        } catch (error) {
            if (error instanceof ProtocolError && error.code === ProtocolErrorCode.MethodNotFound) {
                // Server doesn't know server/discover — it's a legacy server.
                return 'legacy';
            }
            throw error;
        }
    }
}
