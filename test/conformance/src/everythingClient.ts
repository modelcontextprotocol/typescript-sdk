#!/usr/bin/env node

/**
 * Everything client (v1.x) - a single conformance test client that handles all scenarios.
 *
 * Usage: everything-client <server-url>
 *
 * The scenario name is read from the MCP_CONFORMANCE_SCENARIO environment variable,
 * which is set by the conformance test runner.
 */

import { Client } from '../../../src/client/index.js';
import { StreamableHTTPClientTransport } from '../../../src/client/streamableHttp.js';
import { ClientCredentialsProvider, PrivateKeyJwtProvider } from '../../../src/client/auth-extensions.js';
import { ElicitRequestSchema } from '../../../src/types.js';
import { z } from 'zod';

import { UnauthorizedError } from '../../../src/client/auth.js';
import { logger } from './helpers/logger.js';
import { ConformanceOAuthProvider } from './helpers/conformanceOAuthProvider.js';
import { handle401, withOAuthRetry } from './helpers/withOAuthRetry.js';

/**
 * Fixed client metadata URL for CIMD conformance tests.
 */
const CIMD_CLIENT_METADATA_URL = 'https://conformance-test.local/client-metadata.json';

/**
 * Schema for client conformance test context passed via MCP_CONFORMANCE_CONTEXT.
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
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    logger.debug('Successfully connected to MCP server');

    const tools = await client.listTools();
    logger.debug('Successfully listed tools');

    // Call the add_numbers tool
    const addTool = tools.tools.find(t => t.name === 'add_numbers');
    if (addTool) {
        const result = await client.callTool({
            name: 'add_numbers',
            arguments: { a: 5, b: 3 }
        });
        logger.debug('Tool call result:', JSON.stringify(result, null, 2));
    }

    await transport.close();
    logger.debug('Connection closed successfully');
}

registerScenario('initialize', runBasicClient);
registerScenario('tools_call', runToolsCallClient);

// ============================================================================
// Auth scenarios - well-behaved client
// ============================================================================

async function runAuthClient(serverUrl: string): Promise<void> {
    const client = new Client({ name: 'test-auth-client', version: '1.0.0' }, { capabilities: {} });

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
registerScenarios(
    [
        'auth/basic-cimd',
        'auth/metadata-default',
        'auth/metadata-var1',
        'auth/metadata-var2',
        'auth/metadata-var3',
        'auth/2025-03-26-oauth-metadata-backcompat',
        'auth/2025-03-26-oauth-endpoint-fallback',
        'auth/scope-from-www-authenticate',
        'auth/scope-from-scopes-supported',
        'auth/scope-omitted-when-undefined',
        'auth/scope-step-up',
        'auth/scope-retry-limit',
        'auth/token-endpoint-auth-basic',
        'auth/token-endpoint-auth-post',
        'auth/token-endpoint-auth-none'
    ],
    runAuthClient
);

// ============================================================================
// Client Credentials scenarios
// ============================================================================

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

    const oauthFetch = withOAuthRetry('conformance-pre-registration', new URL(serverUrl), handle401)(fetch);

    // Replace the provider in the middleware — we need to use our pre-populated one.
    // withOAuthRetry creates its own provider, so instead we use the provider directly.
    const client = new Client({ name: 'conformance-pre-registration', version: '1.0.0' }, { capabilities: {} });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: createPreRegFetch(provider, serverUrl)
    });

    await client.connect(transport);
    logger.debug('Successfully connected with pre-registered credentials');

    await client.listTools();
    logger.debug('Successfully listed tools');

    await client.callTool({ name: 'test-tool', arguments: {} });
    logger.debug('Successfully called tool');

    await transport.close();
    logger.debug('Connection closed successfully');
}

/**
 * Creates a fetch wrapper that uses a pre-populated OAuth provider.
 * Similar to withOAuthRetry but uses the given provider instance directly.
 */
function createPreRegFetch(provider: ConformanceOAuthProvider, serverUrl: string): typeof fetch {
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const makeRequest = async (): Promise<Response> => {
            const headers = new Headers(init?.headers);

            const tokens = await provider.tokens();
            if (tokens) {
                headers.set('Authorization', `Bearer ${tokens.access_token}`);
            }

            return await fetch(input, { ...init, headers });
        };

        let response = await makeRequest();

        if (response.status === 401 || response.status === 403) {
            await handle401(response, provider, fetch, serverUrl);
            response = await makeRequest();
        }

        if (response.status === 401 || response.status === 403) {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            throw new UnauthorizedError(`Authentication failed for ${url}`);
        }

        return response;
    };
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
    client.setRequestHandler(ElicitRequestSchema, async request => {
        logger.debug('Received elicitation request:', JSON.stringify(request.params, null, 2));
        logger.debug('Accepting with empty content - SDK should apply defaults');

        return {
            action: 'accept' as const,
            content: {}
        };
    });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    logger.debug('Successfully connected to MCP server');

    const tools = await client.listTools();
    logger.debug(
        'Available tools:',
        tools.tools.map(t => t.name)
    );

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

    const tools = await client.listTools();
    logger.debug(
        'Available tools:',
        tools.tools.map(t => t.name)
    );

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
// Main entry point
// ============================================================================

async function main(): Promise<void> {
    const scenarioName = process.env.MCP_CONFORMANCE_SCENARIO;
    const serverUrl = process.argv[2];

    if (!scenarioName || !serverUrl) {
        logger.error('Usage: MCP_CONFORMANCE_SCENARIO=<scenario> everything-client <server-url>');
        logger.error('\nThe MCP_CONFORMANCE_SCENARIO env var is set automatically by the conformance runner.');
        logger.error('\nAvailable scenarios:');
        for (const name of Object.keys(scenarioHandlers).sort()) {
            logger.error(`  - ${name}`);
        }
        process.exit(1);
    }

    const handler = scenarioHandlers[scenarioName];
    if (!handler) {
        logger.error(`Unknown scenario: ${scenarioName}`);
        logger.error('\nAvailable scenarios:');
        for (const name of Object.keys(scenarioHandlers).sort()) {
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

try {
    await main();
} catch (error) {
    logger.error('Error:', error);
    process.exit(1);
}
