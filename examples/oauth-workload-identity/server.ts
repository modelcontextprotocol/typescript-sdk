/**
 * Workload Identity Federation (SEP-1933) over the RFC 7523 **`jwt-bearer`**
 * grant: a workload swaps a platform-issued JWT for an MCP access token, with
 * no client secret and no browser anywhere in the flow.
 *
 * One process plays three roles, two of them listening on adjacent ports:
 *
 *  - a **workload issuer** (no listener): an ES256 keypair minted at startup,
 *    standing in for a Kubernetes API server or a SPIFFE server. It writes one
 *    short-lived workload JWT to a file, the way the kubelet projects a service
 *    account token into a pod.
 *  - `:PORT+1` - a minimal **Authorization Server** that implements the
 *    `urn:ietf:params:oauth:grant-type:jwt-bearer` grant only. It verifies the
 *    assertion against the workload issuer's key, checks the issuer, subject and
 *    audience, then mints an opaque access token. `@mcp-examples/shared`'s AS
 *    helper is `client_credentials`-only, so this story ships its own token
 *    endpoint.
 *  - `:PORT` - the MCP **Resource Server**: `createMcpHandler` behind
 *    `requireBearerAuth`, advertising the AS via `mcpAuthMetadataRouter`
 *    (RFC 9728 Protected Resource Metadata + RFC 8414 AS metadata).
 *
 * DEMO ONLY - NOT FOR PRODUCTION. A real AS fetches the workload issuer's JWKS
 * (`jose.createRemoteJWKSet`) instead of holding its public key in-process, and a
 * real workload reads its assertion from a projected volume or a SPIFFE Workload
 * API socket instead of a temp file this process wrote.
 */
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseExampleArgs } from '@mcp-examples/shared';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo, OAuthMetadata } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import cors from 'cors';
import express from 'express';
import * as jose from 'jose';
import * as z from 'zod/v4';

const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

const { port } = parseExampleArgs();
const AUTH_PORT = port + 1;
// 127.0.0.1 (not `localhost`) so the PRM `resource` value matches the URL the
// runner passes the client byte-for-byte - the SDK auth driver enforces that.
const mcpServerUrl = new URL(`http://127.0.0.1:${port}/mcp`);
const authServerUrl = new URL(`http://127.0.0.1:${AUTH_PORT}/`);
// RFC 8414 issuer identifier: the AS base URL with no trailing slash. This is
// also the audience the workload assertion must carry.
const issuer = authServerUrl.href.replace(/\/$/, '');

// The workload identity the AS trusts, and the client_id it is federated to.
const WORKLOAD_ISSUER = 'https://workload-issuer.example';
const WORKLOAD_SUBJECT = 'spiffe://demo.example/mcp-workload';
const DEMO_CLIENT_ID = 'demo-workload';

// ---- Workload issuer: mint the projected token ----
const { privateKey, publicKey } = await jose.generateKeyPair('ES256');
const workloadJwt = await new jose.SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(WORKLOAD_ISSUER)
    .setSubject(WORKLOAD_SUBJECT)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomUUID())
    .sign(privateKey);

// Both halves derive the same path from the MCP port, so the client needs no
// out-of-band handshake. In a pod this path is the projected-volume mount point
// (`/var/run/secrets/tokens/...`); `WIF_WORKLOAD_TOKEN_PATH` overrides it.
const tokenPath = process.env.WIF_WORKLOAD_TOKEN_PATH ?? path.join(tmpdir(), `mcp-wif-workload-token-${port}.jwt`);
// `wx` (O_CREAT | O_EXCL) refuses to follow a pre-planted symlink at this
// well-known path and fails closed if anything reappears between rm and open.
rmSync(tokenPath, { force: true });
writeFileSync(tokenPath, workloadJwt, { mode: 0o600, flag: 'wx' });

// ---- Authorization Server (jwt-bearer only) ----
const metadata: OAuthMetadata = {
    issuer,
    token_endpoint: `${issuer}/token`,
    // Required by the RFC 8414 schema even though this AS has no interactive leg.
    authorization_endpoint: `${issuer}/authorize`,
    response_types_supported: [],
    grant_types_supported: [JWT_BEARER_GRANT],
    // The workload authenticates with the assertion itself, so there is no
    // separate client credential to present at the token endpoint.
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp:tools']
};

/** Access tokens this AS has issued, keyed by token value. */
const issuedTokens = new Map<string, AuthInfo>();

