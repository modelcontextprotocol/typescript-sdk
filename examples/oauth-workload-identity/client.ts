/**
 * Self-verifying Workload Identity Federation client (SEP-1933).
 *
 * 1. A bare request is `401` with a `WWW-Authenticate` challenge that names the
 *    Protected Resource Metadata URL.
 * 2. A `Client` with a {@linkcode WorkloadIdentityProvider} on its transport
 *    follows that challenge → AS metadata → `POST /token` with
 *    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and the workload
 *    JWT as `assertion` → Bearer token → reaches the `whoami` tool, whose
 *    `ctx.authInfo` carries the federated workload subject and granted scopes.
 *
 * No browser, no readline, no client secret. The only credential is the JWT the
 * platform already put on disk for this workload.
 */
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { check, parseExampleArgs } from '@mcp-examples/shared';
import type { WorkloadAssertionCallback } from '@modelcontextprotocol/client';
import {
    Client,
    StreamableHTTPClientTransport,
    WorkloadAssertionRejectedError,
    WorkloadIdentityProvider
} from '@modelcontextprotocol/client';

const { url, era } = parseExampleArgs();

// Same derivation as `server.ts`: the projected token sits at a port-derived
// path so neither half needs an out-of-band handshake.
const tokenPath = process.env.WIF_WORKLOAD_TOKEN_PATH ?? path.join(tmpdir(), `mcp-wif-workload-token-${new URL(url).port}.jwt`);

/**
 * Reads the workload JWT from disk on every token request. Kubernetes rewrites a
 * projected service account token in place as it rotates, so re-reading per call
 * is what keeps a long-lived process from pinning an assertion until it expires.
 */
function fileAssertionSource(tokenFile: string): WorkloadAssertionCallback {
    return async () => {
        const jwt = await readFile(tokenFile, 'utf8');
        return jwt.trim();
    };
}

// Unauthenticated → 401 + WWW-Authenticate naming the PRM URL.
const unauth = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
});
check.equal(unauth.status, 401, 'bare request must be 401');
check.match(unauth.headers.get('www-authenticate') ?? '', /Bearer/);
check.match(unauth.headers.get('www-authenticate') ?? '', /oauth-protected-resource/);

// Authenticated by exchanging the workload JWT for an access token.
const provider = new WorkloadIdentityProvider({
    clientId: 'demo-workload',
    assertion: fileAssertionSource(tokenPath)
});
const client = new Client(
    { name: 'workload-identity-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);
await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }));

const tokens = provider.tokens();
check.ok(tokens?.access_token, 'WorkloadIdentityProvider exchanged the workload JWT for an access_token');
check.equal(tokens?.token_type, 'Bearer');

const { tools } = await client.listTools();
console.log(`tools: ${tools.map(t => t.name).join(', ')}`);
check.ok(
    tools.some(t => t.name === 'whoami'),
    'the federated token reaches the tool list'
);

const result = await client.callTool({ name: 'whoami', arguments: {} });
const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
const seen = JSON.parse(text) as { clientId: string; scopes: string[]; workloadSubject: string };
check.equal(seen.clientId, 'demo-workload', 'ctx.authInfo.clientId round-trips');
check.equal(seen.workloadSubject, 'spiffe://demo.example/mcp-workload', 'the assertion subject reached the resource server');
check.ok(seen.scopes.includes('mcp:tools'), 'ctx.authInfo.scopes carries the granted scope');

// Rejected assertions are not retried (the conformance suite's `wif-no-retry` check): a bad audience or
// an expired file surfaces as one loud error, not a retry loop or a silent fall
// back to an interactive grant. A second provider carrying a bogus assertion proves it.
const rejectedProvider = new WorkloadIdentityProvider({ clientId: 'demo-workload', assertion: 'not.a.jwt' });
const rejectedClient = new Client({ name: 'workload-identity-client', version: '1.0.0' });
const rejectedConnect = rejectedClient.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: rejectedProvider }));
await check.rejects(rejectedConnect, WorkloadAssertionRejectedError);
console.log('rejected assertion: connect failed loudly, no retry and no interactive fallback');

await client.close();
