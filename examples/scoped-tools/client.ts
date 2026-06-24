/**
 * Self-verifying per-tool scope client.
 *
 * Drives the same OAuth machinery as `examples/oauth/client.ts` to obtain a
 * `files:read` token, then exercises the server's handler-level per-tool scope
 * checks: `list-files` succeeds; `write-file` returns a tool-result
 * `{ isError: true }` because the token lacks `files:write`. The transport's
 * automatic `403 insufficient_scope` step-up (SEP-2350) is exercised by the
 * dedicated e2e scenario (`test/e2e/scenarios/client-auth.test.ts`); this
 * example demonstrates the recommended server-side pattern of enforcing scope
 * inside the tool handler that needs it.
 *
 * HTTP-only (the OAuth dance is HTTP redirects + Bearer headers), so the
 * canonical stdio branch does not apply.
 */
import { check, parseExampleArgs } from '@mcp-examples/shared';
import type { OAuthClientMetadata } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';

import { InMemoryOAuthClientProvider } from '../oauth/simpleOAuthClientProvider.js';

const CALLBACK_URL = 'http://127.0.0.1:8091/callback';

/** Follow the demo AS's auto-consent 302 and return the `code`. */
async function followAuthorize(authorizationUrl: URL): Promise<string> {
    const res = await fetch(authorizationUrl, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (!location || res.status !== 302) throw new Error(`expected 302 from /authorize, got ${res.status}`);
    const code = new globalThis.URL(location).searchParams.get('code');
    if (!code) throw new Error(`authorize redirect missing ?code: ${location}`);
    return code;
}

const { url } = parseExampleArgs();

// Modern-only — authInfo plumbing through ServerContext is the feature under
// demonstration; the legacy era does not exercise it.
const client = new Client({ name: 'scoped-tools-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

const captured: URL[] = [];
const clientMetadata: OAuthClientMetadata = {
    client_name: 'Scoped-Tools Step-Up Client',
    redirect_uris: [CALLBACK_URL],
    application_type: 'native',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'files:read'
};
const provider = new InMemoryOAuthClientProvider(CALLBACK_URL, clientMetadata, authUrl => {
    captured.push(authUrl);
});

// ---- 1. Initial authorization for files:read ------------------------------
const t1 = new StreamableHTTPClientTransport(new globalThis.URL(url), { authProvider: provider });
let challenged = false;
try {
    await client.connect(t1);
} catch (error) {
    const root = error instanceof UnauthorizedError ? error : (error as { data?: { cause?: unknown } }).data?.cause;
    if (!(root instanceof UnauthorizedError)) throw error;
    challenged = true;
}
check.ok(challenged, 'first connect must 401');
check.equal(captured.length, 1, 'authorize URL captured');
check.match(captured[0]?.searchParams.get('scope') ?? '', /files:read/);
await t1.finishAuth(await followAuthorize(captured[0]!));
check.equal(provider.tokens()?.scope, 'files:read');

// ---- 2. Reconnect with files:read; list-files works -----------------------
const t2 = new StreamableHTTPClientTransport(new globalThis.URL(url), { authProvider: provider });
await client.connect(t2);
const listed = await client.callTool({ name: 'list-files', arguments: {} });
check.match(listed.content?.[0]?.type === 'text' ? listed.content[0].text : '', /listed by .* \[files:read]/);

// ---- 3. write-file → handler-level insufficient_scope ---------------------
// Per-tool scope is enforced inside the tool handler (ctx.http?.authInfo),
// so an under-scoped call surfaces as a tool-result `isError`, not an HTTP
// 403. The transport's automatic step-up (SEP-2350) applies only when the
// RS responds 403 at the HTTP layer.
const denied = await client.callTool({ name: 'write-file', arguments: {} });
check.equal(denied.isError, true, 'write-file must isError under files:read-only token');
check.match(denied.content?.[0]?.type === 'text' ? denied.content[0].text : '', /insufficient_scope: requires files:write/);
check.equal(captured.length, 1, 'no transport step-up — scope is enforced in the tool handler');

await client.close();
