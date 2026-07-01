#!/usr/bin/env node

/**
 * Everything client - a single conformance test client that handles all scenarios.
 *
 * Usage: everything-client <server-url>
 *
 * The scenario name is read from the MCP_CONFORMANCE_SCENARIO environment variable,
 * which is set by the conformance test runner.
 *
 * This client routes to the appropriate behavior based on the scenario name,
 * consolidating all the individual test clients into one.
 */

import {
    Client,
    ClientCredentialsProvider,
    CrossAppAccessProvider,
    PrivateKeyJwtProvider,
    requestJwtAuthorizationGrant,
    StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import * as z from 'zod/v4';

import { ConformanceOAuthProvider } from './helpers/conformanceOAuthProvider';
import { logger } from './helpers/logger';
import { handle401, withOAuthRetry } from './helpers/withOAuthRetry';

/**
 * Fixed client metadata URL for CIMD conformance tests.
 * When server supports client_id_metadata_document_supported, this URL
 * will be used as the client_id instead of doing dynamic registration.
 */
const CIMD_CLIENT_METADATA_URL = 'https://conformance-test.local/client-metadata.json';

/**
 * Schema for client conformance test context passed via MCP_CONFORMANCE_CONTEXT.
 *
 * Each variant includes a `name` field matching the scenario name to enable
 * discriminated union parsing and type-safe access to scenario-specific fields.
 */
const ClientConformanceContextSchema = z.discriminatedUnion('name', [
    z.object({
        name: z.literal('auth/client-credentials-jwt'),
        client_id: z.string(),
        private_key_pem: z.string(),
        signing_algorithm: z.string().optional()
    }),
    z.object({
        name: z.literal('auth/client-credentials-basic'),
        client_id: z.string(),
        client_secret: z.string()
    }),
    z.object({
        name: z.literal('auth/pre-registration'),
        client_id: z.string(),
        client_secret: z.string()
    }),
    z.object({
        name: z.literal('auth/cross-app-access-complete-flow'),
        client_id: z.string(),
        client_secret: z.string(),
        idp_client_id: z.string(),
        idp_id_token: z.string(),
        idp_issuer: z.string(),
        idp_token_endpoint: z.string()
    }),
    z.object({
        name: z.literal('auth/enterprise-managed-authorization'),
        client_id: z.string(),
        client_secret: z.string(),
        idp_client_id: z.string(),
        idp_id_token: z.string(),
        idp_issuer: z.string(),
        idp_token_endpoint: z.string()
    })
]);

/**
 * Parse the conformance context from MCP_CONFORMANCE_CONTEXT env var.
 */
function parseContext() {
    const raw = process.env.MCP_CONFORMANCE_CONTEXT;
    if (!raw) {
        throw new Error('MCP_CONFORMANCE_CONTEXT not set');
    }
    return ClientConformanceContextSchema.parse(JSON.parse(raw));
}

// Scenario handler type
type ScenarioHandler = (serverUrl: string) => Promise<void>;

// Registry of scenario handlers
const scenarioHandlers: Record<string, ScenarioHandler> = {};

// Helper to register a scenario handler
function registerScenario(name: string, handler: ScenarioHandler): void {
    scenarioHandlers[name] = handler;
}

// Helper to register multiple scenarios with the same handler
function registerScenarios(names: string[], handler: ScenarioHandler): void {
    for (const name of names) {
        scenarioHandlers[name] = handler;
    }
}

// ============================================================================
// 2026-07-28 (modern era) helpers
// ============================================================================

/**
 * Spec versions whose wire lifecycle is the 2026-07-28 per-request envelope
 * (no `initialize` handshake). The conformance runner passes the resolved
 * spec version of the current scenario run via the
 * MCP_CONFORMANCE_PROTOCOL_VERSION environment variable; when it names a
 * modern version, version-spanning scenarios (e.g. tools_call) must speak the
 * modern lifecycle instead of the 2025 stateful one.
 */
const MODERN_SPEC_VERSIONS = new Set(['2026-07-28']);

function isModernConformanceRun(): boolean {
    const version = process.env.MCP_CONFORMANCE_PROTOCOL_VERSION;
    return version !== undefined && MODERN_SPEC_VERSIONS.has(version);
}

// ============================================================================
// Basic scenarios (initialize, tools_call)
// ============================================================================

async function runBasicClient(serverUrl: string): Promise<void> {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    logger.debug('Successfully connected to MCP server');

    await client.listTools();
    logger.debug('Successfully listed tools');

    await transport.close();
    logger.debug('Connection closed successfully');
}

// tools_call scenario needs to actually call a tool
async function runToolsCallClient(serverUrl: string): Promise<void> {
    if (isModernConformanceRun()) {
        return runToolsCallModernClient(serverUrl);
    }

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    logger.debug('Successfully connected to MCP server');

    const tools = await client.listTools();
    logger.debug('Successfully listed tools');

    // Call the add_numbers tool
    if (tools.tools.some(t => t.name === 'add_numbers')) {
        const result = await client.callTool({
            name: 'add_numbers',
            arguments: { a: 5, b: 3 }
        });
        logger.debug('Tool call result:', JSON.stringify(result, null, 2));
    }

    await transport.close();
    logger.debug('Connection closed successfully');
}

// tools_call under a 2026-07-28 run: negotiate the modern era via
// server/discover (versionNegotiation), then drive the same tool flow — the
// client attaches the per-request _meta envelope to every request itself.
async function runToolsCallModernClient(serverUrl: string): Promise<void> {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    logger.debug('Negotiated protocol version:', client.getNegotiatedProtocolVersion());

    const tools = await client.listTools();
    logger.debug('Successfully listed tools');

    // Call the add_numbers tool
    if (tools.tools.some(t => t.name === 'add_numbers')) {
        const result = await client.callTool({
            name: 'add_numbers',
            arguments: { a: 5, b: 3 }
        });
        logger.debug('Tool call result:', JSON.stringify(result, null, 2));
    }

    await client.close();
    logger.debug('Connection closed successfully');
}

// request-metadata scenario (SEP-2575): every request must carry the
// MCP-Protocol-Version header and the per-request _meta envelope, and the
// client must retry with a supported version when its first choice is
// rejected with -32022. The version-negotiation probe (server/discover plus
// the corrective continuation) is exactly that mechanism.
async function runRequestMetadataClient(serverUrl: string): Promise<void> {
    const clientInfo = { name: 'test-client', version: '1.0.0' };
    const client = new Client(clientInfo, {
        capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
        versionNegotiation: { mode: 'auto' }
    });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    logger.debug('Negotiated protocol version:', client.getNegotiatedProtocolVersion());

    await client.close();
    logger.debug('Connection closed successfully');
}

registerScenario('initialize', runBasicClient);
registerScenario('tools_call', runToolsCallClient);
registerScenario('request-metadata', runRequestMetadataClient);

// ============================================================================
// SEP-2243 standard-header client scenario (Mcp-Method / Mcp-Name)
// ============================================================================

// http-standard-headers: the referee mock answers initialize, tools/list,
// tools/call, resources/list, resources/read, prompts/list, prompts/get and
// asserts that each POST carried the correct Mcp-Method header (and Mcp-Name
// for the call/read/get verbs). The SDK emits both headers on the modern
// streamableHttp path, so the fixture just needs to drive each method once.
// The mock has no server/discover handler and its 2025-shaped initialize
// response doesn't satisfy the v2 client — same connect-time gap as the other
// SEP-2243 mocks — so connect via the withLocalDiscoverResponse shim. The
// initialize / notifications/initialized checks are intentionally left
// SKIPPED; the legacy initialize path's missing Mcp-Method is tracked as a
// baseline bug. The mock advertises its own surface (test_headers /
// file:///path/to/file%20name.txt / test_prompt) — the fixture lists first
// and uses whatever the mock returned so it stays referee-version-agnostic.
async function runHttpStandardHeadersClient(serverUrl: string): Promise<void> {
    const client = await connectModernHeaderClient(serverUrl);
    logger.debug('Successfully connected to MCP server');

    const { tools } = await client.listTools();
    const tool = tools[0];
    if (tool) {
        await client.callTool({ name: tool.name, arguments: {} });
    }

    const { resources } = await client.listResources();
    const resource = resources[0];
    if (resource) {
        await client.readResource({ uri: resource.uri });
    }

    const { prompts } = await client.listPrompts();
    const prompt = prompts[0];
    if (prompt) {
        await client.getPrompt({ name: prompt.name, arguments: {} });
    }

    await client.close();
    logger.debug('Connection closed successfully');
}

registerScenario('http-standard-headers', runHttpStandardHeadersClient);

// ============================================================================
// SEP-2243 custom-header client scenarios (protocol revision 2026-07-28)
// ============================================================================

// The SEP-2243 conformance mocks (http-custom-headers / http-invalid-tool-headers)
// only implement tools/list + tools/call (and a 2025-shaped initialize pinned
// to 2026-07-28, no server/discover) — same connect-time gap as the
// multi-round-trip mock, so use the same withLocalDiscoverResponse fetch shim
// (defined below) to establish the modern era. The runner passes the exact
// tool calls to make via MCP_CONFORMANCE_CONTEXT.

function readToolCallsContext(): Array<{ name: string; arguments: Record<string, unknown> }> {
    const raw = process.env.MCP_CONFORMANCE_CONTEXT;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> };
    return parsed.toolCalls ?? [];
}

