/**
 * Per-tool scoped Resource Server on `createMcpHandler`, plus a minimal
 * in-process Authorization Server that issues tokens carrying whatever scope
 * the client requested.
 *
 * One process, two listeners on adjacent ports:
 *  - `:PORT+1` — minimal AS: PRM/AS metadata, DCR, an `/authorize` endpoint
 *    that immediately 302s back to `redirect_uri?code=...` (the headless
 *    "auto-consent"), and a `/token` endpoint that issues a Bearer token whose
 *    granted scope mirrors the requested scope.
 *  - `:PORT` — MCP RS: `createMcpHandler` behind a bearer-verify gate (401 on
 *    missing/invalid token). Per-tool scope is enforced **inside each tool
 *    handler** via `ctx.http?.authInfo?.scopes` — the handler is the only
 *    place that authoritatively knows which tool is executing, so the scope
 *    decision lives next to the code it guards. An under-scoped call returns a
 *    tool-result `{ isError: true }` rather than an HTTP 403.
 *
 * DEMO ONLY — NOT FOR PRODUCTION. The AS auto-approves and issues whatever
 * scope is asked for; tokens are validated in-process against the same AS.
 *
 * HTTP-only by definition (the OAuth dance is HTTP redirects + Bearer headers),
 * so the canonical stdio branch does not apply.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const { port } = parseExampleArgs();
const AS_PORT = port + 1;
const MCP_URL = `http://127.0.0.1:${port}/mcp`;
const AS_ISSUER = `http://127.0.0.1:${AS_PORT}`;

// ---------------------------------------------------------------------------
// Minimal Authorization Server (DEMO ONLY)
// ---------------------------------------------------------------------------
/** code → requested scope (single-use). */
const pendingCodes = new Map<string, string>();
/** access token → granted scope. */
const issuedTokens = new Map<string, string>();
/** client_id → redirect_uris registered via DCR — `/authorize` MUST validate against this. */
const registeredRedirectUris = new Map<string, readonly string[]>();

/**
 * The demo AS only accepts loopback redirect URIs at registration time, so an
 * unauthenticated DCR cannot register an external host and then have `/authorize`
 * exfiltrate authorization codes to it. RFC 8252 §7.3 permits `http:` for loopback.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function isAllowedRedirectUri(raw: unknown): raw is string {
    if (typeof raw !== 'string') return false;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return false;
    }
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && LOOPBACK_HOSTS.has(parsed.hostname);
}

const asServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', AS_ISSUER);
    const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(200, { resource: MCP_URL, authorization_servers: [AS_ISSUER], scopes_supported: ['files:read', 'files:write'] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
        return json(200, {
            issuer: AS_ISSUER,
            authorization_endpoint: `${AS_ISSUER}/authorize`,
            token_endpoint: `${AS_ISSUER}/token`,
            registration_endpoint: `${AS_ISSUER}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code'],
            token_endpoint_auth_methods_supported: ['none']
        });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
        let body = '';
        req.on('data', c => (body += String(c)));
        req.on('end', () => {
            // RFC 7591: echo the submitted metadata plus issued credentials.
            const submitted = JSON.parse(body || '{}') as { redirect_uris?: unknown };
            const submittedUris = Array.isArray(submitted.redirect_uris) ? submitted.redirect_uris : [];
            if (submittedUris.length === 0 || !submittedUris.every(u => isAllowedRedirectUri(u))) {
                return json(400, {
                    error: 'invalid_redirect_uri',
                    error_description: 'this demo authorization server only accepts loopback redirect URIs'
                });
            }
            const clientId = `demo-${randomUUID().slice(0, 8)}`;
            registeredRedirectUris.set(clientId, submittedUris);
            json(201, { ...submitted, client_id: clientId, token_endpoint_auth_method: 'none' });
        });
        return;
    }
    if (url.pathname === '/authorize') {
        // DEMO ONLY: auto-consent. A real AS would show a login + consent UI here.
        // The redirect_uri MUST exactly match one registered for this client_id —
        // never redirect to an unregistered URI (open-redirect → authorization-code leakage).
        const clientId = url.searchParams.get('client_id') ?? '';
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const registered = registeredRedirectUris.get(clientId);
        if (!registered || !registered.includes(redirectUri)) {
            return json(400, { error: 'invalid_request', error_description: 'redirect_uri not registered for client_id' });
        }
        const code = randomUUID();
        pendingCodes.set(code, url.searchParams.get('scope') ?? '');
        const redirect = new URL(redirectUri);
        redirect.searchParams.set('code', code);
        const state = url.searchParams.get('state');
        if (state) redirect.searchParams.set('state', state);
        res.writeHead(302, { location: redirect.href }).end();
        return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', c => (body += String(c)));
        req.on('end', () => {
            const params = new URLSearchParams(body);
            const code = params.get('code') ?? '';
            const scope = pendingCodes.get(code);
            if (scope === undefined) return json(400, { error: 'invalid_grant' });
            pendingCodes.delete(code);
            const token = randomUUID();
            issuedTokens.set(token, scope);
            json(200, { access_token: token, token_type: 'Bearer', scope, expires_in: 3600 });
        });
        return;
    }
    json(404, { error: 'not_found' });
});
asServer.listen(AS_PORT, '127.0.0.1', () => console.error(`[server] demo AS listening on ${AS_ISSUER}`));

// ---------------------------------------------------------------------------
// Resource Server (MCP) — bearer-verify at the gate, per-tool scope in handlers
// ---------------------------------------------------------------------------
function verifyBearer(header: string | null): AuthInfo | undefined {
    if (!header?.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length);
    const scope = issuedTokens.get(token);
    if (scope === undefined) return undefined;
    return { token, clientId: 'scoped-tools-demo', scopes: scope.split(' ').filter(Boolean) };
}

/**
 * Per-tool scope guard. The scope decision lives with the tool handler — the
 * only place that authoritatively knows which tool is executing — rather than
 * in HTTP middleware that would have to re-derive the operation from the
 * request body. An under-scoped call returns a tool-level `isError` result.
 */
