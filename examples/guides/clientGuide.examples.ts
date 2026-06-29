/**
 * Type-checked examples for docs/client.md.
 *
 * Regions are synced into markdown code fences via `pnpm sync:snippets`.
 * Each function wraps a single region. The function name matches the region name.
 *
 * @module
 */

//#region imports
import type {
    AuthProvider,
    OAuthClientInformationContext,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthClientProvider,
    OAuthDiscoveryState,
    OAuthTokens
} from '@modelcontextprotocol/client';
import {
    applyMiddlewares,
    Client,
    ClientCredentialsProvider,
    createMiddleware,
    CrossAppAccessProvider,
    discoverAndRequestJwtAuthGrant,
    IssuerMismatchError,
    PrivateKeyJwtProvider,
    ProtocolError,
    SdkError,
    SdkErrorCode,
    SSEClientTransport,
    StreamableHTTPClientTransport,
    TRACEPARENT_META_KEY,
    TRACESTATE_META_KEY,
    UnauthorizedError
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
//#endregion imports

// ---------------------------------------------------------------------------
// Connecting to a server
// ---------------------------------------------------------------------------

/** Example: Streamable HTTP transport. */
async function connect_streamableHttp() {
    //#region connect_streamableHttp
    const client = new Client({ name: 'my-client', version: '1.0.0' });

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

    await client.connect(transport);
    //#endregion connect_streamableHttp
}

/** Example: stdio transport for local process-spawned servers. */
async function connect_stdio() {
    //#region connect_stdio
    const client = new Client({ name: 'my-client', version: '1.0.0' });

    const transport = new StdioClientTransport({
        command: 'node',
        args: ['server.js']
    });

    await client.connect(transport);
    //#endregion connect_stdio
}

/** Example: Try Streamable HTTP, fall back to legacy SSE. */
async function connect_sseFallback(url: string) {
    //#region connect_sseFallback
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
    //#endregion connect_sseFallback
}

/** Example: Opt into 2026-07-28 protocol version negotiation. */
async function Client_versionNegotiation(transport: StreamableHTTPClientTransport) {
    //#region Client_versionNegotiation
    // Auto-negotiate: probe with server/discover, fall back to the 2025 handshake
    // against a 2025-only server.
    const client = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);

    client.getProtocolEra(); // 'modern' or 'legacy'
    client.getNegotiatedProtocolVersion(); // '2026-07-28' or '2025-11-25'
    //#endregion Client_versionNegotiation
}

/** Example: zero-round-trip connect from a persisted DiscoverResult. */
async function Client_connect_prior(url: URL) {
    //#region Client_connect_prior
    // Probe once (here via the 'auto'-mode connect), persist the result …
    const bootstrap = new Client({ name: 'gateway', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await bootstrap.connect(new StreamableHTTPClientTransport(url));
    const persisted = JSON.stringify(bootstrap.getDiscoverResult());

    // … then every worker connects with zero round trips.
    const worker = new Client({ name: 'worker', version: '1.0.0' });
    await worker.connect(new StreamableHTTPClientTransport(url), { prior: JSON.parse(persisted) });
    //#endregion Client_connect_prior
}

// ---------------------------------------------------------------------------
// Disconnecting
// ---------------------------------------------------------------------------

/** Example: Graceful disconnect for Streamable HTTP. */
async function disconnect_streamableHttp(client: Client, transport: StreamableHTTPClientTransport) {
    //#region disconnect_streamableHttp
    await transport.terminateSession(); // notify the server (recommended)
    await client.close();
    //#endregion disconnect_streamableHttp
}

// ---------------------------------------------------------------------------
// Server instructions
// ---------------------------------------------------------------------------

/** Example: Access server instructions after connecting. */
async function serverInstructions_basic(client: Client) {
    //#region serverInstructions_basic
    const instructions = client.getInstructions();

    const systemPrompt = ['You are a helpful assistant.', instructions].filter(Boolean).join('\n\n');

    console.log(systemPrompt);
    //#endregion serverInstructions_basic
}

// ---------------------------------------------------------------------------
// Extension capabilities
// ---------------------------------------------------------------------------

/** Example: Read the negotiated extension capabilities after connecting. */
function extensionCapabilities_read(client: Client) {
    //#region extensionCapabilities_read
    const extensions = client.getServerCapabilities()?.extensions ?? {};

    if ('com.example/feature-flags' in extensions) {
        // Advertised on this connection; the entry's value is its settings object.
    }
    //#endregion extensionCapabilities_read
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Example: Minimal AuthProvider for bearer auth with externally-managed tokens. */
async function auth_tokenProvider(getStoredToken: () => Promise<string>) {
    //#region auth_tokenProvider
    const authProvider: AuthProvider = { token: async () => getStoredToken() };

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });
    //#endregion auth_tokenProvider
    return transport;
}

/** Example: Client credentials auth for service-to-service communication. */
async function auth_clientCredentials() {
    //#region auth_clientCredentials
    const authProvider = new ClientCredentialsProvider({
        clientId: 'my-service',
        clientSecret: 'my-secret'
    });

    const client = new Client({ name: 'my-client', version: '1.0.0' });

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });

    await client.connect(transport);
    //#endregion auth_clientCredentials
}