async function connectModernHeaderClient(serverUrl: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: withLocalDiscoverResponse({ name: 'test-client', version: '1.0.0' })
    });
    await client.connect(transport);
    return client;
}

// http-custom-headers: the conformance mock advertises test_custom_headers and
// test_custom_headers_null with x-mcp-header annotations. List first (so the
// SDK caches the inputSchema and can mirror), then make the runner-supplied
// calls; the conformance mock validates the Mcp-Param-* headers it receives.
async function runHttpCustomHeadersClient(serverUrl: string): Promise<void> {
    const client = await connectModernHeaderClient(serverUrl);
    const { tools } = await client.listTools();
    logger.debug('listed tools:', tools.map(t => t.name).join(', '));

    for (const call of readToolCallsContext()) {
        await client.callTool({ name: call.name, arguments: call.arguments });
    }
    await client.close();
}

// http-invalid-tool-headers: the conformance mock advertises one valid tool
// alongside several constraint-violating ones. listTools() must exclude the
// invalid ones; the fixture then calls every tool that survived — a correct
// SDK leaves only valid_tool, so the mock records SUCCESS for the keep-valid
// check and SUCCESS for every excluded tool not having been called.
async function runHttpInvalidToolHeadersClient(serverUrl: string): Promise<void> {
    const client = await connectModernHeaderClient(serverUrl);
    const { tools } = await client.listTools();
    logger.debug('post-exclusion tools:', tools.map(t => t.name).join(', '));

    for (const tool of tools) {
        await client.callTool({ name: tool.name, arguments: { region: 'us-west1' } }).catch(error => {
            logger.debug(`call ${tool.name} rejected:`, String(error));
        });
    }
    await client.close();
}

