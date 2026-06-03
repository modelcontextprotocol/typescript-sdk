/**
 * Self-contained test bodies for Express-bound hosting surfaces.
 *
 * These tests cover the SDK's Express-bound surface (bearer-token middleware,
 * OAuth metadata router, host validation, createMcpExpressApp) over real HTTP —
 * the layer a server operator deploys and remote clients depend on; Client/Server
 * are not the subject.
 *
 * The SDK's requireBearerAuth, mcpAuthMetadataRouter, and host-header validation
 * middleware are Express RequestHandlers; they cannot be exercised with
 * in-process Web-standard Request/Response. These tests build real Express apps,
 * listen on ephemeral ports (127.0.0.1), drive them with fetch(), and assert
 * exact HTTP status + header + body shapes.
 *
 * Function names mirror the requirement id in camelCase. NO casts, exact
 * assertions, closure recorders outside factories (for stateless compat),
 * minimal comments, every server closed in finally.
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpExpressApp, mcpAuthMetadataRouter, requireBearerAuth } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { OAuthMetadata } from '@modelcontextprotocol/server';
import { McpServer, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { Express, RequestHandler } from 'express';
import express from 'express';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { startExpressMinimal, startExpressWithHostValidation } from '../helpers/express';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const RESOURCE_METADATA_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource';
const VALID_TOKEN = 'analytics-dashboard-token';
const EXPIRED_TOKEN = 'expired-access-token';
const MALFORMED_TOKEN = 'not-a-valid-jwt';

/**
 * POST `body` to `url` via `node:http`, forcing `Host: <host>`.
 * Unlike undici fetch(), node:http sends caller-supplied Host header verbatim.
 */
function postWithHost(url: URL, host: string, body: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    Host: host,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'Content-Length': Buffer.byteLength(body)
                }
            },
            res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => (data += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

verifies('hosting:auth:missing-401', async (_args: TestArgs) => {
    const verifier = { verifyAccessToken: async (_token: string) => ({ token: '', clientId: 'test', scopes: [], expiresAt: 1e12 }) };

    await using host = await startExpressMinimal(requireBearerAuth({ verifier, resourceMetadataUrl: RESOURCE_METADATA_URL }));

    const res = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error="invalid_token"');
    expect(wwwAuth).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);

    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_token');
});

