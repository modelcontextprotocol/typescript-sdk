/**
 * The web-standard counterpart of `examples/bearer-auth`: the same
 * Resource-Server-only auth built entirely from `@modelcontextprotocol/server`
 * exports — `requireBearerAuth` gating the MCP handler, behind the same
 * DNS-rebinding guards the Express sibling gets from `createMcpExpressApp` —
 * composed as one `fetch(request)` handler.
 *
 * On Cloudflare Workers, Deno, or Bun that handler is the whole server
 * (`export default { fetch: fetchHandler }`); on Node, `toNodeHandler` bridges
 * it onto `node:http`. HTTP-only by definition.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo, McpServerFactory, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import {
    createMcpHandler,
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    localhostAllowedOrigins,
    McpServer,
    OAuthError,
    OAuthErrorCode,
    originValidationResponse,
    requireBearerAuth
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const buildServer: McpServerFactory = ctx => {
    const server = new McpServer({ name: 'bearer-auth-web-example', version: '1.0.0' });
    server.registerTool('whoami', { description: 'Returns the authenticated subject.', inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text', text: `client=${ctx.authInfo?.clientId ?? 'anon'}` }]
    }));
    return server;
};

const { port } = parseExampleArgs();

// Replace with JWT verification, RFC 7662 introspection, etc.
const staticTokenVerifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
        if (token !== 'demo-token') {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
        }
        return { token, clientId: 'demo-client', scopes: ['mcp'], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    }
};

const gate = requireBearerAuth({ verifier: staticTokenVerifier, requiredScopes: ['mcp'] });
const handler = createMcpHandler(buildServer);

async function fetchHandler(request: Request): Promise<Response> {
    const rejected =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());
    if (rejected) {
        return rejected;
    }
    const auth = await gate(request);
    if (auth instanceof Response) {
        return auth;
    }
    return handler.fetch(request, { authInfo: auth });
}

// On a web-standard runtime the composition above is the whole server;
// `toNodeHandler` accepts any `{ fetch }` shape and bridges it onto node:http.
createServer(toNodeHandler({ fetch: fetchHandler })).listen(port, () => {
    console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
});
