#!/usr/bin/env node

/**
 * MCP Client for External Auth Server Example
 *
 * DEMO ONLY - NOT FOR PRODUCTION
 *
 * Connects to an MCP server that uses an external OAuth2 authorization server.
 * Demonstrates the full OAuth flow:
 *
 * 1. Client connects to MCP server, receives 401 with resource metadata URL
 * 2. Client fetches protected resource metadata to discover the external AS
 * 3. Client fetches AS metadata (/.well-known/oauth-authorization-server)
 * 4. Client dynamically registers with the AS
 * 5. Client redirects user to AS for authorization (auto-approved in demo)
 * 6. Client exchanges authorization code for JWT access token
 * 7. Client connects to MCP server with the JWT Bearer token
 *
 * Usage:
 *   pnpm --filter @modelcontextprotocol/examples-client exec tsx src/externalAuthServerClient.ts [server-url]
 */

import { createServer } from 'node:http';

import type { CallToolResult, ListToolsRequest, OAuthClientMetadata } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import open from 'open';

import { InMemoryOAuthClientProvider } from './simpleOAuthClientProvider.js';

// --- Configuration ---

const DEFAULT_SERVER_URL = 'http://localhost:3000/mcp';
const CALLBACK_PORT = 8090;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;

// --- OAuth callback server ---

async function waitForOAuthCallback(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const server = createServer((req, res) => {
            if (req.url === '/favicon.ico') {
                res.writeHead(404);
                res.end();
                return;
            }

            const parsedUrl = new URL(req.url || '', 'http://localhost');
            const code = parsedUrl.searchParams.get('code');
            const error = parsedUrl.searchParams.get('error');

            if (code) {
                console.log(`Authorization code received: ${code.slice(0, 10)}...`);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
                    <html>
                      <body>
                        <h1>Authorization Successful!</h1>
                        <p>You can close this window and return to the terminal.</p>
                        <script>setTimeout(() => window.close(), 2000);</script>
                      </body>
                    </html>
                `);
                resolve(code);
                setTimeout(() => server.close(), 3000);
            } else if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`
                    <html>
                      <body>
                        <h1>Authorization Failed</h1>
                        <p>Error: ${error}</p>
                      </body>
                    </html>
                `);
                reject(new Error(`OAuth authorization failed: ${error}`));
            } else {
                res.writeHead(400);
                res.end('Bad request');
                reject(new Error('No authorization code provided'));
            }
        });

        server.listen(CALLBACK_PORT, () => {
            console.log(`OAuth callback server listening on http://localhost:${CALLBACK_PORT}`);
        });
    });
}

// --- Helpers ---

async function openBrowser(url: string): Promise<void> {
    console.log(`Opening browser for authorization: ${url}`);
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            console.error(`Refusing to open URL with unsupported scheme: ${url}`);
            return;
        }
        await open(url);
    } catch {
        console.log(`Please manually open: ${url}`);
    }
}

// --- Main ---

async function main(): Promise<void> {
    const serverUrl = process.argv[2] || DEFAULT_SERVER_URL;

    console.log('MCP Client with External Auth Server');
    console.log(`Connecting to: ${serverUrl}`);
    console.log();

    // Set up OAuth client metadata for dynamic registration
    const clientMetadata: OAuthClientMetadata = {
        client_name: 'MCP External Auth Client',
        redirect_uris: [CALLBACK_URL],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post'
    };

    // Create OAuth provider (handles token storage and redirect)
    const oauthProvider = new InMemoryOAuthClientProvider(CALLBACK_URL, clientMetadata, (redirectUrl: URL) => {
        openBrowser(redirectUrl.toString());
    });

    // Create MCP client
    const client = new Client({ name: 'external-auth-client', version: '1.0.0' }, { capabilities: {} });

    // Attempt connection with retry on auth challenge
    async function attemptConnection(): Promise<void> {
        const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
            authProvider: oauthProvider
        });

        try {
            console.log('Attempting connection...');
            await client.connect(transport);
            console.log('Connected successfully!');
        } catch (error) {
            if (error instanceof UnauthorizedError) {
                console.log('Authentication required. Starting OAuth flow with external AS...');
                const callbackPromise = waitForOAuthCallback();
                const authCode = await callbackPromise;
                await transport.finishAuth(authCode);
                console.log('Authorization complete. Reconnecting...');
                await attemptConnection();
            } else {
                throw error;
            }
        }
    }

    await attemptConnection();

    // List available tools
    console.log('\nListing available tools...');
    const toolsRequest: ListToolsRequest = { method: 'tools/list', params: {} };
    const toolsResult = await client.request(toolsRequest);

    if (toolsResult.tools && toolsResult.tools.length > 0) {
        console.log('Available tools:');
        for (const tool of toolsResult.tools) {
            console.log(`  - ${tool.name}: ${tool.description || '(no description)'}`);
        }
    }

    // Call the greet tool
    console.log('\nCalling greet tool...');
    const greetResult = (await client.callTool({ name: 'greet', arguments: { name: 'World' } })) as CallToolResult;
    for (const content of greetResult.content) {
        if (content.type === 'text') {
            console.log(`  Result: ${content.text}`);
        }
    }

    // Call the whoami tool
    console.log('\nCalling whoami tool...');
    const whoamiResult = (await client.callTool({ name: 'whoami', arguments: {} })) as CallToolResult;
    for (const content of whoamiResult.content) {
        if (content.type === 'text') {
            console.log(`  Result: ${content.text}`);
        }
    }

    console.log('\nDone! All authenticated calls succeeded.');
    process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
});

try {
    await main();
} catch (error) {
    console.error('Error:', error);
    process.exit(1);
}
