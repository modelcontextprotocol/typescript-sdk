/**
 * MCP Streamable HTTP server with an EXTERNAL OAuth Authorization Server.
 *
 * Demonstrates the production pattern from the MCP authorization spec where
 * the MCP server is a pure OAuth 2.0 *resource server* and a separate
 * Authorization Server (Auth0, Okta, Keycloak, Entra ID, AWS Cognito, your
 * in-house IdP, ...) mints the access tokens. The MCP server does **not**
 * know how to issue tokens — it validates incoming bearer tokens against the
 * AS's published JWKS, checks the audience (RFC 8707 resource indicator) and
 * scopes, and serves the resource.
 *
 * Contrast with `simpleStreamableHttp.ts --oauth`, which co-locates an AS and
 * the resource server in the same process for demos.
 *
 * Configure via environment variables:
 *   MCP_JWKS_URL          (required) e.g. https://<tenant>.auth0.com/.well-known/jwks.json
 *   MCP_ISSUER            (required) e.g. https://<tenant>.auth0.com/
 *   MCP_AUDIENCE          (required) the resource indicator the AS binds to tokens (RFC 8707).
 *                                    Typically the canonical MCP server URL.
 *   MCP_AUTHORIZATION_SERVERS (optional, comma-separated) advertised in the
 *                                    Protected Resource Metadata document
 *                                    (RFC 9728). Defaults to MCP_ISSUER.
 *   MCP_PORT              (optional, default 3000)
 *
 * Quick local sketch with Auth0:
 *   export MCP_JWKS_URL=https://example.auth0.com/.well-known/jwks.json
 *   export MCP_ISSUER=https://example.auth0.com/
 *   export MCP_AUDIENCE=http://localhost:3000/mcp
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/externalAuthStreamableHttp.ts
 *
 * Tools registered:
 *   - `whoami`  requires `mcp:read`
 *   - `echo`    requires `mcp:write`
 */

import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { AuthInfo, CallToolResult } from '@modelcontextprotocol/server';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import type { JWTPayload } from 'jose';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as z from 'zod/v4';

// --- Config -----------------------------------------------------------------

const JWKS_URL = process.env.MCP_JWKS_URL;
const ISSUER = process.env.MCP_ISSUER;
const AUDIENCE = process.env.MCP_AUDIENCE;
const AUTHORIZATION_SERVERS = (process.env.MCP_AUTHORIZATION_SERVERS ?? ISSUER ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const MCP_PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;

if (!JWKS_URL || !ISSUER || !AUDIENCE) {
    console.error('Missing required env: MCP_JWKS_URL, MCP_ISSUER, MCP_AUDIENCE.');
    console.error('See the file header comment for an example configuration.');
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}

// RFC 9728 §5.1: the metadata location for resource `https://host/mcp` is
// `https://host/.well-known/oauth-protected-resource/mcp`. We derive both the
// path served on this app and the absolute URL advertised in WWW-Authenticate
// from the configured audience so they line up with whatever the AS actually
// bound the token to.
const AUDIENCE_URL = new URL(AUDIENCE);
const METADATA_PATH = `/.well-known/oauth-protected-resource${AUDIENCE_URL.pathname === '/' ? '' : AUDIENCE_URL.pathname}`;
const RESOURCE_METADATA_URL = new URL(METADATA_PATH, AUDIENCE_URL.origin);

// --- JWKS bearer auth middleware -------------------------------------------

// `createRemoteJWKSet` caches keys and refreshes on `kid` rotation, so this is
// safe to share across requests.
const jwks = createRemoteJWKSet(new URL(JWKS_URL));

function parseScopes(payload: JWTPayload): string[] {
    // Common JWT scope claims:
    //   - `scope`  (RFC 8693): space-separated string
    //   - `scp`    (Okta/Entra): array of strings
    const raw = (payload as { scope?: unknown; scp?: unknown }).scope ?? (payload as { scp?: unknown }).scp;
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
    return [];
}

function wwwAuthHeader(error: string, description: string, requiredScopes?: string[]): string {
    const parts = [
        `Bearer error="${error}"`,
        `error_description="${description}"`,
        `resource_metadata="${RESOURCE_METADATA_URL.toString()}"`
    ];
    if (requiredScopes && requiredScopes.length > 0) parts.push(`scope="${requiredScopes.join(' ')}"`);
    return parts.join(', ');
}

/**
 * Express middleware that validates a Bearer token against the configured
 * external Authorization Server. On success, attaches an `AuthInfo` to
 * `req.auth` so the SDK threads it into `ctx.http?.authInfo` for tool
 * handlers. On failure, replies with RFC 6750 401/403 plus a
 * `WWW-Authenticate` header that points to the resource metadata.
 */
function requireBearerAuth(requiredScopes: string[] = []) {
    return async (
        req: Request & { auth?: AuthInfo },
        res: Response,
        next: NextFunction
    ): Promise<void> => {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
            res.set('WWW-Authenticate', wwwAuthHeader('invalid_token', 'Missing Bearer token', requiredScopes));
            res.status(401).json({ error: 'invalid_token', error_description: 'Missing Bearer token' });
            return;
        }
        const token = header.slice('Bearer '.length).trim();
        try {
            const { payload } = await jwtVerify(token, jwks, {
                issuer: ISSUER,
                audience: AUDIENCE
            });
            const scopes = parseScopes(payload);

            // RFC 6750 §3.1: missing scopes -> 403 insufficient_scope.
            const missing = requiredScopes.filter(s => !scopes.includes(s));
            if (missing.length > 0) {
                res.set(
                    'WWW-Authenticate',
                    wwwAuthHeader('insufficient_scope', `Missing scopes: ${missing.join(' ')}`, requiredScopes)
                );
                res.status(403).json({
                    error: 'insufficient_scope',
                    error_description: `Missing scopes: ${missing.join(' ')}`
                });
                return;
            }

            const authInfo: AuthInfo = {
                token,
                clientId: typeof payload.client_id === 'string' ? payload.client_id : (payload.azp as string | undefined) ?? '',
                scopes,
                expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
                resource: AUDIENCE_URL,
                extra: { sub: payload.sub, iss: payload.iss }
            };
            req.auth = authInfo;
            next();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Token validation failed';
            res.set('WWW-Authenticate', wwwAuthHeader('invalid_token', message, requiredScopes));
            res.status(401).json({ error: 'invalid_token', error_description: message });
        }
    };
}