registerScenario('http-custom-headers', runHttpCustomHeadersClient);
registerScenario('http-invalid-tool-headers', runHttpInvalidToolHeadersClient);

// ============================================================================
// Multi-round-trip client scenario (SEP-2322, protocol revision 2026-07-28)
// ============================================================================

/**
 * The multi-round-trip client scenario's mock server only implements
 * `tools/list`, `tools/call` and `notifications/initialized`; it answers both
 * `server/discover` and `initialize` with -32601, so neither connect-time
 * negotiation path can establish the 2026-07-28 era against it. The scenario
 * is pinned to 2026-07-28 (the runner resolves it there even on the
 * default-version leg), so the fixture answers the connect-time
 * `server/discover` probe locally through the transport's custom fetch and
 * lets every other request reach the real mock. Everything the scenario
 * measures — auto-fulfilment of the embedded elicitation, the byte-exact
 * requestState echo, fresh JSON-RPC ids on retries, isolation of unrelated
 * calls, and not retrying complete results — is the SDK driver's behavior
 * against the real mock.
 */
function withLocalDiscoverResponse(serverInfo: { name: string; version: string }): typeof fetch {
    return async (input, init) => {
        if (typeof init?.body === 'string') {
            try {
                const message = JSON.parse(init.body) as { method?: string; id?: unknown };
                if (message.method === 'server/discover') {
                    return Response.json(
                        {
                            jsonrpc: '2.0',
                            id: message.id,
                            result: {
                                supportedVersions: ['2026-07-28'],
                                // Advertise the full read surface so capability-gated
                                // list/read/get calls reach the real mock; callers that
                                // only use tools are unaffected by the extra entries.
                                capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
                                serverInfo
                            }
                        },
                        { status: 200, headers: { 'Content-Type': 'application/json' } }
                    );
                }
            } catch {
                // Not a JSON-RPC body — fall through to the real fetch.
            }
        }
        return fetch(input, init);
    };
}

