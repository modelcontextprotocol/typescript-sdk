/**
 * Asserts a bare request is `401` with a `WWW-Authenticate` challenge (parsed
 * with the SDK's `extractWWWAuthenticateParams`), and that a request with
 * `Authorization: Bearer demo-token` reaches the `whoami` tool with the
 * verified `authInfo`.
 */
import { check, parseExampleArgs } from '@mcp-examples/shared';
import { Client, extractWWWAuthenticateParams, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { url, era } = parseExampleArgs();

// Unauthenticated → 401 + WWW-Authenticate.
const unauth = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
});
check.equal(unauth.status, 401);
check.equal(extractWWWAuthenticateParams(unauth).error, 'invalid_token');

// Authenticated → 200 and the tool sees the authInfo. Bearer auth is
// HTTP-layer and era-agnostic; the client honours `--legacy` via `era`.
const client = new Client(
    { name: 'bearer-auth-web-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);
await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => 'demo-token' } }));

const result = await client.callTool({ name: 'whoami', arguments: {} });
check.equal(result.content?.[0]?.type === 'text' ? result.content[0].text : '', 'client=demo-client');

await client.close();
