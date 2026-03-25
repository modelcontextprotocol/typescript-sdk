#!/usr/bin/env node

/**
 * Two auth patterns through the same `authProvider` option.
 *
 * The transport accepts either a minimal `AuthProvider` (just `token()` +
 * optional `onUnauthorized()`) or a full `OAuthClientProvider`, adapting
 * the latter automatically. This means your connect/call code is identical
 * regardless of which pattern fits your deployment.
 *
 * HOST-MANAGED — token lives in an enclosing app
 *   The app fetches and stores tokens; the MCP client just reads them.
 *   On 401, there is nothing to refresh — signal the UI and throw so the
 *   user can re-authenticate through the host's flow.
 *
 * USER-CONFIGURED — OAuth credentials supplied directly
 *   Pass a built-in or custom OAuthClientProvider. The transport handles
 *   the full OAuth flow: token refresh on 401, or redirect for interactive
 *   authorization.
 */

import type { AuthProvider } from '@modelcontextprotocol/client';
import { Client, ClientCredentialsProvider, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';

// --- Stubs for host-app integration points ---------------------------------

/** Whatever the host app uses to store session state (e.g., cookies, keychain, in-memory). */
interface HostSessionStore {
    getMcpToken(): string | undefined;
}

/** Whatever the host app uses to surface UI prompts. */
interface HostUi {
    showReauthPrompt(message: string): void;
}

// --- MODE A: Host-managed auth ---------------------------------------------

function createHostManagedTransport(serverUrl: URL, session: HostSessionStore, ui: HostUi): StreamableHTTPClientTransport {
    const authProvider: AuthProvider = {
        // Called before every request — just read whatever the host has.
        token: async () => session.getMcpToken(),

        // Called on 401 — don't refresh (the host owns the token), signal the UI and bail.
        // The transport will retry once after this returns, so we throw to stop it:
        // the user needs to act before a retry makes sense.
        onUnauthorized: async () => {
            ui.showReauthPrompt('MCP connection lost — click to reconnect');
            throw new UnauthorizedError('Host token rejected — user action required');
        }
    };

    return new StreamableHTTPClientTransport(serverUrl, { authProvider });
}

// --- MODE B: User-configured OAuth -----------------------------------------

function createUserConfiguredTransport(serverUrl: URL, clientId: string, clientSecret: string): StreamableHTTPClientTransport {
    // Built-in OAuth provider — the transport adapts it to AuthProvider internally.
    // On 401, adaptOAuthProvider synthesizes onUnauthorized → handleOAuthUnauthorized,
    // which runs token refresh (or redirect for interactive flows).
    const authProvider = new ClientCredentialsProvider({ clientId, clientSecret });

    return new StreamableHTTPClientTransport(serverUrl, { authProvider });
}

// --- Same caller code for both modes ---------------------------------------

async function connectAndList(transport: StreamableHTTPClientTransport): Promise<void> {
    const client = new Client({ name: 'dual-mode-example', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    console.log('Tools:', tools.tools.map(t => t.name).join(', ') || '(none)');

    await transport.close();
}

// --- Driver ----------------------------------------------------------------

async function main() {
    const serverUrl = new URL(process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp');
    const mode = process.argv[2] || 'host';

    let transport: StreamableHTTPClientTransport;

    if (mode === 'host') {
        // Simulate a host app with a session-stored token and a UI hook.
        const session: HostSessionStore = { getMcpToken: () => process.env.MCP_TOKEN };
        const ui: HostUi = { showReauthPrompt: msg => console.error(`[UI] ${msg}`) };
        transport = createHostManagedTransport(serverUrl, session, ui);
    } else if (mode === 'oauth') {
        const clientId = process.env.OAUTH_CLIENT_ID;
        const clientSecret = process.env.OAUTH_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            console.error('OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET required for oauth mode');
            process.exit(1);
        }
        transport = createUserConfiguredTransport(serverUrl, clientId, clientSecret);
    } else {
        console.error(`Unknown mode: ${mode}. Use 'host' or 'oauth'.`);
        process.exit(1);
    }

    // Same connect/list code regardless of mode — the transport abstracts the difference.
    await connectAndList(transport);
}

try {
    await main();
} catch (error) {
    console.error('Error:', error);
    process.exitCode = 1;
}
