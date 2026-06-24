/**
 * Self-verifying **authorization-code** OAuth client — the CI-runnable headless
 * twin of {@link ./simpleOAuthClient.ts}.
 *
 * `simpleOAuthClient.ts` is the manual real-user example: it `open()`s the
 * authorization URL in a real browser, the user signs in and clicks **Approve**
 * on the consent screen, the browser is redirected to a local callback server,
 * and the example reads the `code` off that callback. THIS file drives the
 * exact same SDK auth machinery but follows the redirect chain itself — which
 * only works because the demo Authorization Server is started with
 * `OAUTH_DEMO_AUTO_CONSENT=1` so its `/sign-in` page auto-signs-in a fixed
 * demo user and its `/authorize` endpoint auto-consents (skips the Approve
 * screen and 302s straight back to `redirect_uri?code=...`).
 *
 * Flow:
 *  1. Connect with an {@linkcode InMemoryOAuthClientProvider} → 401 → SDK auth
 *     driver discovers PRM → AS metadata → registers a client (DCR) → builds
 *     the authorization URL → calls our `redirectToAuthorization` hook (we
 *     capture the URL) → throws {@linkcode UnauthorizedError}.
 *  2. Follow that URL with `fetch(..., { redirect: 'manual' })`, forwarding
 *     `Set-Cookie` → `Cookie` across hops, until the AS 302s to our
 *     `redirect_uri` with `?code=...`. No callback server is bound — the code
 *     is read straight off the `Location` header.
 *  3. `transport.finishAuth(code)` → SDK exchanges the code (+ PKCE verifier)
 *     for tokens at the AS `/token` endpoint and saves them on the provider.
 *  4. Reconnect with a fresh transport (same provider, now holding tokens) →
 *     Bearer header → 200. Call `whoami` and assert `ctx.authInfo` round-trips.
 */
import type { OAuthClientMetadata } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';

import { check, httpUrlFromArgs, negotiationFromArgs, runClient } from '../harness.js';
import { InMemoryOAuthClientProvider } from './simpleOAuthClientProvider.js';

const URL_ARG = httpUrlFromArgs('http://127.0.0.1:3000/mcp');

// The redirect target the AS will 302 back to with `?code=...`. In the real
// browser flow (`simpleOAuthClient.ts`) a tiny HTTP server listens here so the
// browser has somewhere to land; headlessly we never bind it — we read the
// `code` off the final 302's `Location` header instead.
const CALLBACK_URL = 'http://127.0.0.1:8090/callback';

/**
 * Follow an authorization URL through the demo AS's redirect chain
 * (authorize → /sign-in → authorize → redirect_uri?code=...) and return the
 * `code`. This is the headless stand-in for "the user's browser navigates the
 * login + consent pages": cookies are forwarded hop-to-hop the way a browser
 * would, and the demo AS's auto-sign-in + `autoConsent` collapse every
 * interactive step into a 302.
 */