async function runMrtrClient(serverUrl: string): Promise<void> {
    const clientInfo = { name: 'test-client', version: '1.0.0' };
    const capabilities = { elicitation: {} };
    const client = new Client(clientInfo, {
        capabilities,
        versionNegotiation: { mode: 'auto' }
    });

    // The auto-fulfilment driver dispatches the embedded elicitation requests
    // to this handler, exactly like a server-initiated elicitation.
    client.setRequestHandler('elicitation/create', async request => {
        logger.debug('Fulfilling embedded elicitation request:', JSON.stringify(request.params));
        return { action: 'accept' as const, content: { confirmed: true } };
    });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: withLocalDiscoverResponse(clientInfo)
    });

    await client.connect(transport);
    logger.debug('Negotiated protocol version:', client.getNegotiatedProtocolVersion());

    // requestState echo flow: the driver must echo the opaque state byte-exact
    // and retry on a fresh JSON-RPC id.
    const echoResult = await client.callTool({ name: 'test_mrtr_echo_state', arguments: {} });
    logger.debug('test_mrtr_echo_state result:', JSON.stringify(echoResult));

    // No-state flow: the InputRequiredResult carries no requestState, so the
    // retry must not include one.
    const noStateResult = await client.callTool({ name: 'test_mrtr_no_state', arguments: {} });
    logger.debug('test_mrtr_no_state result:', JSON.stringify(noStateResult));

    // Unrelated call: must not carry inputResponses or requestState from the
    // multi-round-trip flows above.
    const unrelatedResult = await client.callTool({ name: 'test_mrtr_unrelated', arguments: {} });
    logger.debug('test_mrtr_unrelated result:', JSON.stringify(unrelatedResult));

    // Result without resultType: the check passes as long as the client does
    // not retry with inputResponses. The SDK treats a missing resultType from
    // a 2026-negotiated server as a protocol violation and rejects locally
    // without retrying, so this call is expected to throw.
    try {
        const noResultTypeResult = await client.callTool({ name: 'test_mrtr_no_result_type', arguments: {} });
        logger.debug('test_mrtr_no_result_type result:', JSON.stringify(noResultTypeResult));
    } catch (error) {
        logger.debug('test_mrtr_no_result_type rejected locally (no retry):', error instanceof Error ? error.message : String(error));
    }

    await client.close();
    logger.debug('Connection closed successfully');
}

registerScenario('sep-2322-client-request-state', runMrtrClient);

// ============================================================================
// Auth scenarios - well-behaved client
// ============================================================================

async function runAuthClient(serverUrl: string): Promise<void> {
    const client = new Client({ name: 'test-auth-client', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });

    const oauthFetch = withOAuthRetry('test-auth-client', new URL(serverUrl), handle401, CIMD_CLIENT_METADATA_URL)(fetch);

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: oauthFetch
    });

    await client.connect(transport);
    logger.debug('Successfully connected to MCP server');

    await client.listTools();
    logger.debug('Successfully listed tools');

    await client.callTool({ name: 'test-tool', arguments: {} });
    logger.debug('Successfully called tool');

    await transport.close();
    logger.debug('Connection closed successfully');
}