// --- MCP server -------------------------------------------------------------

const getServer = () => {
    const server = new McpServer(
        { name: 'external-auth-streamable-http-server', version: '1.0.0' },
        { capabilities: { logging: {} } }
    );

    // `whoami` — gated on `mcp:read`. Reads the validated AuthInfo that the
    // SDK propagates from `req.auth` into the tool context.
    server.registerTool(
        'whoami',
        {
            title: 'Who Am I',
            description: 'Returns the authenticated subject and granted scopes (requires mcp:read).',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult> => {
            const auth = ctx.http?.authInfo;
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                sub: (auth?.extra?.sub as string | undefined) ?? null,
                                clientId: auth?.clientId ?? null,
                                scopes: auth?.scopes ?? []
                            },
                            null,
                            2
                        )
                    }
                ]
            };
        }
    );

    // `echo` — requires `mcp:write`. The tool itself re-checks the scope so
    // it stays correct even if a future maintainer wires it onto a route with
    // looser middleware.
    server.registerTool(
        'echo',
        {
            title: 'Echo',
            description: 'Echoes the supplied message back (requires mcp:write).',
            inputSchema: z.object({ message: z.string().describe('Message to echo') })
        },
        async ({ message }, ctx): Promise<CallToolResult> => {
            const scopes = ctx.http?.authInfo?.scopes ?? [];
            if (!scopes.includes('mcp:write')) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Forbidden: mcp:write scope required.' }]
                };
            }
            return { content: [{ type: 'text', text: message }] };
        }
    );

    return server;
};

// --- Express app ------------------------------------------------------------

const app = createMcpExpressApp();

// Demo CORS — restrict in production.
// WARNING: This configuration is for demo purposes only. In production, you
// should restrict origins and configure CORS yourself.
app.use(
    cors({
        exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Last-Event-Id', 'Mcp-Protocol-Version'],
        origin: '*'
    })
);

// RFC 9728 Protected Resource Metadata. Clients fetch this on a 401 to
// discover the authorization server(s) and supported scopes.
app.get(METADATA_PATH, (_req: Request, res: Response) => {
    res.json({
        resource: AUDIENCE,
        authorization_servers: AUTHORIZATION_SERVERS,
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp:read', 'mcp:write'],
        resource_documentation: 'https://modelcontextprotocol.io'
    });
});

// All `/mcp` routes require at least `mcp:read`. The `echo` tool re-checks
// `mcp:write` inline (see above) so the authorization story stays clear.
const authReadOnly = requireBearerAuth(['mcp:read']);

const transports: Record<string, NodeStreamableHTTPServerTransport> = {};

const mcpPostHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
        let transport: NodeStreamableHTTPServerTransport;
        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: sid => {
                    transports[sid] = transport;
                }
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) delete transports[sid];
            };
            const server = getServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        } else if (sessionId) {
            res.status(404).json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null });
            return;
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32_000, message: 'Bad Request: Session ID required' },
                id: null
            });
            return;
        }
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32_603, message: 'Internal server error' },
                id: null
            });
        }
    }
};

const mcpGetHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(404).send('Session not found');
        return;
    }
    await transports[sessionId].handleRequest(req, res);
};

const mcpDeleteHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(404).send('Session not found');
        return;
    }
    await transports[sessionId].handleRequest(req, res);
};

app.post('/mcp', authReadOnly, mcpPostHandler);
app.get('/mcp', authReadOnly, mcpGetHandler);
app.delete('/mcp', authReadOnly, mcpDeleteHandler);

app.listen(MCP_PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`MCP (external-auth) Streamable HTTP Server listening on port ${MCP_PORT}`);
    console.log(`  Issuer:                       ${ISSUER}`);
    console.log(`  Audience:                     ${AUDIENCE}`);
    console.log(`  JWKS:                         ${JWKS_URL}`);
    console.log(`  Protected Resource Metadata:  ${RESOURCE_METADATA_URL}`);
});

process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    for (const sid of Object.keys(transports)) {
        try {
            await transports[sid]!.close();
            delete transports[sid];
        } catch (error) {
            console.error(`Error closing transport ${sid}:`, error);
        }
    }
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
});