const asApp = express();
asApp.use(cors());
asApp.use(express.urlencoded({ extended: false }));

asApp.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json(metadata);
});

asApp.post('/token', async (req, res) => {
    const body = req.body as Record<string, string>;
    if (body.grant_type !== JWT_BEARER_GRANT) {
        res.status(400).json({ error: 'unsupported_grant_type' });
        return;
    }
    if (!body.assertion) {
        res.status(400).json({ error: 'invalid_request' });
        return;
    }
    try {
        // RFC 7523 section 3: the assertion must name this AS as its audience
        // and come from an issuer the AS trusts for the subject it claims.
        // Accept the issuer identifier with or without its trailing slash so a
        // workload that appended one still federates.
        await jose.jwtVerify(body.assertion, publicKey, {
            // Pin the algorithm so a caller cannot pick the verification algorithm for us.
            algorithms: ['ES256'],
            issuer: WORKLOAD_ISSUER,
            subject: WORKLOAD_SUBJECT,
            audience: [issuer, `${issuer}/`],
            clockTolerance: 5
        });
    } catch (error) {
        console.error(`[auth-server] assertion rejected: ${(error as Error).message}`);
        res.status(400).json({ error: 'invalid_grant' });
        return;
    }
    // Bind the issued identity to the verified workload, not to request
    // parameters: federation policy decides what this subject may act as. A
    // request may omit client_id entirely (the assertion is the credential),
    // but it must not claim a different one.
    if (body.client_id !== undefined && body.client_id !== DEMO_CLIENT_ID) {
        console.error(`[auth-server] client_id ${body.client_id} is not federated to ${WORKLOAD_SUBJECT}`);
        res.status(400).json({ error: 'invalid_grant' });
        return;
    }
    const scopes = (body.scope ?? '').split(' ').filter(Boolean);
    if (!scopes.every(scope => metadata.scopes_supported!.includes(scope))) {
        res.status(400).json({ error: 'invalid_scope' });
        return;
    }
    const accessToken = randomUUID();
    const expiresIn = 300;
    issuedTokens.set(accessToken, {
        token: accessToken,
        clientId: DEMO_CLIENT_ID,
        scopes,
        expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
        extra: { workloadSubject: WORKLOAD_SUBJECT }
    });
    console.error(`[auth-server] federated ${WORKLOAD_SUBJECT} to an access token for ${scopes.join(' ') || '(no scopes)'}`);
    res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, scope: scopes.join(' ') });
});

asApp.listen(AUTH_PORT, '127.0.0.1', () => console.error(`[auth-server] jwt-bearer AS on ${authServerUrl.href}`));

// ---- Resource Server (MCP) ----
const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
        const info = issuedTokens.get(token);
        if (!info) throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
        // Model expiry explicitly even in the demo so copy-paste users don't ship a fail-open verifier.
        if (info.expiresAt !== undefined && Math.floor(Date.now() / 1000) >= info.expiresAt) {
            issuedTokens.delete(token);
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'token expired');
        }
        return info;
    }
};

const handler = createMcpHandler(ctx => {
    const server = new McpServer({ name: 'oauth-workload-identity-example', version: '1.0.0' });
    server.registerTool(
        'whoami',
        { description: 'Returns the federated workload identity and its granted scopes.', inputSchema: z.object({}) },
        async () => ({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        clientId: ctx.authInfo?.clientId,
                        scopes: ctx.authInfo?.scopes,
                        workloadSubject: ctx.authInfo?.extra?.workloadSubject
                    })
                }
            ]
        })
    );
    return server;
});

const app = createMcpExpressApp();
app.use(
    mcpAuthMetadataRouter({
        oauthMetadata: metadata,
        resourceServerUrl: mcpServerUrl,
        scopesSupported: ['mcp:tools'],
        resourceName: 'oauth-workload-identity example'
    })
);
const auth = requireBearerAuth({
    verifier,
    requiredScopes: ['mcp:tools'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
});
// `requireBearerAuth` sets `req.auth`; `toNodeHandler` reads it and passes it
// to the factory as `ctx.authInfo`.
const node = toNodeHandler(handler);
app.all('/mcp', auth, (req, res) => void node(req, res, req.body));

app.listen(port, '127.0.0.1', () => {
    console.error(`[resource-server] MCP on ${mcpServerUrl.href}`);
    console.error(`[workload-issuer] projected token at ${tokenPath}`);
});