// Register all auth scenarios that should use the well-behaved auth client
// Note: client-credentials-jwt and client-credentials-basic have their own handlers below
registerScenarios(
    [
        'auth/basic-cimd',
        'auth/metadata-default',
        'auth/metadata-var1',
        'auth/metadata-var2',
        'auth/metadata-var3',
        'auth/2025-03-26-oauth-metadata-backcompat',
        'auth/2025-03-26-oauth-endpoint-fallback',
        // RFC 8707 resource-indicator binding: the referee serves a PRM whose
        // `resource` does not match the MCP server URL; the SDK's discovery path
        // must reject before token exchange (the referee sets `allowClientError`).
        'auth/resource-mismatch',
        'auth/scope-from-www-authenticate',
        'auth/scope-from-scopes-supported',
        'auth/scope-omitted-when-undefined',
        'auth/scope-step-up',
        'auth/scope-retry-limit',
        'auth/token-endpoint-auth-basic',
        'auth/token-endpoint-auth-post',
        'auth/token-endpoint-auth-none',
        'auth/offline-access-scope',
        'auth/offline-access-not-supported',
        // SEP-2468 (RFC 9207 iss / RFC 8414 §3.3 issuer-echo). The well-behaved
        // client captures `iss` from the authorization redirect and passes it to
        // `auth()`; the SDK validates internally. Positive scenarios proceed to
        // the token endpoint; negative scenarios throw `IssuerMismatchError` and
        // the process exits with an error (the referee sets `allowClientError`).
        'auth/iss-supported',
        'auth/iss-not-advertised',
        'auth/iss-supported-missing',
        'auth/iss-wrong-issuer',
        'auth/iss-unexpected',
        'auth/iss-normalized',
        'auth/metadata-issuer-mismatch',
        // SEP-2352: PRM `authorization_servers` switches between calls; the client's
        // issuer-stamped credential storage reads back as undefined at the new AS and
        // re-registers there.
        'auth/authorization-server-migration'
    ],
    runAuthClient
);

// ============================================================================
// Client Credentials scenarios
// ============================================================================

/**
 * Client credentials with private_key_jwt authentication.
 */
async function runClientCredentialsJwt(serverUrl: string): Promise<void> {
    const ctx = parseContext();
    if (ctx.name !== 'auth/client-credentials-jwt') {
        throw new Error(`Expected jwt context, got ${ctx.name}`);
    }

    const provider = new PrivateKeyJwtProvider({
        clientId: ctx.client_id,
        privateKey: ctx.private_key_pem,
        algorithm: ctx.signing_algorithm || 'ES256'
    });

    const client = new Client({ name: 'conformance-client-credentials-jwt', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        authProvider: provider
    });

    await client.connect(transport);
    logger.debug('Successfully connected with private_key_jwt auth');

    await client.listTools();
    logger.debug('Successfully listed tools');

    await transport.close();
    logger.debug('Connection closed successfully');
}

registerScenario('auth/client-credentials-jwt', runClientCredentialsJwt);

/**
 * Client credentials with client_secret_basic authentication.
 */
async function runClientCredentialsBasic(serverUrl: string): Promise<void> {
    const ctx = parseContext();
    if (ctx.name !== 'auth/client-credentials-basic') {
        throw new Error(`Expected basic context, got ${ctx.name}`);
    }

    const provider = new ClientCredentialsProvider({
        clientId: ctx.client_id,
        clientSecret: ctx.client_secret
    });

    const client = new Client({ name: 'conformance-client-credentials-basic', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        authProvider: provider
    });

    await client.connect(transport);
    logger.debug('Successfully connected with client_secret_basic auth');

    await client.listTools();
    logger.debug('Successfully listed tools');

    await transport.close();
    logger.debug('Connection closed successfully');
}

registerScenario('auth/client-credentials-basic', runClientCredentialsBasic);

