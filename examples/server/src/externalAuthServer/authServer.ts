/**
 * External OAuth2 Authorization Server
 *
 * DEMO ONLY - NOT FOR PRODUCTION
 *
 * A standalone OAuth2 authorization server that issues JWT access tokens.
 * This demonstrates the "external AS" pattern from RFC 8707 where the
 * authorization server is a separate service from the MCP resource server.
 *
 * Implements:
 * - RFC 8414: OAuth 2.0 Authorization Server Metadata
 * - RFC 7636: PKCE (Proof Key for Code Exchange)
 * - RFC 7591: Dynamic Client Registration
 * - RFC 9068: JWT Profile for OAuth 2.0 Access Tokens
 * - RFC 8707: Resource Indicators (resource parameter)
 *
 * The MCP resource server verifies tokens using the JWKS endpoint.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import cors from 'cors';
import express from 'express';
import type { JWK } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// --- Configuration ---

const AUTH_PORT = process.env.AUTH_PORT ? Number.parseInt(process.env.AUTH_PORT, 10) : 3001;
const AUTH_SERVER_URL = `http://localhost:${AUTH_PORT}`;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp';

// --- Crypto: RSA key pair for signing JWTs ---

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk: JWK = await exportJWK(publicKey);
const keyId = randomUUID();
publicJwk.kid = keyId;
publicJwk.use = 'sig';
publicJwk.alg = 'RS256';

// --- In-memory stores (demo only) ---

interface RegisteredClient {
    client_id: string;
    client_secret?: string;
    redirect_uris: string[];
    client_name?: string;
    grant_types: string[];
    response_types: string[];
    token_endpoint_auth_method: string;
}

interface AuthorizationCode {
    code: string;
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    scopes: string[];
    resource?: string;
    expiresAt: number;
}

const clients = new Map<string, RegisteredClient>();
const authorizationCodes = new Map<string, AuthorizationCode>();

// --- Express app ---

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- RFC 8414: Authorization Server Metadata ---

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
        issuer: AUTH_SERVER_URL,
        authorization_endpoint: `${AUTH_SERVER_URL}/authorize`,
        token_endpoint: `${AUTH_SERVER_URL}/token`,
        registration_endpoint: `${AUTH_SERVER_URL}/register`,
        jwks_uri: `${AUTH_SERVER_URL}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile', 'mcp:tools', 'mcp:resources']
    });
});

// --- JWKS endpoint: public keys for token verification ---

app.get('/jwks', (_req, res) => {
    res.json({
        keys: [publicJwk]
    });
});

// --- RFC 7591: Dynamic Client Registration ---

app.post('/register', (req, res) => {
    const { redirect_uris, client_name, grant_types, response_types, token_endpoint_auth_method } = req.body;

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
        return;
    }

    const clientId = randomUUID();
    const clientSecret = randomBytes(32).toString('base64url');

    const client: RegisteredClient = {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris,
        client_name: client_name || 'Unknown Client',
        grant_types: grant_types || ['authorization_code'],
        response_types: response_types || ['code'],
        token_endpoint_auth_method: token_endpoint_auth_method || 'client_secret_post'
    };

    clients.set(clientId, client);

    console.log(`[Auth] Registered client: ${clientId} (${client.client_name})`);

    res.status(201).json({
        client_id: clientId,
        client_secret: clientSecret,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: client.response_types,
        token_endpoint_auth_method: client.token_endpoint_auth_method
    });
});

// --- Authorization endpoint ---
// In a real AS, this would render a login/consent page.
// For this demo, we auto-approve and redirect with an authorization code.

app.get('/authorize', (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const clientId = query.client_id;
    const redirectUri = query.redirect_uri;
    const responseType = query.response_type;
    const codeChallenge = query.code_challenge;
    const codeChallengeMethod = query.code_challenge_method;
    const scope = query.scope;
    const state = query.state;
    const resource = query.resource;

    if (responseType !== 'code') {
        res.status(400).json({ error: 'unsupported_response_type' });
        return;
    }

    if (!clientId || !redirectUri) {
        res.status(400).json({ error: 'invalid_request', error_description: 'client_id and redirect_uri are required' });
        return;
    }

    const client = clients.get(clientId);
    if (!client) {
        res.status(400).json({ error: 'invalid_client', error_description: 'Client not registered' });
        return;
    }

    if (!client.redirect_uris.includes(redirectUri)) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Invalid redirect_uri' });
        return;
    }

    // Generate authorization code
    const code = randomBytes(32).toString('base64url');
    const scopes = scope ? scope.split(' ') : ['openid'];

    authorizationCodes.set(code, {
        code,
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        scopes,
        resource, // RFC 8707: Store the requested resource
        expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
    });

    console.log(`[Auth] Issued authorization code for client ${clientId} (resource: ${resource || 'none'})`);

    // Redirect back with code
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (state) {
        redirectUrl.searchParams.set('state', state);
    }

    res.redirect(redirectUrl.toString());
});

// --- Token endpoint ---

app.post('/token', async (req, res) => {
    const { grant_type: grantType, code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier, resource } = req.body;

    if (grantType !== 'authorization_code') {
        res.status(400).json({ error: 'unsupported_grant_type' });
        return;
    }

    // Look up authorization code
    const authCode = authorizationCodes.get(code);
    if (!authCode) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
        return;
    }

    // Remove used code (one-time use)
    authorizationCodes.delete(code);

    // Validate expiration
    if (Date.now() > authCode.expiresAt) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
        return;
    }

    // Validate client
    if (authCode.clientId !== clientId) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Client ID mismatch' });
        return;
    }

    // Validate redirect_uri
    if (authCode.redirectUri !== redirectUri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' });
        return;
    }

    // Validate PKCE
    if (authCode.codeChallenge) {
        if (!codeVerifier) {
            res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
            return;
        }

        // Verify S256 challenge
        const encoder = new TextEncoder();
        const digest = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
        const computed = Buffer.from(digest).toString('base64url');

        if (computed !== authCode.codeChallenge) {
            res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
            return;
        }
    }

    // RFC 8707: Use the resource from the authorization code, or from the token request
    const targetResource = authCode.resource || resource || MCP_SERVER_URL;

    // Issue JWT access token (RFC 9068)
    const accessToken = await new SignJWT({
        scope: authCode.scopes.join(' '),
        client_id: clientId
    })
        .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'at+jwt' })
        .setIssuer(AUTH_SERVER_URL)
        .setSubject(`user-${clientId}`)
        .setAudience(targetResource) // RFC 8707: audience is the resource
        .setIssuedAt()
        .setExpirationTime('1h')
        .setJti(randomUUID())
        .sign(privateKey);

    console.log(`[Auth] Issued JWT access token for client ${clientId} (audience: ${targetResource})`);

    res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: authCode.scopes.join(' ')
    });
});

// --- Start server ---

app.listen(AUTH_PORT, () => {
    console.log(`External OAuth Authorization Server listening on port ${AUTH_PORT}`);
    console.log(`  Metadata:     ${AUTH_SERVER_URL}/.well-known/oauth-authorization-server`);
    console.log(`  JWKS:         ${AUTH_SERVER_URL}/jwks`);
    console.log(`  Authorize:    ${AUTH_SERVER_URL}/authorize`);
    console.log(`  Token:        ${AUTH_SERVER_URL}/token`);
    console.log(`  Register:     ${AUTH_SERVER_URL}/register`);
    console.log(`  MCP Resource: ${MCP_SERVER_URL}`);
    console.log();
    console.log('NOTE: This server auto-approves all authorization requests (demo only).');
});
