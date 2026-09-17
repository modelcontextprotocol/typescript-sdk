// docs: typecheck-only
/**
 * Type-checked companion for `docs/clients/oauth.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's `ts` fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). The page is
 * the user-facing authorization-code flow — finishing it needs a browser and an
 * authorization server, so nothing here runs in CI; the file only typechecks.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *
 * @module
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
import type {
    OAuthClientInformationContext,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthClientProvider,
    OAuthDiscoveryState,
    OAuthTokens
} from '@modelcontextprotocol/client';
import {
    checkResourceAllowed,
    Client,
    IssuerMismatchError,
    resourceUrlFromServerUrl,
    StreamableHTTPClientTransport,
    UnauthorizedError
} from '@modelcontextprotocol/client';

// Stand-ins for the host application: how it opens a browser, and how its
// callback endpoint hands the redirect URL back to this code.
declare function onRedirect(url: URL): void;
declare function waitForCallback(): Promise<string>;

// ---------------------------------------------------------------------------
// "Implement OAuthClientProvider" — the page shows this class AFTER the
// transport that uses it; it lives first here so every region below can see it.
// ---------------------------------------------------------------------------

//#region MyOAuthProvider_class
class MyOAuthProvider implements OAuthClientProvider {
    // Key DCR-obtained credentials by issuer so a client_id registered with one
    // authorization server is never returned for another (SEP-2352).
    private creds = new Map<string, OAuthClientInformationMixed>();
    private storedTokens?: OAuthTokens;
    private verifier?: string;
    private discovery?: OAuthDiscoveryState;
    lastState?: string;

    readonly redirectUrl = 'http://localhost:8090/callback';
    readonly clientMetadata: OAuthClientMetadata = {
        client_name: 'My MCP Client',
        redirect_uris: ['http://localhost:8090/callback'],
        // Loopback redirect → the SDK would default this to 'native'; set
        // explicitly when the heuristic is wrong for your deployment (SEP-837).
        application_type: 'native'
    };

    clientInformation(ctx?: OAuthClientInformationContext) {
        return ctx ? this.creds.get(ctx.issuer) : undefined;
    }
    saveClientInformation(info: OAuthClientInformationMixed, ctx?: OAuthClientInformationContext) {
        if (ctx) this.creds.set(ctx.issuer, info);
    }
    tokens() {
        return this.storedTokens;
    }
    saveTokens(tokens: OAuthTokens) {
        // In production, persist to OS keychain / secure storage — never plain files.
        this.storedTokens = tokens;
    }
    // CSRF binding for the redirect — the SDK puts this on the authorize URL;
    // your callback handler compares it before calling `finishAuth`.
    state() {
        this.lastState = crypto.randomUUID();
        return this.lastState;
    }
    // Callback-leg AS-binding (SEP-2352): record what discovery resolved before
    // the redirect so the SDK can verify the code is exchanged at the same AS.
    saveDiscoveryState(state: OAuthDiscoveryState) {
        this.discovery = state;
    }
    discoveryState() {
        return this.discovery;
    }
    redirectToAuthorization(url: URL) {
        onRedirect(url);
    }
    saveCodeVerifier(v: string) {
        this.verifier = v;
    }
    codeVerifier() {
        if (!this.verifier) throw new Error('no code verifier');
        return this.verifier;
    }
}
//#endregion MyOAuthProvider_class

// ---------------------------------------------------------------------------
// "Hand the transport an OAuth provider"
// ---------------------------------------------------------------------------

/** Example: connect with an `authProvider`; an auth-gated server throws `UnauthorizedError`. */
async function authProvider_connect() {
    //#region authProvider_connect
    const provider = new MyOAuthProvider();
    const client = new Client({ name: 'my-app', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), {
        authProvider: provider
    });

    try {
        await client.connect(transport);
    } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        // The transport already called provider.redirectToAuthorization(url):
        // the end user is in the browser, at the authorization server.
    }
    //#endregion authProvider_connect
    return { client, provider, transport };
}

// ---------------------------------------------------------------------------
// "Finish the flow from the callback"
// ---------------------------------------------------------------------------

/** Example: state check, code exchange, reconnect on a fresh transport. */
async function finishAuth_callback() {
    const { client, provider, transport } = await authProvider_connect();
    const url = new URL('https://api.example.com/mcp');
    //#region finishAuth_callback
    const callbackUrl = await waitForCallback(); // however your app receives the redirect
    const params = new URL(callbackUrl).searchParams;

    // The SDK does not validate `state` — compare it to the value your provider generated.
    if (params.get('state') !== provider.lastState) throw new Error('state mismatch');

    await transport.finishAuth(params);

    // Reconnect on a FRESH transport — a started transport cannot be restarted.
    // OAuth state (tokens, verifier, discovery) lives on the provider, not the transport.
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
    //#endregion finishAuth_callback
}

// ---------------------------------------------------------------------------
// "Handle issuer mismatch"
// ---------------------------------------------------------------------------

/** Example: the RFC 9207 mix-up defense around `finishAuth`. */
async function finishAuth_issuerMismatch(transport: StreamableHTTPClientTransport, params: URLSearchParams) {
    //#region finishAuth_issuerMismatch
    try {
        await transport.finishAuth(params);
    } catch (error) {
        if (error instanceof IssuerMismatchError) {
            // Mix-up attack: never render params.get('error_description') to the user.
            throw new Error('Authorization failed: issuer mismatch');
        }
        throw error;
    }
    //#endregion finishAuth_issuerMismatch
}

// ---------------------------------------------------------------------------
// "Pin the resource indicator"
// ---------------------------------------------------------------------------

//#region validateResourceURL_pin
class PinnedResourceProvider extends MyOAuthProvider {
    async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
        const expected = resourceUrlFromServerUrl(serverUrl); // strips the fragment (RFC 8707 §2)
        if (resource && !checkResourceAllowed({ requestedResource: expected, configuredResource: resource })) {
            throw new Error(`Refusing resource ${resource} for server ${expected.href}`);
        }
        return expected;
    }
}
//#endregion validateResourceURL_pin