/** Example: Private key JWT auth. */
async function auth_privateKeyJwt(pemEncodedKey: string) {
    //#region auth_privateKeyJwt
    const authProvider = new PrivateKeyJwtProvider({
        clientId: 'my-service',
        privateKey: pemEncodedKey,
        algorithm: 'RS256'
    });

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });
    //#endregion auth_privateKeyJwt
    return transport;
}

/** Example: Cross-App Access (SEP-990 Enterprise Managed Authorization). */
async function auth_crossAppAccess(getIdToken: () => Promise<string>) {
    //#region auth_crossAppAccess
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
    //#endregion auth_crossAppAccess
    return transport;
}

/**
 * Example: Minimal `OAuthClientProvider` for the authorization-code flow.
 * Client credentials are stored per authorization-server `issuer` (SEP-2352).
 */
function auth_oauthClientProvider(onRedirect: (url: URL) => void) {
    //#region auth_oauthClientProvider
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
    //#endregion auth_oauthClientProvider
    return { provider, transport };
}

/** Example: Handling the OAuth callback — extract `iss` for RFC 9207 validation. */
async function auth_finishAuth(url: URL, provider: OAuthClientProvider & { lastState?: string }, waitForCallback: () => Promise<string>) {
    //#region auth_finishAuth
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
    //#endregion auth_finishAuth
}

// ---------------------------------------------------------------------------
// Using server features
// ---------------------------------------------------------------------------

/** Example: List and call tools. */
async function callTool_basic(client: Client) {
    //#region callTool_basic
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
    //#endregion callTool_basic
}

/** Example: Structured tool output. */
async function callTool_structuredOutput(client: Client) {
    //#region callTool_structuredOutput
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
    //#endregion callTool_structuredOutput
}

/** Example: Track progress of a long-running tool call. */
async function callTool_progress(client: Client) {
    //#region callTool_progress
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
    //#endregion callTool_progress
}

/** Example: List and read resources. */
async function readResource_basic(client: Client) {
    //#region readResource_basic
    const { resources } = await client.listResources();
    console.log(
        'Available resources:',
        resources.map(r => r.name)
    );

    const { contents } = await client.readResource({ uri: 'config://app' });
    for (const item of contents) {
        console.log(item);
    }
    //#endregion readResource_basic
}

/** Example: Subscribe to resource changes. */
async function subscribeResource_basic(client: Client) {
    //#region subscribeResource_basic
    await client.subscribeResource({ uri: 'config://app' });

    client.setNotificationHandler('notifications/resources/updated', async notification => {
        if (notification.params.uri === 'config://app') {
            const { contents } = await client.readResource({ uri: 'config://app' });
            console.log('Config updated:', contents);
        }
    });

    // Later: stop receiving updates
    await client.unsubscribeResource({ uri: 'config://app' });
    //#endregion subscribeResource_basic
}

/** Example: List and get prompts. */
async function getPrompt_basic(client: Client) {
    //#region getPrompt_basic
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
    //#endregion getPrompt_basic
}

