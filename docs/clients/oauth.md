---
shape: how-to
description: 'Sign an end user in from a client you build with the OAuth authorization-code flow.'
---
# Authenticate a user with OAuth

Protecting a server you run → [Require authorization](../serving/authorization.md). Signing a user in from a client → this page. No user present → [Authenticate without a user](./machine-auth.md).

## Hand the transport an OAuth provider

Pass an **`OAuthClientProvider`** as the transport's `authProvider` — it, and every other symbol on this page, comes from `@modelcontextprotocol/client`.

```ts source="../../examples/guides/clients/oauth.examples.ts#authProvider_connect"
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
```

When the server requires authorization and the provider has no token, the SDK runs discovery against the server, registers (or looks up) your OAuth client, calls the provider's `redirectToAuthorization(url)`, and `connect()` throws `UnauthorizedError`. The end user finishes signing in out of band; your callback endpoint picks the flow back up below.

::: info
With protocol-version negotiation in play, the connect-time 401 can also surface as an `SdkError` carrying the `UnauthorizedError` at `error.data.cause` — see [Protocol versions](../protocol-versions.md).
:::

## Implement OAuthClientProvider

The provider is the storage and redirect surface the SDK drives: client registrations, tokens, the PKCE verifier, discovery state, and the browser hand-off. Key client credentials by `ctx.issuer` so a `client_id` registered with one authorization server is never sent to another.

```ts source="../../examples/guides/clients/oauth.examples.ts#MyOAuthProvider_class"
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
```

The SDK calls the `save*` methods as the flow produces values and reads them back through `tokens()`, `clientInformation()`, `codeVerifier()`, and `discoveryState()`. On a later `connect()` it reads `tokens()` before anything else, so a provider backed by durable storage skips the browser round trip.

## Finish the flow from the callback

The authorization server redirects the end user to `redirectUrl` with `code` and `state` in the query. Compare `state`, hand the whole query to `finishAuth`, and reconnect.

```ts source="../../examples/guides/clients/oauth.examples.ts#finishAuth_callback"
const callbackUrl = await waitForCallback(); // however your app receives the redirect
const params = new URL(callbackUrl).searchParams;

// The SDK does not validate `state` — compare it to the value your provider generated.
if (params.get('state') !== provider.lastState) throw new Error('state mismatch');

await transport.finishAuth(params);

// Reconnect on a FRESH transport — a started transport cannot be restarted.
// OAuth state (tokens, verifier, discovery) lives on the provider, not the transport.
await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
```

`finishAuth(params)` extracts `code`, validates the RFC 9207 `iss` parameter, exchanges the code at the authorization server discovery resolved before the redirect, and saves the tokens through your provider. The second `connect()` finds those tokens and completes without another redirect.

::: tip
`finishAuth` also takes a positional form, `finishAuth(code, iss)`. Pass the `URLSearchParams` instead: the SDK reads both values from it, and a positional call that drops `iss` is rejected when the authorization server advertises RFC 9207 support.
:::

## Handle issuer mismatch

`finishAuth` throws **`IssuerMismatchError`** when the callback's `iss` does not match the issuer the flow started with.

```ts source="../../examples/guides/clients/oauth.examples.ts#finishAuth_issuerMismatch"
try {
    await transport.finishAuth(params);
} catch (error) {
    if (error instanceof IssuerMismatchError) {
        // Mix-up attack: never render params.get('error_description') to the user.
        throw new Error('Authorization failed: issuer mismatch');
    }
    throw error;
}
```

The error's `kind` is `'authorization_response'` here; the same check runs during discovery against the authorization server's published `issuer` (RFC 8414 §3.3) and throws with `kind: 'metadata'`.

::: warning
A mismatch means the callback came from an authorization server you did not start the flow with — a mix-up attack. The callback's `error` and `error_description` are attacker-controlled: never render them. The transport's `skipIssuerMetadataValidation` option disables the discovery-leg check; leave it off unless you control the server.
:::

## Pin the resource indicator

The SDK binds tokens to your server with the RFC 8707 `resource` parameter: when the server publishes protected resource metadata (RFC 9728), the SDK checks the metadata's `resource` against the server URL and attaches it to the authorization redirect and every token request. Override `validateResourceURL` to force the value — return the URL to send, or `undefined` to omit the parameter.

```ts source="../../examples/guides/clients/oauth.examples.ts#validateResourceURL_pin"
class PinnedResourceProvider extends MyOAuthProvider {
    async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
        const expected = resourceUrlFromServerUrl(serverUrl); // strips the fragment (RFC 8707 §2)
        if (resource && !checkResourceAllowed({ requestedResource: expected, configuredResource: resource })) {
            throw new Error(`Refusing resource ${resource} for server ${expected.href}`);
        }
        return expected;
    }
}
```

`PinnedResourceProvider` sends the server's own URL as `resource` on every leg of the flow and refuses metadata that names a different one. `checkResourceAllowed` and `resourceUrlFromServerUrl` are exported for exactly this override.

## Recap

- This page signs in an end user; machine-to-machine flows live on [Authenticate without a user](./machine-auth.md).
- Pass an `OAuthClientProvider` as the transport's `authProvider`; `connect()` throws `UnauthorizedError` after sending the user to the authorization server.
- `finishAuth(params)` with the whole callback query validates `iss` (RFC 9207) and exchanges the code.
- Reconnect on a fresh transport; OAuth state lives on the provider, not the transport.
- `IssuerMismatchError` is the mix-up defense — never render the callback's `error_description`.
- `validateResourceURL` overrides the RFC 8707 `resource` parameter the SDK sends.
