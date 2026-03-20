#!/usr/bin/env node

/**
 * Example demonstrating the minimal AuthProvider for bearer token authentication.
 *
 * AuthProvider is the base interface for all client auth. For simple cases where
 * tokens are managed externally — pre-configured API tokens, gateway/proxy patterns,
 * or tokens obtained through a separate auth flow — implement only `token()`.
 *
 * For OAuth flows (client_credentials, private_key_jwt, etc.), use the built-in
 * providers which implement both `token()` and `onUnauthorized()`.
 *
 * Environment variables:
 *   MCP_SERVER_URL - Server URL (default: http://localhost:3000/mcp)
 *   MCP_TOKEN      - Bearer token to use for authentication (required)
 */

import type { AuthProvider } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const DEFAULT_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp';

async function main() {
    const token = process.env.MCP_TOKEN;
    if (!token) {
        console.error('MCP_TOKEN environment variable is required');
        process.exit(1);
    }

    // AuthProvider with just token() — the simplest possible auth.
    // token() is called before every request, so it can handle refresh internally.
    // With no onUnauthorized(), a 401 throws UnauthorizedError immediately.
    const authProvider: AuthProvider = {
        token: async () => token
    };

    const client = new Client({ name: 'auth-provider-example', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(DEFAULT_SERVER_URL), { authProvider });

    await client.connect(transport);
    console.log('Connected successfully.');

    const tools = await client.listTools();
    console.log('Available tools:', tools.tools.map(t => t.name).join(', ') || '(none)');

    await transport.close();
}

try {
    await main();
} catch (error) {
    console.error('Error running client:', error);
    process.exitCode = 1;
}
