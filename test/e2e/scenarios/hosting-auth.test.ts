/**
 * Self-contained test bodies for server-side bearer auth on StreamableHTTP
 * hosting.
 *
 * The SDK ships its bearer-auth enforcement (`requireBearerAuth`), AS router
 * (`mcpAuthRouter`) and discovery-metadata router (`mcpAuthMetadataRouter`)
 * as Express `RequestHandler`s only — they consume Express `req`/`res`, so
 * they cannot be driven in-process with Web-standard Request/Response the way
 * this suite hosts StreamableHTTP. The requirements those components alone
 * satisfy (401/403 challenges, audience validation, AS endpoint mounting,
 * `.well-known` publication) are therefore not covered here: re-implementing
 * that behavior in a test wrapper and asserting on the wrapper would prove
 * nothing about the SDK. What this file does cover is the hosting-integration
 * path the Web-standard transport supports natively: a user-shaped bearer
 * gate verifies the Authorization header, then delegates to
 * `WebStandardStreamableHTTPServerTransport.handleRequest(req, { authInfo })`,
 * and the SDK must surface that verified AuthInfo to tool handlers as
 * `extra.authInfo`.
 *
 * Function names mirror the requirement id in camelCase. Bodies are
 * streamableHttp-only and host the transport themselves (the gate has to sit
 * between the client's fetch and the transport), so `TestArgs.transport` is
 * ignored.
 */

import { randomUUID } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const VALID_TOKEN = 'analytics-dashboard-access-token';

verifies('hosting:auth:authinfo-propagates', async (_args: TestArgs) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    // What the user's verifier derives from VALID_TOKEN; a fresh object is built
    // per request so the handler-side assertion checks delivery, not identity.
    const verifyBearer = (header: string | null): AuthInfo | undefined =>
        header === `Bearer ${VALID_TOKEN}`
            ? {
                  token: VALID_TOKEN,
                  clientId: 'analytics-dashboard',
                  scopes: ['mcp:tools:read', 'mcp:tools:call'],
                  expiresAt,
                  extra: { userId: 'user-42' }
              }
            : undefined;

    // Recorders live outside the per-session factory.
    const seenByTool: Array<AuthInfo | undefined> = [];
    const postAuthHeaders: Array<string | null> = [];

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'whoami',
            { description: 'Reports the authenticated caller derived from extra.authInfo.', inputSchema: z.object({}) },
            (_a, ctx) => {
                seenByTool.push(ctx.http?.authInfo);
                return {
                    content: [
                        {
                            type: 'text',
                            text: ctx.http?.authInfo
                                ? `${ctx.http?.authInfo.clientId} [${ctx.http?.authInfo.scopes.join(' ')}]`
                                : 'no-auth-info'
                        }
                    ]
                };
            }
        );
        return s;
    };

    // User-shaped hosting: a bearer gate verifies the Authorization header and
    // hands the verified AuthInfo to the SDK transport via handleRequest options.
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const handleRequest = async (req: Request): Promise<Response> => {
        if (req.method === 'POST') postAuthHeaders.push(req.headers.get('authorization'));
        const authInfo = verifyBearer(req.headers.get('authorization'));
        if (!authInfo) {
            return Response.json(
                { error: 'invalid_token' },
                {
                    status: 401,
                    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' }
                }
            );
        }

        const sid = req.headers.get('mcp-session-id') ?? undefined;
        const existing = sid ? sessions.get(sid) : undefined;
        if (existing) return existing.handleRequest(req, { authInfo });

        const tx = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: id => void sessions.set(id, tx),
            onsessionclosed: id => void sessions.delete(id)
        });
        await makeServer().connect(tx);
        return tx.handleRequest(req, { authInfo });
    };

    const client = new Client({ name: 'c', version: '0' });
    await using _ = {
        [Symbol.asyncDispose]: async () => {
            await client.close();
            for (const t of sessions.values()) await t.close();
        }
    };

    await client.connect(
        new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), {
            fetch: (url, init) => handleRequest(new Request(url, init)),
            requestInit: { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
        })
    );

    const r = await client.callTool({ name: 'whoami', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'analytics-dashboard [mcp:tools:read mcp:tools:call]' }]);

    // The SDK transport delivered the verified AuthInfo into the tool handler's
    // RequestHandlerExtra unchanged — not dropped, not replaced by a placeholder.
    expect(seenByTool).toHaveLength(1);
    expect(seenByTool[0]).toEqual({
        token: VALID_TOKEN,
        clientId: 'analytics-dashboard',
        scopes: ['mcp:tools:read', 'mcp:tools:call'],
        expiresAt,
        extra: { userId: 'user-42' }
    });

    // Sanity: the bearer was on the wire for every POST the SDK client sent
    // (initialize, notifications/initialized, tools/call).
    expect(postAuthHeaders).toEqual([`Bearer ${VALID_TOKEN}`, `Bearer ${VALID_TOKEN}`, `Bearer ${VALID_TOKEN}`]);
});