verifies('hosting:auth:invalid-401', async (_args: TestArgs) => {
    const verifier = {
        verifyAccessToken: async (token: string) => {
            if (token === MALFORMED_TOKEN) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token verification failed');
            return { token, clientId: 'test', scopes: [], expiresAt: 1e12 };
        }
    };

    await using host = await startExpressMinimal(requireBearerAuth({ verifier }));

    const res = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${MALFORMED_TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error="invalid_token"');
});

verifies('hosting:auth:expired-401', async (_args: TestArgs) => {
    const PAST_EXPIRY = 1;
    const verifier = {
        verifyAccessToken: async (token: string) => ({
            token,
            clientId: 'test-client',
            scopes: [],
            expiresAt: token === EXPIRED_TOKEN ? PAST_EXPIRY : Date.now() / 1000 + 3600
        })
    };

    await using host = await startExpressMinimal(requireBearerAuth({ verifier }));

    const res = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${EXPIRED_TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toContain('error="invalid_token"');
});

verifies('hosting:auth:scope-403', async (_args: TestArgs) => {
    const verifier = {
        verifyAccessToken: async (token: string) => ({
            token,
            clientId: 'test-client',
            scopes: token === VALID_TOKEN ? ['mcp:tools:read'] : ['mcp:tools:call'],
            expiresAt: Date.now() / 1000 + 3600
        })
    };

    await using host = await startExpressMinimal(
        requireBearerAuth({
            verifier,
            requiredScopes: ['mcp:tools:read', 'mcp:tools:call'],
            resourceMetadataUrl: RESOURCE_METADATA_URL
        })
    );

    const res = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${VALID_TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(res.status).toBe(403);

    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error="insufficient_scope"');
    expect(wwwAuth).toContain('scope="mcp:tools:read mcp:tools:call"');
    expect(wwwAuth).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);

    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('insufficient_scope');
});

verifies('hosting:auth:aud-validation', async (_args: TestArgs) => {
    const SERVER_RESOURCE_ID = 'https://mcp.example.com/api';
    const WRONG_AUDIENCE = 'https://other.example.com/api';

    const verifier = {
        verifyAccessToken: async (token: string) => {
            const aud = token === 'wrong-aud-token' ? WRONG_AUDIENCE : SERVER_RESOURCE_ID;
            return {
                token,
                clientId: 'test-client',
                scopes: [],
                expiresAt: Date.now() / 1000 + 3600,
                resource: new URL(aud)
            };
        }
    };

    const app = express();
    app.use(express.json());
    app.use(requireBearerAuth({ verifier, resourceMetadataUrl: SERVER_RESOURCE_ID }));
    app.post('/mcp', (_req, res) => {
        res.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    });

    await using host = await startExpressMinimal(app);

    const wrongAud = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: 'Bearer wrong-aud-token'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(wrongAud.status).toBeGreaterThanOrEqual(401);
    expect(wrongAud.status).toBeLessThanOrEqual(403);

    const wwwAuth = wrongAud.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error=');

    const body = (await wrongAud.json()) as { error?: string };
    expect(body.error).toBeTruthy();
});

verifies('hosting:auth:metadata-endpoints', async (_args: TestArgs) => {
    const issuer = new URL('https://auth.example.com');
    const oauthMetadata: OAuthMetadata = {
        issuer: issuer.href,
        authorization_endpoint: new URL('/authorize', issuer).href,
        token_endpoint: new URL('/token', issuer).href,
        response_types_supported: ['code']
    };

    const app = express();
    app.use(express.json());
    app.use(
        mcpAuthMetadataRouter({
            oauthMetadata,
            resourceServerUrl: new URL('https://mcp.example.com')
        })
    );

    await using host = await startExpressMinimal(app);

    const asMetadata = await fetch(new URL('/.well-known/oauth-authorization-server', host.baseUrl));
    expect(asMetadata.status).toBe(200);
    const asBody = (await asMetadata.json()) as { issuer?: string; authorization_endpoint?: string };
    expect(asBody.issuer).toBe(issuer.href);
    expect(asBody.authorization_endpoint).toBeTruthy();

    const prmMetadata = await fetch(new URL('/.well-known/oauth-protected-resource', host.baseUrl));
    expect(prmMetadata.status).toBe(200);
    const prmBody = (await prmMetadata.json()) as { resource?: string; authorization_servers?: string[] };
    expect(prmBody.authorization_servers).toContain(issuer.href);
});

verifies('hosting:auth:prm:authorization-servers-field', async (_args: TestArgs) => {
    const issuer = new URL('https://auth.example.com');
    const oauthMetadata: OAuthMetadata = {
        issuer: issuer.href,
        authorization_endpoint: new URL('/authorize', issuer).href,
        token_endpoint: new URL('/token', issuer).href,
        response_types_supported: ['code']
    };

    const app = express();
    app.use(
        mcpAuthMetadataRouter({
            oauthMetadata,
            resourceServerUrl: new URL('https://mcp.example.com')
        })
    );

    await using host = await startExpressMinimal(app);

    const res = await fetch(new URL('/.well-known/oauth-protected-resource', host.baseUrl));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_servers?: string[] };
    expect(body.authorization_servers).toBeInstanceOf(Array);
    expect(body.authorization_servers?.length).toBeGreaterThan(0);
    expect(body.authorization_servers).toContain(issuer.href);
});

verifies('hosting:http:host-validation-middleware', async (_args: TestArgs) => {
    const handler: RequestHandler = (_req, res) => {
        res.json({ ok: true });
    };

    await using host = await startExpressWithHostValidation(['localhost', '127.0.0.1'], handler);

    const good = await fetch(new URL('/test', host.baseUrl));
    expect(good.status).toBe(200);

    const spoofed = await postWithHost(new URL('/test', host.baseUrl), 'evil.example.com', JSON.stringify({ test: 'data' }));
    expect(spoofed.status).toBe(403);
    const body = JSON.parse(spoofed.body) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/Invalid Host/i);
});

verifies('hosting:express-app-helper', async (_args: TestArgs) => {
    const app = createMcpExpressApp();
    app.post('/mcp', (_req, res) => {
        res.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    });

    await using host = await startExpressMinimal(app);

    expect(host.baseUrl.hostname).toBe('127.0.0.1');

    const good = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    expect(good.status).toBe(200);

    const spoofed = await postWithHost(
        new URL('/mcp', host.baseUrl),
        'evil.example.com',
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    );
    expect(spoofed.status).toBe(403);
    const body = JSON.parse(spoofed.body) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/Invalid Host/i);
});

