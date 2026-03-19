#!/usr/bin/env node

/**
 * Example demonstrating TokenProvider for simple bearer token authentication.
 *
 * TokenProvider is a lightweight alternative to OAuthClientProvider for cases
 * where tokens are managed externally — e.g., pre-configured API tokens,
 * gateway/proxy patterns, or tokens obtained through a separate auth flow.
 *
 * Environment variables:
 *   MCP_SERVER_URL - Server URL (default: http://localhost:3000/mcp)
 *   MCP_TOKEN      - Bearer token to use for authentication (required)
 *
 * Two approaches are demonstrated:
 *   1. Using `tokenProvider` option on the transport (simplest)
 *   2. Using `withBearerAuth` to wrap a custom fetch function (more flexible)
 */

import type { TokenProvider } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport, withBearerAuth } from '@modelcontextprotocol/client';

const DEFAULT_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp';

async function main() {
    const token = process.env.MCP_TOKEN;
    if (!token) {
        console.error('MCP_TOKEN environment variable is required');
        process.exit(1);
    }

    // A TokenProvider is just an async function that returns a token string.
    // It is called before every request, so it can handle refresh logic internally.
    const tokenProvider: TokenProvider = async () => token;

    const client = new Client({ name: 'token-provider-example', version: '1.0.0' }, { capabilities: {} });

    // Approach 1: Pass tokenProvider directly to the transport.
    // This is the simplest way to add bearer auth.
    const transport = new StreamableHTTPClientTransport(new URL(DEFAULT_SERVER_URL), {
        tokenProvider
    });

    // Approach 2 (alternative): Use withBearerAuth to wrap fetch.
    // This is useful when you need more control over the fetch behavior,
    // or when composing with other fetch wrappers.
    //
    // const transport = new StreamableHTTPClientTransport(new URL(DEFAULT_SERVER_URL), {
    //     fetch: withBearerAuth(tokenProvider),
    // });

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
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}

// Referenced in the commented-out Approach 2 above; kept so uncommenting it type-checks.
void withBearerAuth;