/**
 * Cross-App Access (SEP-990 Enterprise Managed Authorization).
 *
 * Exchanges an IdP-issued ID token for an ID-JAG (RFC 8693 token exchange at the IdP),
 * then exchanges the ID-JAG for an access token at the AS (RFC 7523 JWT bearer grant
 * with client_secret_basic). The provider drives discovery + the JWT bearer step; the
 * assertion callback handles the IdP exchange using the context-supplied ID token.
 *
 * The two scenarios share the same context shape and the same client behavior:
 * `auth/cross-app-access-complete-flow` is the single-AS variant;
 * `auth/enterprise-managed-authorization` is the SEP-990 extension scenario that
 * additionally validates `requested_token_type=id-jag`, ID-JAG `typ` and
 * `client_id`/`resource` claim binding at the AS.
 */
async function runCrossAppAccessCompleteFlow(serverUrl: string): Promise<void> {
    const ctx = parseContext();
    if (ctx.name !== 'auth/cross-app-access-complete-flow' && ctx.name !== 'auth/enterprise-managed-authorization') {
        throw new Error(`Expected cross-app-access context, got ${ctx.name}`);
    }

    const provider = new CrossAppAccessProvider({
        clientId: ctx.client_id,
        clientSecret: ctx.client_secret,
        assertion: async authCtx => {
            const result = await requestJwtAuthorizationGrant({
                tokenEndpoint: ctx.idp_token_endpoint,
                audience: authCtx.authorizationServerUrl,
                resource: authCtx.resourceUrl,
                idToken: ctx.idp_id_token,
                clientId: ctx.idp_client_id,
                fetchFn: authCtx.fetchFn
            });
            return result.jwtAuthGrant;
        }
    });

    const client = new Client({ name: 'conformance-cross-app-access', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        authProvider: provider
    });

    await client.connect(transport);
    logger.debug('Successfully connected with cross-app-access auth');

    await client.listTools();
    logger.debug('Successfully listed tools');

    await transport.close();
    logger.debug('Connection closed successfully');
}

registerScenario('auth/cross-app-access-complete-flow', runCrossAppAccessCompleteFlow);
registerScenario('auth/enterprise-managed-authorization', runCrossAppAccessCompleteFlow);

// ============================================================================
// Pre-registration scenario (no dynamic client registration)
// ============================================================================

async function runPreRegistrationClient(serverUrl: string): Promise<void> {
    const ctx = parseContext();
    if (ctx.name !== 'auth/pre-registration') {
        throw new Error(`Expected pre-registration context, got ${ctx.name}`);
    }

    // Create a provider pre-populated with registered credentials,
    // so the SDK skips dynamic client registration.
    const provider = new ConformanceOAuthProvider('http://localhost:3000/callback', {
        client_name: 'conformance-pre-registration',
        redirect_uris: ['http://localhost:3000/callback']
    });
    provider.saveClientInformation({
        client_id: ctx.client_id,
        client_secret: ctx.client_secret,
        redirect_uris: ['http://localhost:3000/callback']
    });

    const oauthFetch = withOAuthRetry('conformance-pre-registration', new URL(serverUrl), handle401, undefined, provider)(fetch);

    const client = new Client({ name: 'conformance-pre-registration', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: oauthFetch
    });

    await client.connect(transport);
    await client.listTools();
    await client.callTool({ name: 'test-tool', arguments: {} });
    await transport.close();
}

registerScenario('auth/pre-registration', runPreRegistrationClient);

// ============================================================================
// Elicitation defaults scenario
// ============================================================================

async function runElicitationDefaultsClient(serverUrl: string): Promise<void> {
    const client = new Client(
        { name: 'elicitation-defaults-test-client', version: '1.0.0' },
        {
            capabilities: {
                elicitation: {
                    form: {
                        applyDefaults: true
                    }
                }
            }
        }
    );

    // Register elicitation handler that returns empty content
    // The SDK should fill in defaults for all omitted fields
    client.setRequestHandler('elicitation/create', async request => {
        logger.debug('Received elicitation request:', JSON.stringify(request.params, null, 2));
        logger.debug('Accepting with empty content - SDK should apply defaults');

        // Return empty content - SDK should merge in defaults
        return {
            action: 'accept' as const,
            content: {}
        };
    });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    logger.debug('Successfully connected to MCP server');

    // List available tools
    const tools = await client.listTools();
    logger.debug(
        'Available tools:',
        tools.tools.map(t => t.name)
    );

    // Call the test tool which will trigger elicitation
    const testTool = tools.tools.find(t => t.name === 'test_client_elicitation_defaults');
    if (!testTool) {
        throw new Error('Test tool not found: test_client_elicitation_defaults');
    }

    logger.debug('Calling test_client_elicitation_defaults tool...');
    const result = await client.callTool({
        name: 'test_client_elicitation_defaults',
        arguments: {}
    });

    logger.debug('Tool result:', JSON.stringify(result, null, 2));

    await transport.close();
    logger.debug('Connection closed successfully');
}

