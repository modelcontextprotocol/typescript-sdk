import * as z from 'zod/v4';

import type { Client } from './client.js';
import type { ClientVersionRouterOptions, McpEra } from './clientVersionRouter.js';
import { ClientVersionRouter } from './clientVersionRouter.js';

/**
 * Permissive schema for the `server/discover` response.
 * We accept any object and extract the fields we care about.
 */
const DiscoverResultSchema = z.object({
    capabilities: z.record(z.string(), z.unknown()).optional().default({}),
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
 * HTTP-specific client version router.
 *
 * Probes the server by sending `server/discover` (a 2026-06-30 method).
 * If the server responds successfully, the connection is treated as modern.
 * On any probe error (400, UnsupportedProtocolVersionError, -32601, etc.),
 * the connection falls back to legacy and the standard `initialize` handshake
 * is performed by the base class.
 *
 * This is more permissive than {@linkcode StdioClientVersionRouter}: HTTP can
 * return many different error shapes (HTTP-level 4xx, JSON-RPC errors, transport
 * errors), so any failure during the probe is treated as a signal that the
 * server does not support the modern protocol.
 */
export class HttpClientVersionRouter extends ClientVersionRouter {
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
                capabilities: result.capabilities as Record<string, unknown>,
                serverInfo: result.serverInfo,
                instructions: result.instructions
            });

            return 'modern';
        } catch {
            // Any error during probe → fall back to legacy.
            // HTTP transports can return 400, UnsupportedProtocolVersionError,
            // -32601 (Method not found), transport errors, etc. — all of these
            // mean the server does not support the modern protocol era.
            return 'legacy';
        }
    }
}