function requireScope(
    authInfo: AuthInfo | undefined,
    scope: string
): { isError: true; content: [{ type: 'text'; text: string }] } | undefined {
    if (authInfo?.scopes.includes(scope)) return undefined;
    return { isError: true, content: [{ type: 'text', text: `insufficient_scope: requires ${scope}` }] };
}

function buildServer(): McpServer {
    const server = new McpServer({ name: 'scoped-tools', version: '1.0.0' });
    server.registerTool('list-files', { description: 'Requires files:read.', inputSchema: z.object({}) }, (_args, ctx) => {
        const auth = ctx.http?.authInfo;
        return (
            requireScope(auth, 'files:read') ?? {
                content: [{ type: 'text', text: `listed by ${auth?.clientId} [${auth?.scopes.join(' ')}]` }]
            }
        );
    });
    server.registerTool('write-file', { description: 'Requires files:write.', inputSchema: z.object({}) }, (_args, ctx) => {
        const auth = ctx.http?.authInfo;
        return (
            requireScope(auth, 'files:write') ?? {
                content: [{ type: 'text', text: `written by ${auth?.clientId} [${auth?.scopes.join(' ')}]` }]
            }
        );
    });
    return server;
}

const handler = createMcpHandler(buildServer);
const node = toNodeHandler(handler);

const app = createMcpExpressApp();
// RFC 9728 PRM: the client discovers the AS from the 401 challenge → this route → AS metadata.
app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json({ resource: MCP_URL, authorization_servers: [AS_ISSUER], scopes_supported: ['files:read', 'files:write'] });
});
app.all('/mcp', (req, res) => {
    const authInfo = verifyBearer(req.headers.authorization ?? null);
    if (!authInfo) {
        res.set(
            'www-authenticate',
            `Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp", scope="files:read"`
        );
        res.status(401).json({ error: 'invalid_token' });
        return;
    }
    // toNodeHandler reads `req.auth` and forwards it as the entry's pass-through authInfo;
    // per-tool scope is enforced inside each tool handler via ctx.http?.authInfo.
    req.auth = authInfo;
    void node(req, res, req.body);
});

app.listen(port, '127.0.0.1', () => console.error(`[server] MCP RS listening on ${MCP_URL}`));