registerScenario('elicitation-sep1034-client-defaults', runElicitationDefaultsClient);

// ============================================================================
// SSE retry scenario
// ============================================================================

async function runSSERetryClient(serverUrl: string): Promise<void> {
    const client = new Client({ name: 'sse-retry-test-client', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    logger.debug('Successfully connected to MCP server');

    // List tools to get the reconnection test tool
    const tools = await client.listTools();
    logger.debug(
        'Available tools:',
        tools.tools.map(t => t.name)
    );

    // Call the test_reconnection tool which triggers stream closure
    const testTool = tools.tools.find(t => t.name === 'test_reconnection');
    if (!testTool) {
        throw new Error('Test tool not found: test_reconnection');
    }

    logger.debug('Calling test_reconnection tool...');
    const result = await client.callTool({
        name: 'test_reconnection',
        arguments: {}
    });

    logger.debug('Tool result:', JSON.stringify(result, null, 2));

    await transport.close();
    logger.debug('Connection closed successfully');
}

registerScenario('sse-retry', runSSERetryClient);

// ============================================================================
// JSON Schema $ref dereference scenario (SEP-2106)
// ============================================================================

/**
 * The scenario serves a tool whose outputSchema carries a network `$ref`; the
 * conformance check passes when the client lists tools without dereferencing
 * (fetching) that URL. The SDK never dereferences network refs — output
 * schemas are compiled lazily on the first `callTool()` against the cached
 * `tools/list` entry, and the underlying engine (Ajv / cfworker) does not
 * fetch external refs (Ajv throws `MissingRefError`, captured per-tool) — so
 * a plain connect → listTools → close is sufficient: `listTools()` returns
 * normally and the canary URL is never fetched.
 */
async function runJsonSchemaRefNoDerefClient(serverUrl: string): Promise<void> {
    const client = new Client({ name: 'json-schema-ref-no-deref-client', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    logger.debug('Successfully connected to MCP server');

    const tools = await client.listTools();
    logger.debug(
        'Available tools:',
        tools.tools.map(t => t.name)
    );

    await transport.close();
    logger.debug('Connection closed successfully');
}

registerScenario('json-schema-ref-no-deref', runJsonSchemaRefNoDerefClient);

// ============================================================================
// Main entry point
// ============================================================================

async function main(): Promise<void> {
    const scenarioName = process.env.MCP_CONFORMANCE_SCENARIO;
    const serverUrl = process.argv[2];

    if (!scenarioName || !serverUrl) {
        logger.error('Usage: MCP_CONFORMANCE_SCENARIO=<scenario> everything-client <server-url>');
        logger.error('\nThe MCP_CONFORMANCE_SCENARIO env var is set automatically by the conformance runner.');
        logger.error('\nAvailable scenarios:');
        for (const name of Object.keys(scenarioHandlers).toSorted()) {
            logger.error(`  - ${name}`);
        }
        process.exit(1);
    }

    const handler = scenarioHandlers[scenarioName];
    if (!handler) {
        logger.error(`Unknown scenario: ${scenarioName}`);
        logger.error('\nAvailable scenarios:');
        for (const name of Object.keys(scenarioHandlers).toSorted()) {
            logger.error(`  - ${name}`);
        }
        process.exit(1);
    }

    try {
        await handler(serverUrl);
        process.exit(0);
    } catch (error) {
        logger.error('Error:', error);
        process.exit(1);
    }
}

await main();
