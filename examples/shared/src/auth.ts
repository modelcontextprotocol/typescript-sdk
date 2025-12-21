/**
 * Better Auth configuration for MCP demo servers
 *
 * DEMO ONLY - NOT FOR PRODUCTION
 *
 * This configuration uses in-memory SQLite and auto-approves all logins.
 * For production use, configure a proper database and authentication flow.
 */

import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
import Database from 'better-sqlite3';

// Create the in-memory database once (module-level singleton)
// This avoids the type export issue and ensures the same DB is used
let _db: InstanceType<typeof Database> | null = null;

function getDatabase(): InstanceType<typeof Database> {
    if (!_db) {
        _db = new Database(':memory:');
    }
    return _db;
}

export interface CreateDemoAuthOptions {
    baseURL: string;
    resource?: string;
    loginPage?: string;
}

/**
 * Creates a better-auth instance configured for MCP OAuth demo.
 *
 * @param options - Configuration options
 * @param options.baseURL - The base URL for the auth server (e.g., http://localhost:3001)
 * @param options.resource - The MCP resource server URL (for protected resource metadata)
 * @param options.loginPage - Path to login page (defaults to /sign-in)
 *
 * @see https://www.better-auth.com/docs/plugins/mcp
 */
export function createDemoAuth(options: CreateDemoAuthOptions) {
    const { baseURL, resource, loginPage = '/sign-in' } = options;

    // Use in-memory SQLite database for demo purposes
    // Note: All data is lost on restart - demo only!
    const db = getDatabase();

    // MCP plugin configuration
    const mcpPlugin = mcp({
        loginPage,
        resource,
        oidcConfig: {
            loginPage,
            codeExpiresIn: 600, // 10 minutes
            accessTokenExpiresIn: 3600, // 1 hour
            refreshTokenExpiresIn: 604800, // 7 days
            defaultScope: 'openid',
            scopes: ['openid', 'profile', 'email', 'offline_access', 'mcp:tools']
        }
    });

    return betterAuth({
        baseURL,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        database: db as any, // Type cast to avoid exposing better-sqlite3 in exported types
        trustedOrigins: ['*'],
        // Basic email+password for demo
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: false
        },
        plugins: [mcpPlugin]
    });
}

/**
 * Type for the auth instance returned by createDemoAuth.
 * Note: Due to plugin type inference complexity, we use a generic type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DemoAuth = ReturnType<typeof createDemoAuth>;
