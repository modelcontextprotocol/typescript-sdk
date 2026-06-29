---
title: Client Guide
---

# Building MCP clients

This guide covers the TypeScript SDK APIs for building MCP clients. For protocol-level concepts, see the [MCP overview](https://modelcontextprotocol.io/docs/learn/architecture).

A client connects to a server, discovers what it offers — tools, resources, prompts — and invokes them. Beyond that core loop, this guide covers authentication, error handling, and responding to server-initiated requests like sampling and elicitation.

## Imports

The examples below use these imports. Adjust based on which features and transport you need:

```ts source="../examples/guides/clientGuide.examples.ts#imports"
import type {
    AuthProvider,
    CallToolResult,
    InputRequiredResult,
    OAuthClientInformationContext,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthClientProvider,
    OAuthDiscoveryState,
    OAuthTokens
} from '@modelcontextprotocol/client';
import {
    applyMiddlewares,
    checkResourceAllowed,
    Client,
    ClientCredentialsProvider,
    createMiddleware,
    CrossAppAccessProvider,
    discoverAndRequestJwtAuthGrant,
    isInputRequiredResult,
    IssuerMismatchError,
    LOG_LEVEL_META_KEY,
    PrivateKeyJwtProvider,
    ProtocolError,
    resourceUrlFromServerUrl,
    SdkError,
    SdkErrorCode,
    SdkHttpError,
    SSEClientTransport,
    StreamableHTTPClientTransport,
    TRACEPARENT_META_KEY,
    TRACESTATE_META_KEY,
    UnauthorizedError
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
```

## Connecting to a server

### Streamable HTTP

For remote HTTP servers, use `StreamableHTTPClientTransport`:

```ts source="../examples/guides/clientGuide.examples.ts#connect_streamableHttp"
const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

await client.connect(transport);
```

For a full interactive client over Streamable HTTP, see [`repl/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/repl/client.ts).

### stdio

For local, process-spawned servers (Claude Desktop, CLI tools), use `StdioClientTransport`. The transport spawns the server process and communicates over stdin/stdout:

```ts source="../examples/guides/clientGuide.examples.ts#connect_stdio"
const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js']
});

await client.connect(transport);
```

### SSE fallback for legacy servers

To support both modern Streamable HTTP and legacy SSE servers, try `StreamableHTTPClientTransport` first and fall back to `SSEClientTransport` on failure:

```ts source="../examples/guides/clientGuide.examples.ts#connect_sseFallback"
const baseUrl = new URL(url);