verifies('hosting:auth:query-token-ignored', async (_args: TestArgs) => {
    const verifier = {
        verifyAccessToken: async (token: string) => {
            if (token !== VALID_TOKEN) {
                throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token verification failed');
            }
            return { token, clientId: 'analytics-client', scopes: [], expiresAt: Date.now() / 1000 + 3600 };
        }
    };

    const app = express();
    app.use(express.json());
    app.use(requireBearerAuth({ verifier, resourceMetadataUrl: RESOURCE_METADATA_URL }));
    app.post('/mcp', (_req, res) => {
        res.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    });

    await using host = await startExpressMinimal(app);

    const queryUrl = new URL('/mcp', host.baseUrl);
    queryUrl.searchParams.set('access_token', VALID_TOKEN);
    const queryRes = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });

    expect(queryRes.status).toBe(401);
    const wwwAuth = queryRes.headers.get('www-authenticate');
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('error="invalid_token"');
    const queryBody = (await queryRes.json()) as { error?: string };
    expect(queryBody.error).toBe('invalid_token');

    // Control: the same token in the Authorization header authenticates, proving only the query-string placement was ignored.
    const headerRes = await fetch(new URL('/mcp', host.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    expect(headerRes.status).toBe(200);
});

/** Listen `app` (already fully configured by the adapter under test) on an ephemeral 127.0.0.1 port; callers close() in finally. */
function listenExpressApp(app: Express): Promise<{ baseUrl: URL; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error(`listen failed: ${String(addr)}`));
                return;
            }
            resolve({
                baseUrl: new URL(`http://127.0.0.1:${addr.port}`),
                close: () =>
                    new Promise<void>((res, rej) => {
                        server.close(err => (err ? rej(err) : res()));
                    })
            });
        });
        server.on('error', reject);
    });
}

verifies('hosting:express:adapter-basic-flow', async (_args: TestArgs) => {
    const mcpServer = new McpServer({ name: 'express-adapter-server', version: '1.0.0' });
    mcpServer.registerTool(
        'lookup-order-status',
        { description: 'Look up the shipping status of an order.', inputSchema: z.object({ orderId: z.string() }) },
        ({ orderId }) => ({ content: [{ type: 'text', text: `Order ${orderId} is in transit.` }] })
    );

    const serverTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await mcpServer.connect(serverTransport);

    const app = createMcpExpressApp();
    app.post('/mcp', async (req, res) => {
        await serverTransport.handleRequest(req, res, req.body);
    });

    const { baseUrl, close } = await listenExpressApp(app);
    const client = new Client({ name: 'express-adapter-client', version: '1.0.0' });
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseUrl)));

        // Initialize completed over the Express-hosted POST route: the negotiated server identity is visible on the client.
        expect(client.getServerVersion()).toEqual({ name: 'express-adapter-server', version: '1.0.0' });

        const result = await client.callTool({ name: 'lookup-order-status', arguments: { orderId: 'ORD-1042' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Order ORD-1042 is in transit.' }]);
    } finally {
        await client.close();
        await mcpServer.close();
        await close();
    }
});

verifies('hosting:express:adapter-host-header-validation', async ({ protocolVersion }: TestArgs) => {
    const mcpServer = new McpServer({ name: 'rebind-protected-server', version: '1.0.0' });
    // JSON response mode keeps the allowed-host control assertable as a plain JSON initialize result.
    const serverTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    await mcpServer.connect(serverTransport);

    let mcpRouteHits = 0;
    const app = createMcpExpressApp();
    app.post('/mcp', async (req, res) => {
        mcpRouteHits += 1;
        await serverTransport.handleRequest(req, res, req.body);
    });

    const { baseUrl, close } = await listenExpressApp(app);
    try {
        const initializeBody = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion, capabilities: {}, clientInfo: { name: 'rebind-client', version: '1.0.0' } }
        });

        const spoofed = await postWithHost(new URL('/mcp', baseUrl), 'evil.example.com', initializeBody);
        expect(spoofed.status).toBe(403);
        const spoofedJson: unknown = JSON.parse(spoofed.body);
        expect(spoofedJson).toEqual({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Invalid Host: evil.example.com' },
            id: null
        });
        // Rejected by the default localhost DNS-rebinding middleware before the MCP transport route ever ran.
        expect(mcpRouteHits).toBe(0);

        // Control: the identical request with the real localhost Host reaches the transport and initializes normally.
        const allowed = await postWithHost(new URL('/mcp', baseUrl), `127.0.0.1:${baseUrl.port}`, initializeBody);
        expect(allowed.status).toBe(200);
        const allowedJson: unknown = JSON.parse(allowed.body);
        expect(allowedJson).toMatchObject({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion, serverInfo: { name: 'rebind-protected-server', version: '1.0.0' } }
        });
        expect(mcpRouteHits).toBe(1);
    } finally {
        await mcpServer.close();
        await close();
    }
});
