/**
 * Self-verifying `client_credentials` client.
 *
 * 1. A bare request is `401` with a `WWW-Authenticate` challenge that names the
 *    Protected Resource Metadata URL.
 * 2. A `Client` with a {@linkcode ClientCredentialsProvider} on its transport
 *    follows that challenge → AS metadata → `POST /token` with
 *    `grant_type=client_credentials` (HTTP Basic `client_id:client_secret`) →
 *    Bearer token → reaches the `whoami` tool, whose `ctx.authInfo` carries the
 *    granted scopes.
 *
 * No browser, no readline. The SDK's auth driver does the discovery; the only
 * thing the caller supplies is the pre-registered client's id+secret.
 */
import { Client, ClientCredentialsProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, negotiationFromArgs, runClient } from '../harness.js';

const argv = process.argv.slice(2);
const URL_ARG = argv[argv.indexOf('--http') + 1] ?? 'http://127.0.0.1:3000/mcp';

runClient('oauth-client-credentials', async () => {
    // Unauthenticated → 401 + WWW-Authenticate naming the PRM URL.
    const unauth = await fetch(URL_ARG, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    check.equal(unauth.status, 401, 'bare request must be 401');
    check.match(unauth.headers.get('www-authenticate') ?? '', /Bearer/);
    check.match(unauth.headers.get('www-authenticate') ?? '', /oauth-protected-resource/);

    // Authenticated via client_credentials → 200, ctx.authInfo carries the granted scopes.
    const provider = new ClientCredentialsProvider({
        clientId: 'demo-m2m-client',
        clientSecret: 'demo-m2m-secret',
        scope: 'mcp:tools mcp:read'
    });
    const client = new Client({ name: 'client-credentials-client', version: '1.0.0' }, { versionNegotiation: negotiationFromArgs() });
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL_ARG), { authProvider: provider }));

    const tokens = provider.tokens();
    check.ok(tokens?.access_token, 'ClientCredentialsProvider obtained an access_token');
    check.equal(tokens?.token_type, 'Bearer');

    const result = await client.callTool({ name: 'whoami', arguments: {} });
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    const seen = JSON.parse(text) as { clientId: string; scopes: string[] };
    check.equal(seen.clientId, 'demo-m2m-client', 'ctx.authInfo.clientId round-trips');
    check.ok(seen.scopes.includes('mcp:tools'), 'ctx.authInfo.scopes carries the granted scope');

    // Expiry: both the demo verifier and `requireBearerAuth` reject when
    // `AuthInfo.expiresAt` is in the past, so an expired token would 401 here
    // exactly like the bare-request leg above. Minting an expired token would
    // mean reaching past the AS's public surface, so the path is documented
    // rather than exercised.

    await client.close();
});