try {
    // Try modern Streamable HTTP transport first
    const client = new Client({ name: 'my-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(baseUrl);
    await client.connect(transport);
    return { client, transport };
} catch {
    // Fall back to legacy SSE transport
    const client = new Client({ name: 'my-client', version: '1.0.0' });
    const transport = new SSEClientTransport(baseUrl);
    await client.connect(transport);
    return { client, transport };
}
```

The snippet above is the complete pattern; wrap the `catch` body with whatever error reporting your host needs.

### Protocol version negotiation (2026-07-28 revision)

By default the client negotiates a 2025-era protocol version via the `initialize` handshake — exactly the v1.x behavior, byte for byte. To talk to a server on the 2026-07-28 revision, opt into version negotiation via `ClientOptions.versionNegotiation`:

```ts source="../examples/guides/clientGuide.examples.ts#Client_versionNegotiation"
// Auto-negotiate: probe with server/discover, fall back to the 2025 handshake
// against a 2025-only server.
const client = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(transport);

client.getProtocolEra(); // 'modern' or 'legacy'
client.getNegotiatedProtocolVersion(); // '2026-07-28' or '2025-11-25'
```

- **absent / `mode: 'legacy'` (the default)** — today's 2025 connect sequence; no probe, no new headers.
- **`mode: 'auto'`** — `connect()` probes with `server/discover`; a 2025-only server rejects the probe and the client falls back to the plain `initialize` handshake on the same connection, byte-equivalent to a 2025 client. The probe costs one round trip against an old server.
- **`mode: { pin: '2026-07-28' }`** — modern era at exactly that revision; no fallback. Against a 2025-only server `connect()` rejects with a typed error. Use `pin` where a silent downgrade would be worse than an error (tests, CI, servers you control).

Once a modern era is negotiated, the client automatically attaches the per-request `_meta` envelope (the reserved protocol-version / client-info / client-capabilities keys) to every outgoing request and notification. You can also configure negotiation pre-connect on an
already-constructed instance via `client.setVersionNegotiation()`. See the [2026-07-28 support guide › Probe policy](./migration/support-2026-07-28.md#probe-policy) for the full failure semantics and probe-timeout behavior.
The version lists come from `ClientOptions.supportedProtocolVersions`: under `'auto'`, its 2026-era entries form the modern offer (default: the SDK's modern list), and a list with no 2025-era entry removes the legacy fallback; `connect()` rejects with `SdkError(EraNegotiationFailed)` instead of downgrading. The same modern subset bounds the overlap check of `connect({ prior })`.

#### Skipping the probe: `connect({ prior })`

A gateway, proxy, or worker fleet that already knows the server's `server/discover` advertisement can skip the probe entirely. Pass a previously-obtained `DiscoverResult` via
`ConnectOptions.prior` and `connect()` adopts it directly with **zero round trips** — the 2026-07-28 protocol is stateless on HTTP, so once the advertisement is known there is nothing left to negotiate.

```ts source="../examples/guides/clientGuide.examples.ts#Client_connect_prior"
// Probe once (here via the 'auto'-mode connect), persist the result …
const bootstrap = new Client({ name: 'gateway', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await bootstrap.connect(new StreamableHTTPClientTransport(url));
const persisted = JSON.stringify(bootstrap.getDiscoverResult());

// … then every worker connects with zero round trips.
const worker = new Client({ name: 'worker', version: '1.0.0' });
await worker.connect(new StreamableHTTPClientTransport(url), { prior: JSON.parse(persisted) });
```

`client.getDiscoverResult()` returns the value that the `'auto'`/pinned probe path, an explicit `client.discover()` call, or a
prior `connect({ prior })` recorded; it round-trips through `JSON.stringify`/`JSON.parse`. `connect({ prior })` is **2026-07-28+ only** — it rejects with `SdkError(EraNegotiationFailed)` when the supplied result and the client share no modern revision. Only reuse a persisted
`DiscoverResult` across clients that present the **same authorization context** as the one that obtained it. See the [`gateway/` example](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/gateway/README.md) for the full probe-once / connect-many pattern with a server-side proof.

Unlike an `'auto'`/pinned connect, `connect({ prior })` never auto-opens a `subscriptions/listen` stream. Workers on this path are assumed request-only. A configured `listChanged` option registers its handlers but stays silent. Call [`client.listen(filter)`](#subscription-streams-2026-07-28) yourself if a prior-connected client should observe changes.

### Disconnecting

Call `await client.close()` to disconnect. Pending requests are rejected with a `CONNECTION_CLOSED` error.

For Streamable HTTP, terminate the server-side session first (per the MCP specification):

```ts source="../examples/guides/clientGuide.examples.ts#disconnect_streamableHttp"
await transport.terminateSession(); // notify the server (recommended)
await client.close();
```

For stdio, `client.close()` handles graceful process shutdown (closes stdin, then SIGTERM, then SIGKILL if needed).

### Server instructions

Servers can provide an `instructions` string during initialization that describes how to use them — cross-tool relationships, workflow patterns, and constraints (see [Instructions](https://modelcontextprotocol.io/specification/latest/basic/lifecycle#instructions) in the MCP
specification). Retrieve it after connecting and include it in the model's system prompt:

```ts source="../examples/guides/clientGuide.examples.ts#serverInstructions_basic"
const instructions = client.getInstructions();

const systemPrompt = ['You are a helpful assistant.', instructions].filter(Boolean).join('\n\n');

console.log(systemPrompt);
```

### Extension capabilities

The negotiated server capabilities include `extensions` — a map from extension identifier to that extension's settings object. Read it after connecting via `client.getServerCapabilities()`:

```ts source="../examples/guides/clientGuide.examples.ts#extensionCapabilities_read"
const extensions = client.getServerCapabilities()?.extensions ?? {};

if ('com.example/feature-flags' in extensions) {
    // Advertised on this connection; the entry's value is its settings object.
}
```

See [Extension capabilities](./server.md#extension-capabilities) in the server guide for the declaring side.

## Authentication

MCP servers can require authentication before accepting client connections (see [Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization) in the MCP specification). Pass an `AuthProvider` to `StreamableHTTPClientTransport`. The transport calls `token()` before every request and `onUnauthorized()` (if provided) on 401, then retries once.

### Bearer tokens

For servers that accept bearer tokens managed outside the SDK — API keys, tokens from a gateway or proxy, service-account credentials — implement only `token()`. With no `onUnauthorized()`, a 401 throws `UnauthorizedError` immediately:

```ts source="../examples/guides/clientGuide.examples.ts#auth_tokenProvider"
const authProvider: AuthProvider = { token: async () => getStoredToken() };

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });
```

See [`simpleTokenProvider.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/oauth/simpleTokenProvider.ts) for a complete runnable example.

### Client credentials

`ClientCredentialsProvider` handles the `client_credentials` grant flow for service-to-service communication:

```ts source="../examples/guides/clientGuide.examples.ts#auth_clientCredentials"
const authProvider = new ClientCredentialsProvider({
    clientId: 'my-service',
    clientSecret: 'my-secret'
});

const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });

await client.connect(transport);
```

### Private key JWT

`PrivateKeyJwtProvider` signs JWT assertions for the `private_key_jwt` token endpoint auth method, avoiding a shared client secret:

```ts source="../examples/guides/clientGuide.examples.ts#auth_privateKeyJwt"
const authProvider = new PrivateKeyJwtProvider({
    clientId: 'my-service',
    privateKey: pemEncodedKey,
    algorithm: 'RS256'
});

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });
```

For a runnable `client_credentials` example, see [`oauth-client-credentials/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/oauth-client-credentials/client.ts) — its README shows the `private_key_jwt` swap (the in-repo demo Authorization
Server only implements `client_secret_basic`/`client_secret_post`, so there is no runnable `private_key_jwt` leg).

### Full OAuth with user authorization

For user-facing applications, implement the `OAuthClientProvider` interface to handle the full authorization code flow (redirects, code verifiers, token storage, dynamic client registration). Key persisted
client credentials by the `ctx.issuer` passed to `clientInformation()` / `saveClientInformation()` so credentials registered with one authorization server are never sent to another:

```ts source="../examples/guides/clientGuide.examples.ts#auth_oauthClientProvider"
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

const provider = new MyOAuthProvider();
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
    authProvider: provider
});
```

The `connect()` call throws `UnauthorizedError` when authorization is needed — catch it, complete the browser flow, hand the callback query
to `transport.finishAuth()`, and reconnect. Passing the whole `URLSearchParams` lets the SDK extract `code` and validate the RFC 9207 `iss` parameter for you:

```ts source="../examples/guides/clientGuide.examples.ts#auth_finishAuth"
const client = new Client({ name: 'my-client', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
try {
    await client.connect(transport);
    return client;
} catch (error) {
    // With version negotiation, the connect-time 401 may surface wrapped as
    // SdkError(EraNegotiationFailed) whose .data.cause is the UnauthorizedError.
    const root = error instanceof UnauthorizedError ? error : (error as { data?: { cause?: unknown } }).data?.cause;
    if (!(root instanceof UnauthorizedError)) throw error;
    // The transport called redirectToAuthorization(); fall through to the browser callback.
}

const callbackUrl = await waitForCallback();
const params = new URL(callbackUrl).searchParams;

// The SDK does not validate `state` — compare it to the value your provider generated.
if (params.get('state') !== provider.lastState) throw new Error('state mismatch');

try {
    // Preferred: hand over the whole query — the SDK extracts `code` and
    // `iss`, validates `iss` (RFC 9207), and never surfaces callback-derived
    // `error`/`error_description` text on mismatch.
    await transport.finishAuth(params);
} catch (error) {
    if (error instanceof IssuerMismatchError) {
        // Mix-up attack: do NOT render params.get('error_description') to the user.
        throw new Error('Authorization failed: issuer mismatch');
    }
    throw error;
}

// Reconnect on a FRESH transport — a started transport cannot be restarted;
// OAuth state (tokens, verifier, discovery) lives on the provider, not the transport.
await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
return client;
```

For a complete working OAuth flow, see [`simpleOAuthClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/oauth/simpleOAuthClient.ts) and
[`simpleOAuthClientProvider.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/oauth/simpleOAuthClientProvider.ts).

Issuer validation also runs during discovery: the authorization server metadata's `issuer` must match the issuer identifier the well-known URL was built from (RFC 8414 §3.3), and a mismatch throws `IssuerMismatchError`
with `kind: 'metadata'` (the callback-leg RFC 9207 check above uses `kind: 'authorization_response'`). For authorization servers known to publish a mismatched `issuer`, both HTTP transports accept `skipIssuerMetadataValidation: true` (honoured when `authProvider` is an
`OAuthClientProvider`). This weakens mix-up protection, so leave it off unless you control the server. The migration guide's [Authorization-server mix-up defense](./migration/upgrade-to-v2.md#authorization-server-mix-up-defense-rfc-9207--rfc-8414-33--action-required) section
describes the full model.

#### Resource indicators (RFC 8707)

The SDK binds tokens to your MCP server with the RFC 8707 `resource` parameter automatically. When protected resource metadata (RFC 9728) is discovered, the metadata's `resource` value is checked against the server URL (same origin, path prefix; see
`checkResourceAllowed()`) and attached to the authorization redirect and every token request. When the server publishes no resource metadata, no `resource` parameter is sent.

Implement `validateResourceURL` on your provider to override the selection. Return a URL to force a specific `resource` value, or `undefined` to omit the parameter:

```ts source="../examples/guides/clientGuide.examples.ts#auth_validateResourceURL"
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

`checkResourceAllowed` and `resourceUrlFromServerUrl` are exported from `@modelcontextprotocol/client` for custom implementations.

### Cross-App Access (Enterprise Managed Authorization)

`CrossAppAccessProvider` implements Enterprise Managed Authorization (SEP-990) for scenarios where users authenticate with an enterprise identity provider (IdP) and clients need to access
protected MCP servers on their behalf.

This provider handles a two-step OAuth flow:

1. Exchange the user's ID Token from the enterprise IdP for a JWT Authorization Grant (JAG) via RFC 8693 token exchange
2. Exchange the JAG for an access token from the MCP server via RFC 7523 JWT bearer grant

```ts source="../examples/guides/clientGuide.examples.ts#auth_crossAppAccess"
const authProvider = new CrossAppAccessProvider({
    assertion: async ctx => {
        // ctx provides: authorizationServerUrl, resourceUrl, scope, fetchFn
        const result = await discoverAndRequestJwtAuthGrant({
            idpUrl: 'https://idp.example.com',
            audience: ctx.authorizationServerUrl,
            resource: ctx.resourceUrl,
            idToken: await getIdToken(),
            clientId: 'my-idp-client',
            clientSecret: 'my-idp-secret',
            scope: ctx.scope,
            fetchFn: ctx.fetchFn
        });
        return result.jwtAuthGrant;
    },
    clientId: 'my-mcp-client',
    clientSecret: 'my-mcp-secret'
});

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });
```

The `assertion` callback receives a context object with:

- `authorizationServerUrl` – The MCP server's authorization server (discovered automatically)
- `resourceUrl` – The MCP resource URL (discovered automatically)
- `scope` – Optional scope passed to `auth()` or from `clientMetadata`
- `fetchFn` – Fetch implementation to use for HTTP requests

For manual control over the token exchange steps, use the Layer 2 utilities from `@modelcontextprotocol/client`:

- `requestJwtAuthorizationGrant()` – Exchange ID Token for JAG at IdP
- `discoverAndRequestJwtAuthGrant()` – Discovery + JAG acquisition
- `exchangeJwtAuthGrant()` – Exchange JAG for access token at MCP server

> [!NOTE]
> See [RFC 8693 (Token Exchange)](https://datatracker.ietf.org/doc/html/rfc8693), [RFC 7523 (JWT Bearer Grant)](https://datatracker.ietf.org/doc/html/rfc7523), and [RFC 9728 (Resource Discovery)](https://datatracker.ietf.org/doc/html/rfc9728) for the underlying OAuth
> standards.

## Tools

Tools are callable actions offered by servers — discovering and invoking them is usually how your client enables an LLM to take action (see [Tools](https://modelcontextprotocol.io/docs/learn/server-concepts#tools) in the MCP overview).

Use `listTools()` to discover available tools, and `callTool()` to invoke one. `listTools()` walks every page on your behalf and returns
the complete list (pass an explicit `{ cursor }` for per-page control):

```ts source="../examples/guides/clientGuide.examples.ts#callTool_basic"
const { tools } = await client.listTools();
console.log(
    'Available tools:',
    tools.map(t => t.name)
);

const result = await client.callTool({
    name: 'calculate-bmi',
    arguments: { weightKg: 70, heightM: 1.75 }
});
console.log(result.content);
```

The aggregate walk is capped at `ClientOptions.listMaxPages` pages (default 64; `0` disables the cap). If a server's pagination never terminates, the call rejects with `SdkError` code `LIST_PAGINATION_EXCEEDED`. The same applies to `listPrompts()`, `listResources()`, and `listResourceTemplates()`.

Tool results may include a `structuredContent` field — a machine-readable JSON value (any JSON type per SEP-2106) for programmatic use by the client application, complementing `content` which is for the LLM:

```ts source="../examples/guides/clientGuide.examples.ts#callTool_structuredOutput"
const result = await client.callTool({
    name: 'calculate-bmi',
    arguments: { weightKg: 70, heightM: 1.75 }
});

// Machine-readable output for the client application. SEP-2106: structuredContent is
// `unknown` (any JSON value). Check for presence with `!== undefined` and narrow before use.
if (result.structuredContent !== undefined) {
    const sc: unknown = result.structuredContent; // e.g. { bmi: 22.86 }
    if (typeof sc === 'object' && sc !== null && 'bmi' in sc) {
        console.log(sc.bmi);
    }
}
```

### Tracking progress

Pass `onprogress` to receive incremental progress notifications from long-running tools. Use `resetTimeoutOnProgress` to keep the request alive while the server is actively reporting, and `maxTotalTimeout` as an absolute cap:

```ts source="../examples/guides/clientGuide.examples.ts#callTool_progress"
const result = await client.callTool(
    { name: 'long-operation', arguments: {} },
    {
        onprogress: ({ progress, total }: { progress: number; total?: number }) => {
            console.log(`Progress: ${progress}/${total ?? '?'}`);
        },
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 600_000
    }
);
console.log(result.content);
```

### `x-mcp-header` parameter mirroring (2026-07-28 draft)

On a 2026-07-28 connection over Streamable HTTP, `callTool()` mirrors any argument whose `inputSchema` property carries an `x-mcp-header` annotation into an `Mcp-Param-{Name}` HTTP request header so intermediaries can route on it without parsing the body. The mirrored headers
are built from the client's cached `tools/list` result (see [Response caching](#response-caching-2026-07-28-draft)); if you already hold the tool definition (e.g. from configuration), pass it via `CallToolRequestOptions.toolDefinition` so mirroring runs without a prior list.
On a cache miss the call is sent without `Mcp-Param-*` headers
and, when a conforming server rejects it with `-32020` (`HeaderMismatch`), `callTool()` refreshes the definition cache once and retries.

On a non-stdio modern connection `listTools()` (and the internal `tools/list` cache) exclude tool definitions whose `x-mcp-header` declarations violate the spec's constraints, logging a warning that names the tool and the reason. Browser clients skip mirroring (dynamically named
headers cannot be statically allow-listed for credentialed CORS), so calling an `x-mcp-header` tool with a non-null designated argument from a browser against a server that enforces SEP-2243 validation will be rejected — a known limitation. The legacy-era `callTool`/`listTools`
paths are unchanged.

## Resources

Resources are read-only data — files, database schemas, configuration — that your application can retrieve from a server and attach as context for the model (see [Resources](https://modelcontextprotocol.io/docs/learn/server-concepts#resources) in the MCP overview).

Use `listResources()` and `readResource()` to discover and read server-provided data. `listResources()` walks every page on your
behalf and returns the complete list (pass an explicit `{ cursor }` for per-page control):

```ts source="../examples/guides/clientGuide.examples.ts#readResource_basic"
const { resources } = await client.listResources();
console.log(
    'Available resources:',
    resources.map(r => r.name)
);

const { contents } = await client.readResource({ uri: 'config://app' });
for (const item of contents) {
    console.log(item);
}
```

To discover URI templates for dynamic resources, use `listResourceTemplates()`.

### Subscribing to resource changes

If the server supports resource subscriptions, use `subscribeResource()` to receive notifications when a resource changes, then re-read it:

```ts source="../examples/guides/clientGuide.examples.ts#subscribeResource_basic"
await client.subscribeResource({ uri: 'config://app' });

client.setNotificationHandler('notifications/resources/updated', async notification => {
    if (notification.params.uri === 'config://app') {
        const { contents } = await client.readResource({ uri: 'config://app' });
        console.log('Config updated:', contents);
    }
});

// Later: stop receiving updates
await client.unsubscribeResource({ uri: 'config://app' });
```

> [!NOTE]
> `resources/subscribe` is a 2025-era method. On a 2026-07-28 connection, `subscribeResource()` throws a typed `SdkError` (`MethodNotSupportedByProtocolVersion`); request per-resource updates through the `resourceSubscriptions` field of a
> [subscription stream](#subscription-streams-2026-07-28) instead. The `notifications/resources/updated` handler is identical on both paths.

## Prompts

Prompts are reusable message templates that servers offer to help structure interactions with models (see [Prompts](https://modelcontextprotocol.io/docs/learn/server-concepts#prompts) in the MCP overview).

Use `listPrompts()` and `getPrompt()` to list available prompts and retrieve them with arguments. `listPrompts()` walks every page on
your behalf and returns the complete list (pass an explicit `{ cursor }` for per-page control):

```ts source="../examples/guides/clientGuide.examples.ts#getPrompt_basic"
const { prompts } = await client.listPrompts();
console.log(
    'Available prompts:',
    prompts.map(p => p.name)
);

const { messages } = await client.getPrompt({
    name: 'review-code',
    arguments: { code: 'console.log("hello")' }
});
console.log(messages);
```

## Completions

Both prompts and resources can support argument completions. Use `complete()` to request autocompletion suggestions from the server as a user types:

```ts source="../examples/guides/clientGuide.examples.ts#complete_basic"
const { completion } = await client.complete({
    ref: {
        type: 'ref/prompt',
        name: 'review-code'
    },
    argument: {
        name: 'language',
        value: 'type'
    }
});
console.log(completion.values); // e.g. ['typescript']
```

## Response caching (2026-07-28 draft)

On a 2026-07-28 connection, the cacheable results (`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `server/discover`) carry `ttlMs` / `cacheScope` freshness hints (SEP-2549). The client honours them automatically: `listTools()`,
`listPrompts()`, `listResources()`, `listResourceTemplates()`, and `readResource()` serve a still-fresh cached result without a round trip. `ttlMs` is capped at 24 hours (`MAX_CACHE_TTL_MS`); a missing or zero `ttlMs` means the result is never
served from cache, so against servers that don't send hints (including all 2025-era servers), nothing changes.

Override the disposition per call with `cacheMode`:

```ts source="../examples/guides/clientGuide.examples.ts#responseCache_basic"
const tools = await client.listTools(); // network, then cached for the server's ttlMs
const again = await client.listTools(); // served from cache while still fresh

await client.listTools(undefined, { cacheMode: 'refresh' }); // always refetch and re-store
await client.readResource({ uri: 'config://app' }, { cacheMode: 'bypass' }); // no cache read or write
```

`'bypass'` leaves the cache byte-untouched, including the internal `tools/list` entry that [`x-mcp-header` parameter mirroring](#x-mcp-header-parameter-mirroring-2026-07-28-draft) and output-schema validation read. Cached entries are evicted automatically when the server
signals a change: a `list_changed` notification drops the matching list entries, and `notifications/resources/updated` drops the cached body for that URI (see [Notifications](#notifications)).

Three `ClientOptions` fields tune the behavior:

- **`responseCacheStore`**: the backing store; defaults to a per-client `InMemoryResponseCacheStore` (at most 512 `resources/read` entries by default). Supply your own `ResponseCacheStore` implementation (the interface is async-ready, so a
  Redis-style store fits) to persist entries or share one store across clients. Entries are keyed by connected-server identity, so co-tenants never collide.
- **`cachePartition`**: opaque per-principal identifier (e.g. the auth subject) isolating `'private'`-scoped entries when one store serves several principals. `'public'`-scoped entries are shared within a server's namespace; `'private'` ones never cross partitions.
- **`defaultCacheTtlMs`**: TTL applied when a result arrives without `ttlMs` (any legacy-era response, for example). The default `0` means such results are never served from cache; list results are still stored (already stale) so the `tools/list`-derived index behind
  mirroring and output validation keeps working, while `resources/read` bodies with a resolved TTL of `0` are not stored at all. Raise it to enable TTL caching against servers that don't send hints.

> [!IMPORTANT]
> When one `responseCacheStore` is shared across users, always set `cachePartition` per principal. Without it, one user's `'private'`-scoped resource bodies can be served to another.

## Notifications

### Automatic list-change tracking

The `listChanged` client option keeps a local cache of tools, prompts, or resources in sync with the server. It provides automatic server capability gating, debouncing (300 ms by default), auto-refresh, and
error-first callbacks:

```ts source="../examples/guides/clientGuide.examples.ts#listChanged_basic"
const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        listChanged: {
            tools: {
                onChanged: (error, tools) => {
                    if (error) {
                        console.error('Failed to refresh tools:', error);
                        return;
                    }
                    console.log('Tools updated:', tools);
                }
            },
            prompts: {
                onChanged: (error, prompts) => console.log('Prompts updated:', prompts)
            }
        }
    }
);
```

`listChanged` is era-transparent: on a 2025-era connection it is fed by unsolicited notifications; on a 2026-07-28 connection the SDK [auto-opens a subscription stream](#subscription-streams-2026-07-28) for the configured types.

### Manual notification handlers

For full control — or for notification types not covered by `listChanged` (such as log messages) — register handlers directly with `setNotificationHandler()`:

```ts source="../examples/guides/clientGuide.examples.ts#notificationHandler_basic"
// Server log messages (sent by the server during request processing)
client.setNotificationHandler('notifications/message', notification => {
    const { level, data } = notification.params;
    console.log(`[${level}]`, data);
});

// Server's resource list changed — re-fetch the list
client.setNotificationHandler('notifications/resources/list_changed', async () => {
    const { resources } = await client.listResources();
    console.log('Resources changed:', resources.length);
});
```

> [!WARNING]
> MCP logging (including `setLoggingLevel()` and `notifications/message`) is deprecated as of protocol version 2026-07-28 (SEP-2577); see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated). It remains fully functional on
> 2025-era connections during the deprecation window (at least twelve months); on the 2026-07-28 revision the log level travels per request instead (see below). Servers should migrate to stderr logging (STDIO) or OpenTelemetry.

To control the minimum severity of log messages the server sends, use `setLoggingLevel()`:

```ts source="../examples/guides/clientGuide.examples.ts#setLoggingLevel_basic"
await client.setLoggingLevel('warning');
```

`logging/setLevel` is not part of the 2026-07-28 revision, so on a connection that negotiated a modern era (see [Protocol version negotiation](#protocol-version-negotiation-2026-07-28-revision)) `setLoggingLevel()` rejects with `SdkError(MethodNotSupportedByProtocolVersion)`. On 2026-07-28 connections the level is declared **per request** instead: set the `io.modelcontextprotocol/logLevel` `_meta` key (exported as `LOG_LEVEL_META_KEY`) on each request you want logs for. When the key is absent, the server sends no `notifications/message` for that request; the client never attaches it automatically.

```ts source="../examples/guides/clientGuide.examples.ts#logLevelMeta_modern"
const result = await client.callTool({
    name: 'fetch-data',
    arguments: { url: 'https://example.com' },
    _meta: { [LOG_LEVEL_META_KEY]: 'debug' }
});
```

Messages arrive through the same `notifications/message` handler shown above. See the [2026-07-28 support guide](./migration/support-2026-07-28.md#ctxmcpreqlog-and-the-per-request-loglevel) for the server-side semantics.

> [!WARNING]
> `listChanged` and `setNotificationHandler()` resolve per notification type by last registration wins: `listChanged` installs its handler during `connect()`, so a manual handler registered
> after connecting silently disables `listChanged` for that type, and one registered before connecting is overwritten by it.

### Subscription streams (2026-07-28)

On a 2026-07-28 connection the server delivers change notifications only on a `subscriptions/listen` stream the client opens: nothing arrives unsolicited. The `listChanged` option handles this transparently: on a modern connection it auto-opens a stream whose filter is the
intersection of the configured sub-options and the server's advertised capabilities (the handle is exposed as `autoOpenedSubscription`). To open a stream explicitly, use `listen()`:

```ts source="../examples/guides/clientGuide.examples.ts#listen_basic"
client.setNotificationHandler('notifications/tools/list_changed', async () => {
    const { tools } = await client.listTools();
    console.log('Tools changed:', tools.length);
});
client.setNotificationHandler('notifications/resources/updated', async notification => {
    console.log('Resource updated:', notification.params.uri);
});

const subscription = await client.listen({
    toolsListChanged: true,
    resourceSubscriptions: ['config://app']
});
console.log('Server honored:', subscription.honoredFilter);

// Later: tear the stream down
await subscription.close();
```

`listen()` resolves once the server acknowledges the subscription. `honoredFilter` is the capability-gated subset the server agreed to deliver (e.g. `resourceSubscriptions` requires the server to advertise `resources: { subscribe: true }`). Notifications on the stream
dispatch to the same `setNotificationHandler` registrations as 2025-era unsolicited notifications.

There is no automatic re-listen. `subscription.closed` resolves exactly once (it never rejects) with the reason: `'local'` (you called `close()`), `'graceful'` (the server ended the subscription deliberately, e.g. on shutdown), or `'remote'` (unexpected disconnect). A watch
loop re-listens on unexpected closes:

```ts source="../examples/guides/clientGuide.examples.ts#listen_watchLoop"
while (watching) {
    const sub = await client.listen({ resourceSubscriptions: ['config://app'] });
    const reason = await sub.closed;
    if (reason !== 'remote') break; // 'local' or 'graceful': done
    await new Promise(resolve => setTimeout(resolve, 1000)); // back off, then re-listen
}
```

On a 2025-era connection `listen()` throws a typed error steering to [`subscribeResource()`](#subscribing-to-resource-changes) and `listChanged`. See the
[2026-07-28 support guide › `subscriptions/listen`](./migration/support-2026-07-28.md#subscriptionslisten) for migration-level detail, and [`subscriptions/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/subscriptions/client.ts) for a
runnable example of both watch styles.

## Handling server-initiated requests

MCP is bidirectional — servers can send requests _to_ the client during tool execution, as long as the client declares matching capabilities (see [Architecture](https://modelcontextprotocol.io/docs/learn/architecture) in the MCP overview). Declare the corresponding capability
when constructing the `Client` and register a request handler:

```ts source="../examples/guides/clientGuide.examples.ts#capabilities_declaration"
const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        capabilities: {
            sampling: {},
            elicitation: { form: {} },
            roots: { listChanged: true }
        }
    }
);
```

On 2025-era connections these arrive as server→client JSON-RPC requests. On a 2026-07-28 connection there is no server→client request channel: the server answers `tools/call` / `prompts/get` / `resources/read` with an `input_required` result instead, and the client fulfils
the embedded requests automatically through the same handlers you register below, then retries the call with the collected responses and a byte-exact echo of the server's opaque `requestState`. `callTool()` and its siblings keep returning their plain result: the interactive
rounds happen inside the call, capped at `maxRounds` (default 10), after which the call rejects with a typed `INPUT_REQUIRED_ROUNDS_EXCEEDED` error. Configure or disable this via
`ClientOptions.inputRequired` (`{ autoFulfill?: boolean; maxRounds?: number }`); see [Manual multi-round-trip handling](#manual-multi-round-trip-handling-2026-07-28) for the opt-out flow. Handlers are era-transparent: register once for both delivery paths.

### Sampling

> [!WARNING]
> Sampling is deprecated as of protocol version 2026-07-28 (SEP-2577). It remains fully functional during the deprecation window (at least twelve months); see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated). Servers
> should migrate to calling LLM provider APIs directly.

When a server needs an LLM completion during tool execution, it sends a `sampling/createMessage` request to the client (see [Sampling](https://modelcontextprotocol.io/docs/learn/client-concepts#sampling) in the MCP overview). Register a handler to fulfill it:

```ts source="../examples/guides/clientGuide.examples.ts#sampling_handler"
client.setRequestHandler('sampling/createMessage', async request => {
    const lastMessage = request.params.messages.at(-1);
    console.log('Sampling request:', lastMessage);

    // In production, send messages to your LLM here
    return {
        model: 'my-model',
        role: 'assistant' as const,
        content: {
            type: 'text' as const,
            text: 'Response from the model'
        }
    };
});
```

### Elicitation

When a server needs user input during tool execution, it sends an `elicitation/create` request to the client (see [Elicitation](https://modelcontextprotocol.io/docs/learn/client-concepts#elicitation) in the MCP overview). The client should present the form to the user and return
the collected data, or `{ action: 'decline' }`:

```ts source="../examples/guides/clientGuide.examples.ts#elicitation_handler"
client.setRequestHandler('elicitation/create', async request => {
    console.log('Server asks:', request.params.message);

    if (request.params.mode === 'form') {
        // Present the schema-driven form to the user
        console.log('Schema:', request.params.requestedSchema);
        return { action: 'accept', content: { confirm: true } };
    }

    return { action: 'decline' };
});
```

For a full form-based elicitation handler with AJV validation, see [`repl/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/repl/client.ts). For URL elicitation mode (both the 2025-era push/throw style and the 2026-07-28 `inputRequired`
return), see [`elicitation/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/elicitation/client.ts).

### Roots

> [!WARNING]
> Roots are deprecated as of protocol version 2026-07-28 (SEP-2577). They remain fully functional during the deprecation window (at least twelve months); see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated). Migrate to
> passing paths via tool parameters, resource URIs, or configuration.

Roots let the client expose filesystem boundaries to the server (see [Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots) in the MCP overview). Declare the `roots` capability and register a `roots/list` handler:

```ts source="../examples/guides/clientGuide.examples.ts#roots_handler"
client.setRequestHandler('roots/list', async () => {
    return {
        roots: [
            { uri: 'file:///home/user/projects/my-app', name: 'My App' },
            { uri: 'file:///home/user/data', name: 'Data' }
        ]
    };
});
```

When the available roots change, notify the server with `client.sendRootsListChanged()`.

### Manual multi-round-trip handling (2026-07-28)

Hosts that surface input requests through their own UI loop can take over the rounds themselves. Set `inputRequired: { autoFulfill: false }`. An `input_required` response then surfaces as a typed error unless the call passes `allowInputRequired: true` to receive the raw
result. Retry with top-level `inputResponses` and a byte-exact `requestState` echo:

```ts source="../examples/guides/clientGuide.examples.ts#inputRequired_manual"
const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' },
        inputRequired: { autoFulfill: false }
    }
);
await client.connect(transport);

const value = (await client.request(
    { method: 'tools/call', params: { name: 'deploy', arguments: { env: 'prod' } } },
    { allowInputRequired: true }
)) as CallToolResult | InputRequiredResult;

if (isInputRequiredResult(value)) {
    // Collect responses for value.inputRequests from your UI, then retry:
    await client.request(
        {
            method: 'tools/call',
            params: {
                name: 'deploy',
                arguments: { env: 'prod' },
                inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
                requestState: value.requestState // echo byte-exact
            }
        },
        { allowInputRequired: true }
    );
}
```

The manual retry goes through `client.request()` rather than `callTool()`: `inputResponses` and `requestState` are not fields of the typed `CallToolRequest` params. On the explicit-schema `request()` path, wrap the result schema with `withInputRequired()` so both outcomes are typed and validated. For the full loop (including URL-mode elicitation), see [`mrtr/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/mrtr/client.ts).

## Error handling

### Tool errors vs protocol errors

`callTool()` has two error surfaces: the tool can _run but report failure_ via `isError: true` in the result, or the _request itself can fail_ and throw an exception. Always check both:

```ts source="../examples/guides/clientGuide.examples.ts#errorHandling_toolErrors"
try {
    const result = await client.callTool({
        name: 'fetch-data',
        arguments: { url: 'https://example.com' }
    });

    // Tool-level error: the tool ran but reported a problem
    if (result.isError) {
        console.error('Tool error:', result.content);
        return;
    }

    console.log('Success:', result.content);
} catch (error) {
    // Protocol-level error: the request itself failed
    if (error instanceof ProtocolError) {
        console.error(`Protocol error ${error.code}: ${error.message}`);
    } else if (error instanceof SdkError) {
        console.error(`SDK error [${error.code}]: ${error.message}`);
    } else {
        throw error;
    }
}
```

`ProtocolError` represents JSON-RPC errors from the server (method not found, invalid params, internal error). `SdkError` represents local SDK errors — `REQUEST_TIMEOUT`, `CONNECTION_CLOSED`, `CAPABILITY_NOT_SUPPORTED`, and others. The `SdkErrorCode` enum is the complete vocabulary; the [error mapping table](./migration/upgrade-to-v2.md#sdkerrorcode-enum-complete) in the upgrade guide describes when each
code is raised.

### Connection lifecycle

Set `client.onerror` to catch out-of-band transport errors (SSE disconnects, parse errors). Set `client.onclose` to detect when the
connection drops — pending requests are rejected with a `CONNECTION_CLOSED` error:

```ts source="../examples/guides/clientGuide.examples.ts#errorHandling_lifecycle"
// Out-of-band errors (SSE disconnects, parse errors)
client.onerror = error => {
    console.error('Transport error:', error.message);
};

// Connection closed (pending requests are rejected with CONNECTION_CLOSED)
client.onclose = () => {
    console.log('Connection closed');
};
```

### Timeouts

All requests have a 60-second default timeout. Pass a custom `timeout` in the options to override it. On timeout, the SDK sends a cancellation notification to the server (on a 2026-07-28 Streamable HTTP connection the per-request stream is aborted instead, which is the
spec's cancellation signal) and rejects the promise with `SdkErrorCode.RequestTimeout`:

```ts source="../examples/guides/clientGuide.examples.ts#errorHandling_timeout"
try {
    const result = await client.callTool(
        { name: 'slow-operation', arguments: {} },
        { timeout: 120_000 } // 2 minutes instead of the default 60 seconds
    );
    console.log(result.content);
} catch (error) {
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        console.error('Request timed out');
    }
}
```

### HTTP transport errors

When an HTTP transport request fails with a non-OK status, the SDK throws `SdkHttpError`, an `SdkError` subclass with typed `data` (`{ status, statusText? }`) and `status`/`statusText` getters, so you can branch on the status without casting. The codes are the `ClientHttp*` members of `SdkErrorCode`: e.g. `CLIENT_HTTP_AUTHENTICATION` (a 401 persisting after re-authentication), `CLIENT_HTTP_FORBIDDEN` (a 403 `insufficient_scope` after the step-up
retry cap), `CLIENT_HTTP_FAILED_TO_OPEN_STREAM`. (Exception: an unexpected response content type throws a plain `SdkError` with code `CLIENT_HTTP_UNEXPECTED_CONTENT`.)

```ts source="../examples/guides/clientGuide.examples.ts#errorHandling_http"
try {
    await client.connect(transport);
} catch (error) {
    if (error instanceof SdkHttpError) {
        console.error(`HTTP ${error.status} (${error.statusText ?? ''}) [${error.code}]`);
    } else {
        throw error;
    }
}
```

## Client middleware

Use `createMiddleware()` and `applyMiddlewares()` to compose fetch middleware pipelines. Middleware wraps the underlying `fetch`
call and can add headers, handle retries, or log requests. Pass the enhanced fetch to the transport via the `fetch` option:

```ts source="../examples/guides/clientGuide.examples.ts#middleware_basic"
const authMiddleware = createMiddleware(async (next, input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Custom-Header', 'my-value');
    return next(input, { ...init, headers });
});

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
    fetch: applyMiddlewares(authMiddleware)(fetch)
});
```

## Trace context propagation

The MCP specification ([SEP-414](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/414)) reserves the unprefixed `_meta` keys `traceparent`, `tracestate`, and `baggage` for distributed trace context, as an exception to the usual `_meta` key prefix rule. When
present, the values must follow the [W3C Trace Context](https://www.w3.org/TR/trace-context/) and [W3C Baggage](https://www.w3.org/TR/baggage/) formats. The SDK does not interpret these keys — `_meta` passes through both directions untouched — so you can propagate OpenTelemetry
context across any transport, including stdio where HTTP headers are unavailable. The key names are exported as `TRACEPARENT_META_KEY`, `TRACESTATE_META_KEY`, and `BAGGAGE_META_KEY`.

Attach trace context to a single request via `_meta`:

```ts source="../examples/guides/clientGuide.examples.ts#traceContext_perRequest"
// Values would normally come from your tracer's active span context.
const result = await client.callTool({
    name: 'calculate-bmi',
    arguments: { weightKg: 70, heightM: 1.75 },
    _meta: {
        [TRACEPARENT_META_KEY]: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        [TRACESTATE_META_KEY]: 'vendor1=opaqueValue1'
    }
});
console.log(result.content);
```

Or inject it into every outgoing request with fetch middleware (Streamable HTTP transport):

```ts source="../examples/guides/clientGuide.examples.ts#traceContext_middleware"
const traceContextMiddleware = createMiddleware(async (next, input, init) => {
    if (typeof init?.body !== 'string') {
        return next(input, init);
    }
    const message = JSON.parse(init.body) as {
        method?: string;
        params?: { _meta?: Record<string, unknown>; [key: string]: unknown };
    };
    // Only requests and notifications carry params._meta; skip responses.
    if (message.method === undefined) {
        return next(input, init);
    }
    message.params = {
        ...message.params,
        _meta: {
            ...message.params?._meta,
            // Replace with values from your tracer's active span context.
            [TRACEPARENT_META_KEY]: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
        }
    };
    return next(input, { ...init, body: JSON.stringify(message) });
});

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
    fetch: applyMiddlewares(traceContextMiddleware)(fetch)
});
```

On the server side, handlers can read the incoming trace context from `ctx.mcpReq._meta` — see the [server guide](./server.md#trace-context-propagation).

## Resumption tokens

When using SSE-based streaming, the server can assign event IDs. Pass `onresumptiontoken` to track them, and `resumptionToken` to resume from where you left off after a disconnection:

```ts source="../examples/guides/clientGuide.examples.ts#resumptionToken_basic"
let lastToken: string | undefined;

const result = await client.request(
    {
        method: 'tools/call',
        params: { name: 'long-running-operation', arguments: {} }
    },
    {
        resumptionToken: lastToken,
        onresumptiontoken: (token: string) => {
            lastToken = token;
            // Persist token to survive restarts
        }
    }
);
console.log(result);
```

For an end-to-end example of server-initiated SSE disconnection and automatic client reconnection with event replay, see [`sse-polling/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/sse-polling/client.ts).

## See also

- [`examples/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples) — Full runnable client examples
- [Server guide](./server.md) — Building MCP servers with this SDK
- [MCP overview](https://modelcontextprotocol.io/docs/learn/architecture) — Protocol-level concepts: participants, layers, primitives
- [Migration guide](./migration/index.md) — Upgrading from previous SDK versions
- [FAQ](./faq.md) — Frequently asked questions and troubleshooting

### Additional examples

| Feature                       | Description                                                                  | Example                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Parallel tool calls           | Run multiple tool calls concurrently via `Promise.all`                       | [`parallel-calls/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/parallel-calls/client.ts)   |
| SSE disconnect / reconnection | Server-initiated SSE disconnect with automatic reconnection and event replay | [`sse-polling/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/sse-polling/client.ts)         |
| Multiple clients              | Independent client lifecycles to the same server                             | [`parallel-calls/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/parallel-calls/client.ts)   |
| URL elicitation               | Handle sensitive data collection via browser                                 | [`elicitation/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/elicitation/client.ts)         |
| Subscription streams          | Auto-opened and manual `subscriptions/listen` streams (2026-07-28)           | [`subscriptions/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/subscriptions/client.ts)     |
| Multi-round-trip input        | Auto-fulfilled and manual `input_required` flows (2026-07-28)                | [`mrtr/client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/mrtr/client.ts)                       |