async function followAuthorizationRedirects(authorizationUrl: URL): Promise<URLSearchParams> {
    let next = authorizationUrl.href;
    // Crude cookie jar — enough for a single-origin demo AS.
    const jar = new Map<string, string>();
    for (let hop = 0; hop < 10; hop++) {
        const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        // In a real client this is `open(authorizationUrl)` — we follow the redirect
        // chain headlessly because the demo AS auto-signs-in and auto-approves.
        const res = await fetch(next, { redirect: 'manual', headers: cookie ? { cookie } : {} });
        for (const sc of res.headers.getSetCookie()) {
            const pair = sc.split(';', 1)[0] ?? '';
            const eq = pair.indexOf('=');
            if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        const location = res.headers.get('location');
        if (!location || res.status < 300 || res.status >= 400) {
            const body = await res.text().catch(() => '');
            throw new Error(`expected a redirect at hop ${hop} (${next}); got ${res.status}\n${body.slice(0, 400)}`);
        }
        const resolved = new globalThis.URL(location, next);
        // In a real deployment, the browser would render the consent page here and
        // the user would click Approve; the demo AS's `autoConsent` flag simulates
        // that approval, so the chain ends in a 302 straight to `redirect_uri`.
        if (resolved.href.startsWith(CALLBACK_URL)) {
            const code = resolved.searchParams.get('code');
            const error = resolved.searchParams.get('error');
            if (error) throw new Error(`AS returned error on callback: ${error} ${resolved.searchParams.get('error_description') ?? ''}`);
            if (!code) throw new Error(`callback redirect missing ?code: ${resolved.href}`);
            return resolved.searchParams;
        }
        next = resolved.href;
    }
    throw new Error('authorization redirect chain did not terminate at the callback within 10 hops');
}

runClient('oauth', async () => {
    // ---- 1. Kick off the SDK auth driver --------------------------------------
    // The SDK builds the authorization URL and hands it to
    // `redirectToAuthorization` — in `simpleOAuthClient.ts` that opens a browser;
    // here we just capture it.
    let capturedAuthorizationUrl: URL | undefined;
    const clientMetadata: OAuthClientMetadata = {
        client_name: 'Headless OAuth MCP Client (CI)',
        redirect_uris: [CALLBACK_URL],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
        token_endpoint_auth_method: 'client_secret_post'
    };
    const provider = new InMemoryOAuthClientProvider(CALLBACK_URL, clientMetadata, url => {
        capturedAuthorizationUrl = url;
    });

    const client = new Client({ name: 'oauth-headless-client', version: '1.0.0' }, { versionNegotiation: negotiationFromArgs() });
    const firstTransport = new StreamableHTTPClientTransport(new globalThis.URL(URL_ARG), { authProvider: provider });
    let challenged = false;
    try {
        await client.connect(firstTransport);
    } catch (error) {
        // Under `--legacy` the transport surfaces `UnauthorizedError` directly;
        // under `mode: 'auto'` the version-negotiation probe is what got 401'd
        // and wraps it in an EraNegotiationFailed `SdkError` whose `data.cause`
        // is the original `UnauthorizedError`. Either way the auth driver has
        // already run by the time we land here — DCR done, auth URL captured.
        const root = error instanceof UnauthorizedError ? error : (error as { data?: { cause?: unknown } }).data?.cause;
        if (!(root instanceof UnauthorizedError)) throw error;
        challenged = true;
    }
    check.ok(challenged, 'first connect must 401 and throw UnauthorizedError');
    check.ok(capturedAuthorizationUrl, 'SDK auth driver should have produced an authorization URL');
    check.ok(provider.clientInformation()?.client_id, 'dynamic client registration should have run');

    // ---- 2. Follow the authorization URL headlessly ---------------------------
    // (the browser-and-user stand-in; see `followAuthorizationRedirects`).
    const callbackParams = await followAuthorizationRedirects(capturedAuthorizationUrl!);

    // ---- 3. Exchange the code for tokens --------------------------------------
    // In the browser flow the local callback server hands the redirect query to
    // `transport.finishAuth`; we read it off the final `Location` header instead.
    // The SDK reads `code` + `iss` (RFC 9207) from the params, validates `iss`
    // against the recorded issuer, then POSTs `grant_type=authorization_code`
    // (+ PKCE `code_verifier`) to the AS `/token` endpoint and saves the tokens
    // on `provider`.
    await firstTransport.finishAuth(callbackParams);
    const tokens = provider.tokens();
    check.ok(tokens?.access_token, 'token exchange should have yielded an access_token');
    check.equal(tokens?.token_type, 'Bearer');

    // ---- 4. Reconnect with the now-populated provider -------------------------
    // A fresh transport reads the saved Bearer token from `provider` and the
    // protected `/mcp` endpoint lets us through.
    const transport = new StreamableHTTPClientTransport(new globalThis.URL(URL_ARG), { authProvider: provider });
    await client.connect(transport);

    const result = await client.callTool({ name: 'whoami', arguments: {} });
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    const seen = JSON.parse(text) as { clientId?: string; scopes?: string[] };
    // `ctx.authInfo` round-trips: the clientId the AS minted at DCR time is the
    // one the Resource Server's verifier sees on the Bearer token.
    check.equal(seen.clientId, provider.clientInformation()?.client_id, 'ctx.authInfo.clientId round-trips the DCR client_id');
    check.ok(seen.scopes?.includes('openid'), 'ctx.authInfo.scopes carries a granted scope');

    await client.close();
});
