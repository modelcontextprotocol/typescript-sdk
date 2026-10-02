/**
 * Minimal OAuth 2.0 Authorization Server supporting the **`client_credentials`**
 * grant only — for the machine-to-machine MCP example.
 *
 * DEMO ONLY — NOT FOR PRODUCTION
 *
 * The full {@link setupAuthServer} (better-auth/OIDC) only supports the
 * `authorization_code` grant; this is the headless counterpart so the
 * `oauth-client-credentials/` example can be fully self-verifying without a
 * browser.
 *
 * Exposes RFC 8414 metadata at `/.well-known/oauth-authorization-server` and a
 * `/token` endpoint that accepts `client_secret_basic` or `client_secret_post`
 * authentication. Issued access tokens are random opaque strings tracked in an
 * in-memory map and validated by {@link clientCredentialsTokenVerifier}.
 */

import { randomBytes } from 'node:crypto';

import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import type { AuthInfo, OAuthMetadata } from '@modelcontextprotocol/server';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import cors from 'cors';
import express from 'express';

export interface RegisteredClient {
    clientId: string;
    clientSecret: string;
    /** Scopes the AS is willing to grant this client (defaults to whatever it asks for). */
    allowedScopes?: string[];
}

export interface ClientCredentialsAuthServerOptions {
    /** Public base URL of this AS (issuer). */
    authServerUrl: URL;
    /** Pre-registered confidential clients. */
    clients: RegisteredClient[];
}

export interface ClientCredentialsAuthServer {
    app: express.Application;
    metadata: OAuthMetadata;
    /** Pass to `requireBearerAuth({ verifier })` on the Resource Server. */
    verifier: OAuthTokenVerifier;
}

/** Tokens issued by the most-recently-created `client_credentials` AS. */
const issuedTokens = new Map<string, AuthInfo>();

/**
 * Builds (but does not `listen()`) a minimal `client_credentials`-only
 * Authorization Server. The caller mounts `app` on the port matching
 * `authServerUrl`.
 */
export function createClientCredentialsAuthServer(options: ClientCredentialsAuthServerOptions): ClientCredentialsAuthServer {
    const { authServerUrl, clients } = options;
    const issuer = authServerUrl.href.replace(/\/$/, '');
    const clientById = new Map(clients.map(c => [c.clientId, c]));

    const metadata: OAuthMetadata = {
        issuer,
        token_endpoint: `${issuer}/token`,
        // Required by the RFC 8414 schema even though this AS doesn't implement the endpoint.
        authorization_endpoint: `${issuer}/authorize`,
        response_types_supported: [],
        grant_types_supported: ['client_credentials'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['mcp:tools', 'mcp:read']
    };

    const app = express();
    app.use(cors());
    app.use(express.urlencoded({ extended: false }));

    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
        res.json(metadata);
    });

    app.post('/token', (req, res) => {
        const body = req.body as Record<string, string>;
        if (body.grant_type !== 'client_credentials') {
            res.status(400).json({ error: 'unsupported_grant_type' });
            return;
        }
        // RFC 6749 §2.3.1 — try Basic, then body.
        let id: string | undefined;
        let secret: string | undefined;
        const authz = req.header('authorization');
        if (authz?.startsWith('Basic ')) {
            const decoded = Buffer.from(authz.slice(6), 'base64').toString('utf8');
            const sep = decoded.indexOf(':');
            id = decodeURIComponent(decoded.slice(0, sep));
            secret = decodeURIComponent(decoded.slice(sep + 1));
        } else {
            id = body.client_id;
            secret = body.client_secret;
        }
        const client = id ? clientById.get(id) : undefined;
        if (!client || client.clientSecret !== secret) {
            res.status(401).set('WWW-Authenticate', 'Basic realm="oauth"').json({ error: 'invalid_client' });
            return;
        }
        const requested = (body.scope ?? '').split(' ').filter(Boolean);
        const granted = client.allowedScopes ? requested.filter(s => client.allowedScopes!.includes(s)) : requested;
        const accessToken = randomBytes(24).toString('base64url');
        const expiresIn = 3600;
        issuedTokens.set(accessToken, {
            token: accessToken,
            clientId: client.clientId,
            scopes: granted,
            expiresAt: Math.floor(Date.now() / 1000) + expiresIn
        });
        res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, scope: granted.join(' ') });
    });

    return { app, metadata, verifier: clientCredentialsTokenVerifier };
}

/**
 * `OAuthTokenVerifier` that validates Bearer tokens against the in-memory
 * issued-tokens map of {@link createClientCredentialsAuthServer}.
 */
export const clientCredentialsTokenVerifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
        const info = issuedTokens.get(token);
        if (!info) throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
        // Model expiry explicitly even in the demo so copy-paste users don't ship a fail-open verifier.
        // `requireBearerAuth` also independently rejects when `AuthInfo.expiresAt` is in the past.
        if (info.expiresAt !== undefined && Math.floor(Date.now() / 1000) >= info.expiresAt) {
            issuedTokens.delete(token);
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'token expired');
        }
        return info;
    }
};