/** Example: Request argument completions. */
async function complete_basic(client: Client) {
    //#region complete_basic
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
    //#endregion complete_basic
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Example: Handle log messages and list-change notifications. */
function notificationHandler_basic(client: Client) {
    //#region notificationHandler_basic
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
    //#endregion notificationHandler_basic
}

/** Example: Control server log level. */
async function setLoggingLevel_basic(client: Client) {
    //#region setLoggingLevel_basic
    await client.setLoggingLevel('warning');
    //#endregion setLoggingLevel_basic
}

/** Example: Automatic list-change tracking via the listChanged option. */
async function listChanged_basic() {
    //#region listChanged_basic
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
    //#endregion listChanged_basic
    return client;
}

// ---------------------------------------------------------------------------
// Handling server-initiated requests
// ---------------------------------------------------------------------------

/** Example: Declare client capabilities for sampling and elicitation. */
function capabilities_declaration() {
    //#region capabilities_declaration
    const client = new Client(
        { name: 'my-client', version: '1.0.0' },
        {
            capabilities: {
                sampling: {},
                elicitation: { form: {} }
            }
        }
    );
    //#endregion capabilities_declaration
    return client;
}

/** Example: Handle a sampling request from the server. */
function sampling_handler(client: Client) {
    //#region sampling_handler
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
    //#endregion sampling_handler
}

/** Example: Handle an elicitation request from the server. */
function elicitation_handler(client: Client) {
    //#region elicitation_handler
    client.setRequestHandler('elicitation/create', async request => {
        console.log('Server asks:', request.params.message);

        if (request.params.mode === 'form') {
            // Present the schema-driven form to the user
            console.log('Schema:', request.params.requestedSchema);
            return { action: 'accept', content: { confirm: true } };
        }

        return { action: 'decline' };
    });
    //#endregion elicitation_handler
}

/** Example: Expose filesystem roots to the server. */
function roots_handler(client: Client) {
    //#region roots_handler
    client.setRequestHandler('roots/list', async () => {
        return {
            roots: [
                { uri: 'file:///home/user/projects/my-app', name: 'My App' },
                { uri: 'file:///home/user/data', name: 'Data' }
            ]
        };
    });
    //#endregion roots_handler
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/** Example: Tool errors vs protocol errors. */
async function errorHandling_toolErrors(client: Client) {
    //#region errorHandling_toolErrors
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
    //#endregion errorHandling_toolErrors
}

/** Example: Connection lifecycle callbacks. */
function errorHandling_lifecycle(client: Client) {
    //#region errorHandling_lifecycle
    // Out-of-band errors (SSE disconnects, parse errors)
    client.onerror = error => {
        console.error('Transport error:', error.message);
    };

    // Connection closed (pending requests are rejected with CONNECTION_CLOSED)
    client.onclose = () => {
        console.log('Connection closed');
    };
    //#endregion errorHandling_lifecycle
}

/** Example: Custom timeouts. */
async function errorHandling_timeout(client: Client) {
    //#region errorHandling_timeout
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
    //#endregion errorHandling_timeout
}

// ---------------------------------------------------------------------------
// Advanced patterns
// ---------------------------------------------------------------------------

/** Example: Client middleware that adds a custom header. */
async function middleware_basic() {
    //#region middleware_basic
    const authMiddleware = createMiddleware(async (next, input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('X-Custom-Header', 'my-value');
        return next(input, { ...init, headers });
    });

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
        fetch: applyMiddlewares(authMiddleware)(fetch)
    });
    //#endregion middleware_basic
    return transport;
}

/** Example: Attach W3C Trace Context to a single request via `_meta`. */
async function traceContext_perRequest(client: Client) {
    //#region traceContext_perRequest
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
    //#endregion traceContext_perRequest
}

/** Example: Client middleware that injects trace context into every outgoing request. */
async function traceContext_middleware() {
    //#region traceContext_middleware
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
    //#endregion traceContext_middleware
    return transport;
}

/** Example: Track resumption tokens for SSE reconnection. */
async function resumptionToken_basic(client: Client) {
    //#region resumptionToken_basic
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
    //#endregion resumptionToken_basic
}

// Suppress unused-function warnings (functions exist solely for type-checking)
void connect_streamableHttp;
void connect_stdio;
void connect_sseFallback;
void Client_versionNegotiation;
void disconnect_streamableHttp;
void serverInstructions_basic;
void extensionCapabilities_read;
void auth_tokenProvider;
void auth_clientCredentials;
void auth_privateKeyJwt;
void auth_crossAppAccess;
void callTool_basic;
void callTool_structuredOutput;
void callTool_progress;
void readResource_basic;
void subscribeResource_basic;
void getPrompt_basic;
void complete_basic;
void notificationHandler_basic;
void setLoggingLevel_basic;
void listChanged_basic;
void capabilities_declaration;
void sampling_handler;
void elicitation_handler;
void roots_handler;
void errorHandling_toolErrors;
void errorHandling_lifecycle;
void errorHandling_timeout;
void middleware_basic;
void traceContext_perRequest;
void traceContext_middleware;
void resumptionToken_basic;
