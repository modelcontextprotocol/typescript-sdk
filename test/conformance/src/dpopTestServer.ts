#!/usr/bin/env node

/**
 * DPoP-protected MCP server for the `auth/dpop-server-validation` conformance scenario
 * (SEP-1932 / RFC 9449, draft extension — conformance#395). The referee acts as the DPoP client:
 * it presents a valid DPoP-bound access token + proof (which this server MUST accept) and a
 * battery of deliberately malformed variants (which this server MUST reject with `401` and a
 * `WWW-Authenticate: DPoP …` challenge). Proof and token-binding validation is
 * `@modelcontextprotocol/express`'s `requireDpopAuth`, backed by
 * `@modelcontextprotocol/server`'s `verifyDpopProof`/`verifyDpopToken` — this file supplies only
 * the access-token verifier and the server wiring.
 *
 * The access-token verifier below is independent of `@modelcontextprotocol/server`'s own
 * signature-verification code in `dpop.ts` (it imports `DPOP_ISSUER_JWK` and calls
 * `crypto.subtle.verify` directly) so a shared bug in the SDK can't hide from this test.
 *
 * Environment variables (the referee mints tokens with the private half of the same keypair via
 * its own `DPOP_ISSUER_PRIVATE_JWK` — see `scripts/run-dpop-server-conformance.sh`):
 *   PORT               — listen port (default 3010)
 *   DPOP_ISSUER_JWK     — the issuer's PUBLIC JWK (JSON string), ES256/P-256
 *   DPOP_ISSUER         — issuer string both sides validate against
 *   DPOP_AUDIENCE       — this server's own URL (the access token's expected `aud`)
 *   DPOP_REQUIRE_NONCE  — '1' to also exercise the optional server-nonce flow (RFC 9449 §9)
 */

// Type-only: borrows the WebCrypto JWK shape from Node's ambient types (erased at build time —
// see the matching comment in @modelcontextprotocol/server's src/server/middleware/dpop.ts).
import type { webcrypto } from 'node:crypto';

import { createMcpExpressApp, requireDpopAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const PORT = Number(process.env.PORT || 3010);
const ISSUER_JWK = JSON.parse(process.env.DPOP_ISSUER_JWK || '{}') as webcrypto.JsonWebKey;
const ISSUER = process.env.DPOP_ISSUER || 'https://conformance-dpop-issuer.example.com';
const AUDIENCE = process.env.DPOP_AUDIENCE || `http://127.0.0.1:${PORT}/mcp`;
const REQUIRE_NONCE = process.env.DPOP_REQUIRE_NONCE === '1';
const NONCE = 'conformance-dpop-test-nonce';

function base64UrlDecode(input: string): Uint8Array {
    const binary = atob(input.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0;
    return bytes;
}

/**
 * Verify the issuer-signed access token (NOT the DPoP proof — `requireDpopAuth` owns that).
 * Hard-codes ES256/P-256 because the launch script always mints that key; a real Resource Server
 * would branch on the JWT `alg` header the way `@modelcontextprotocol/server`'s `dpop.ts` does.
 */
async function verifyAccessToken(token: string): Promise<AuthInfo> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed access token');
    const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

    const key = await crypto.subtle.importKey('jwk', ISSUER_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const verified = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        base64UrlDecode(signatureSegment),
        new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
    );
    if (!verified) throw new Error('access token signature does not verify');

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadSegment))) as Record<string, unknown>;
    if (payload.iss !== ISSUER) throw new Error(`access token issuer mismatch: expected ${ISSUER}, got ${payload.iss}`);
    if (payload.aud !== AUDIENCE) throw new Error(`access token audience mismatch: expected ${AUDIENCE}, got ${payload.aud}`);
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) throw new Error('access token expired');

    return {
        token,
        clientId: typeof payload.sub === 'string' ? payload.sub : 'conformance-dpop-client',
        scopes: [],
        expiresAt: payload.exp,
        // RFC 9449 §6: the confirmation claim requireDpopAuth compares against the proof's
        // thumbprint (step 12b) — this is the actual sender-constraint check.
        cnf: payload.cnf as { jkt?: string } | undefined
    };
}

function buildServer(_ctx: McpRequestContext): McpServer {
    const server = new McpServer({ name: 'dpop-test-server', version: '1.0.0' });
    server.registerTool('test-tool', { description: 'A simple test tool that returns a success message' }, async () => ({
        content: [{ type: 'text', text: 'test' }]
    }));
    return server;
}

const handler = createMcpHandler(buildServer);
const app = createMcpExpressApp();

const dpopAuth = requireDpopAuth({
    verifier: { verifyAccessToken },
    // RFC 9449 §9 is a SHOULD, not a MUST — only demand a nonce when explicitly opted in, so the
    // scenario's default (no-nonce) run exercises the mandatory checks and the opt-in run
    // additionally exercises the nonce flow.
    nonce: REQUIRE_NONCE ? { issue: () => NONCE, verify: (n: string | undefined) => n === NONCE } : undefined
});

// `requireDpopAuth` sets `req.auth`; `toNodeHandler` reads it and passes it to the factory as
// `ctx.authInfo` — the same wiring as `requireBearerAuth` in examples/oauth/server.ts.
const node = toNodeHandler(handler);
app.all('/mcp', dpopAuth, (req, res) => void node(req, res, req.body));

app.listen(PORT, '127.0.0.1', () => {
    console.log(`DPoP test server listening on http://127.0.0.1:${PORT}/mcp`);
    console.log(`  issuer=${ISSUER} audience=${AUDIENCE} requireNonce=${REQUIRE_NONCE}`);
});
