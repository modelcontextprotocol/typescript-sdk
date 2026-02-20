// Run with: pnpm tsx src/elicitationUrlExample.ts
//
// This example demonstrates how to use URL elicitation to securely
// collect user input in a remote (HTTP) server.
// URL elicitation allows servers to prompt the end-user to open a URL in their browser
// to collect sensitive information.

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

import type {
    CallToolRequest,
    ElicitRequest,
    ElicitRequestURLParams,
    ElicitResult,
    ListToolsRequest,
    OAuthClientMetadata,
    ResourceLink
} from '@modelcontextprotocol/client';
import {
    CallToolResultSchema,
    Client,
    getDisplayName,
    ListToolsResultSchema,
    ProtocolError,
    ProtocolErrorCode,
    StreamableHTTPClientTransport,
    UnauthorizedError,
    UrlElicitationRequiredError
} from '@modelcontextprotocol/client';
import open from 'open';

import { InMemoryOAuthClientProvider } from './simpleOAuthClientProvider.js';

// Set up OAuth (required for this example)
const OAUTH_CALLBACK_PORT = 8090; // Use different port than auth server (3001)
const OAUTH_CALLBACK_URL = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;

console.log('Getting OAuth token...');
const clientMetadata: OAuthClientMetadata = {
    client_name: 'Elicitation MCP Client',
    redirect_uris: [OAUTH_CALLBACK_URL],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    scope: 'mcp:tools'
};
const oauthProvider = new InMemoryOAuthClientProvider(OAUTH_CALLBACK_URL, clientMetadata, (redirectUrl: URL) => {
    console.log(`🌐 Opening browser for OAuth redirect: ${redirectUrl.toString()}`);
    openBrowser(redirectUrl.toString());
});

// Create readline interface for user input
const readline = createInterface({
    input: process.stdin,
    output: process.stdout
});
let abortCommand = new AbortController();

// Global client and transport for interactive commands
let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;
let serverUrl = 'http://localhost:3000/mcp';
let sessionId: string | undefined;

// Elicitation queue management
interface QueuedElicitation {
    request: ElicitRequest;
    resolve: (result: ElicitResult) => void;
    reject: (error: Error) => void;
}

let isProcessingCommand = false;
let isProcessingElicitations = false;
const elicitationQueue: QueuedElicitation[] = [];
let elicitationQueueSignal: (() => void) | null = null;
let elicitationsCompleteSignal: (() => void) | null = null;

// Map to track pending URL elicitations waiting for completion notifications
const pendingURLElicitations = new Map<
    string,
    {
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    }
>();

async function main(): Promise<void> {
    console.log('MCP Interactive Client');
    console.log('=====================');

    // Connect to server immediately with default settings
    await connect();

    // Start the elicitation loop in the background
    elicitationLoop().catch(error => {
        console.error('Unexpected error in elicitation loop:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    });

    // Short delay allowing the server to send any SSE elicitations on connection
    await new Promise(resolve => setTimeout(resolve, 200));

    // Wait until we are done processing any initial elicitations
    await waitForElicitationsToComplete();

    // Print help and start the command loop
    printHelp();
    await commandLoop();
}

async function waitForElicitationsToComplete(): Promise<void> {
    // Wait until the queue is empty and nothing is being processed
    while (elicitationQueue.length > 0 || isProcessingElicitations) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

function printHelp(): void {
    console.log('\nAvailable commands:');
    console.log('  connect [url]              - Connect to MCP server (default: http://localhost:3000/mcp)');
    console.log('  disconnect                 - Disconnect from server');
    console.log('  terminate-session          - Terminate the current session');
    console.log('  reconnect                  - Reconnect to the server');
    console.log('  list-tools                 - List available tools');
    console.log('  call-tool <name> [args]    - Call a tool with optional JSON arguments');
    console.log('  payment-confirm            - Test URL elicitation via error response with payment-confirm tool');
    console.log('  third-party-auth           - Test tool that requires third-party OAuth credentials');
    console.log('  help                       - Show this help');
    console.log('  quit                       - Exit the program');
}

async function commandLoop(): Promise<void> {
    await new Promise<void>(resolve => {
        if (isProcessingElicitations) {
            elicitationsCompleteSignal = resolve;
        } else {
            resolve();
        }
    });

    readline.question('\n> ', { signal: abortCommand.signal }, async input => {
        isProcessingCommand = true;

        const args = input.trim().split(/\s+/);
        const command = args[0]?.toLowerCase();

        try {
            switch (command) {
                case 'connect': {
                    await connect(args[1]);
                    break;
                }

                case 'disconnect': {
                    await disconnect();
                    break;
                }

                case 'terminate-session': {
                    await terminateSession();
                    break;
                }

                case 'reconnect': {
                    await reconnect();
                    break;
                }

                case 'list-tools': {
                    await listTools();
                    break;
                }

                case 'call-tool': {
                    if (args.length < 2) {
                        console.log('Usage: call-tool <name> [args]');
                    } else {
                        const toolName = args[1]!;
                        let toolArgs = {};
                        if (args.length > 2) {
                            try {
                                toolArgs = JSON.parse(args.slice(2).join(' '));
                            } catch {
                                console.log('Invalid JSON arguments. Using empty args.');
                            }
                        }
                        await callTool(toolName, toolArgs);
                    }
                    break;
                }

                case 'payment-confirm': {
                    await callPaymentConfirmTool();
                    break;
                }

                case 'third-party-auth': {
                    await callThirdPartyAuthTool();
                    break;
                }

                case 'help': {
                    printHelp();
                    break;
                }

                case 'quit':
                case 'exit': {
                    await cleanup();
                    return;
                }

                default: {
                    if (command) {
                        console.log(`Unknown command: ${command}`);
                    }
                    break;
                }
            }
        } catch (error) {
            console.error(`Error executing command: ${error}`);
        } finally {
            isProcessingCommand = false;
        }

        // Process another command after we've processed the this one
        await commandLoop();
    });
}

async function elicitationLoop(): Promise<void> {
    while (true) {
        // Wait until we have elicitations to process
        await new Promise<void>(resolve => {
            if (elicitationQueue.length > 0) {
                resolve();
            } else {
                elicitationQueueSignal = resolve;
            }
        });

        isProcessingElicitations = true;
        abortCommand.abort(); // Abort the command loop if it's running

        // Process all queued elicitations
        while (elicitationQueue.length > 0) {
            const queued = elicitationQueue.shift()!;
            console.log(`📤 Processing queued elicitation (${elicitationQueue.length} remaining)`);

            try {
                const result = await handleElicitationRequest(queued.request);
                queued.resolve(result);
            } catch (error) {
                queued.reject(error instanceof Error ? error : new Error(String(error)));
            }
        }

        console.log('✅ All queued elicitations processed. Resuming command loop...\n');
        isProcessingElicitations = false;

        // Reset the abort controller for the next command loop
        abortCommand = new AbortController();

        // Resume the command loop
        if (elicitationsCompleteSignal) {
            elicitationsCompleteSignal();
            elicitationsCompleteSignal = null;
        }
    }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

async function openBrowser(url: string): Promise<void> {
    try {
        const parsed = new URL(url);
        if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
            console.error(`Refusing to open URL with unsupported scheme '${parsed.protocol}': ${url}`);
            return;
        }
    } catch {
        console.error(`Invalid URL: ${url}`);
        return;
    }

    try {
        await open(url);
    } catch {
        console.log(`Please manually open: ${url}`);
    }
}

/**
 * Enqueues an elicitation request and returns the result.
 *
 * This function is used so that our CLI (which can only handle one input request at a time)
 * can handle elicitation requests and the command loop.
 *
 * @param request - The elicitation request to be handled
 * @returns The elicitation result
 */
async function elicitationRequestHandler(request: ElicitRequest): Promise<ElicitResult> {
    // If we are processing a command, handle this elicitation immediately
    if (isProcessingCommand) {
        console.log('📋 Processing elicitation immediately (during command execution)');
        return await handleElicitationRequest(request);
    }

    // Otherwise, queue the request to be handled by the elicitation loop
    console.log(`📥 Queueing elicitation request (queue size will be: ${elicitationQueue.length + 1})`);

    return new Promise<ElicitResult>((resolve, reject) => {
        elicitationQueue.push({
            request,
            resolve,
            reject
        });

        // Signal the elicitation loop that there's work to do
        if (elicitationQueueSignal) {
            elicitationQueueSignal();
            elicitationQueueSignal = null;
        }
    });
}

/**
 * Handles an elicitation request.
 *
 * This function is used to handle the elicitation request and return the result.
 *
 * @param request - The elicitation request to be handled
 * @returns The elicitation result
 */
async function handleElicitationRequest(request: ElicitRequest): Promise<ElicitResult> {
    const mode = request.params.mode;
    console.log('\n🔔 Elicitation Request Received:');
    console.log(`Mode: ${mode}`);

    if (mode === 'url') {
        return {
            action: await handleURLElicitation(request.params as ElicitRequestURLParams)
        };
    } else {
        // Should not happen because the client declares its capabilities to the server,
        // but being defensive is a good practice:
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unsupported elicitation mode: ${mode}`);
    }
}

/**
 * Handles a URL elicitation by opening the URL in the browser.
 *
 * Note: This is a shared code for both request handlers and error handlers.
 * As a result of sharing schema, there is no big forking of logic for the client.
 *
 * @param params - The URL elicitation request parameters
 * @returns The action to take (accept, cancel, or decline)
 */
async function handleURLElicitation(params: ElicitRequestURLParams): Promise<ElicitResult['action']> {
    const url = params.url;
    const elicitationId = params.elicitationId;
    const message = params.message;
    console.log(`🆔 Elicitation ID: ${elicitationId}`); // Print for illustration

    // Parse URL to show domain for security
    let domain = 'unknown domain';
    try {
        const parsedUrl = new URL(url);
        domain = parsedUrl.hostname;
    } catch {
        console.error('Invalid URL provided by server');
        return 'decline';
    }

    // Example security warning to help prevent phishing attacks
    console.log('\n⚠️  \u001B[33mSECURITY WARNING\u001B[0m ⚠️');
    console.log('\u001B[33mThe server is requesting you to open an external URL.\u001B[0m');
    console.log('\u001B[33mOnly proceed if you trust this server and understand why it needs this.\u001B[0m\n');
    console.log(`🌐 Target domain: \u001B[36m${domain}\u001B[0m`);
    console.log(`🔗 Full URL: \u001B[36m${url}\u001B[0m`);
    console.log(`\nℹ️ Server's reason:\n\n\u001B[36m${message}\u001B[0m\n`);

    // 1. Ask for user consent to open the URL
    const consent = await new Promise<string>(resolve => {
        readline.question('\nDo you want to open this URL in your browser? (y/n): ', input => {
            resolve(input.trim().toLowerCase());
        });
    });

    // 2. If user did not consent, return appropriate result
    if (consent === 'no' || consent === 'n') {
        console.log('❌ URL navigation declined.');
        return 'decline';
    } else if (consent !== 'yes' && consent !== 'y') {
        console.log('🚫 Invalid response. Cancelling elicitation.');
        return 'cancel';
    }

    // 3. Wait for completion notification in the background
    const completionPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
            () => {
                pendingURLElicitations.delete(elicitationId);
                console.log(`\u001B[31m❌ Elicitation ${elicitationId} timed out waiting for completion.\u001B[0m`);
                reject(new Error('Elicitation completion timeout'));
            },
            5 * 60 * 1000
        ); // 5 minute timeout

        pendingURLElicitations.set(elicitationId, {
            resolve: () => {
                clearTimeout(timeout);
                resolve();
            },
            reject,
            timeout
        });
    });

    completionPromise.catch(error => {
        console.error('Background completion wait failed:', error);
    });

    // 4. Open the URL in the browser
    console.log(`\n🚀 Opening browser to: ${url}`);
    await openBrowser(url);

    console.log('\n⏳ Waiting for you to complete the interaction in your browser...');
    console.log('   The server will send a notification once you complete the action.');

    // 5. Acknowledge the user accepted the elicitation
    return 'accept';
}

/**
 * Example OAuth callback handler - in production, use a more robust approach
 * for handling callbacks and storing tokens
 */
/**
 * Starts a temporary HTTP server to receive the OAuth callback
 */
async function waitForOAuthCallback(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const server = createServer((req, res) => {
            // Ignore favicon requests
            if (req.url === '/favicon.ico') {
                res.writeHead(404);
                res.end();
                return;
            }

            console.log(`📥 Received callback: ${req.url}`);
            const parsedUrl = new URL(req.url || '', 'http://localhost');
            const code = parsedUrl.searchParams.get('code');
            const error = parsedUrl.searchParams.get('error');

            if (code) {
                console.log(`✅ Authorization code received: ${code?.slice(0, 10)}...`);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
          <html>
            <body>
              <h1>Authorization Successful!</h1>
              <p>This simulates successful authorization of the MCP client, which now has an access token for the MCP server.</p>
              <p>This window will close automatically in 10 seconds.</p>
              <script>setTimeout(() => window.close(), 10000);</script>
            </body>
          </html>
        `);

                resolve(code);
                setTimeout(() => server.close(), 15_000);
            } else if (error) {
                console.log(`❌ Authorization error: ${error}`);
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`
          <html>
            <body>
              <h1>Authorization Failed</h1>
              <p>Error: ${error}</p>
            </body>
          </html>
        `);
                reject(new Error(`OAuth authorization failed: ${error}`));
            } else {
                console.log(`❌ No authorization code or error in callback`);
                res.writeHead(400);
                res.end('Bad request');
                reject(new Error('No authorization code provided'));
            }
        });

        server.listen(OAUTH_CALLBACK_PORT, () => {
            console.log(`OAuth callback server started on http://localhost:${OAUTH_CALLBACK_PORT}`);
        });
    });
}

/**
 * Attempts to connect to the MCP server with OAuth authentication.
 * Handles OAuth flow recursively if authorization is required.
 */
async function attemptConnection(oauthProvider: InMemoryOAuthClientProvider): Promise<void> {
    console.log('🚢 Creating transport with OAuth provider...');
    const baseUrl = new URL(serverUrl);
    transport = new StreamableHTTPClientTransport(baseUrl, {
        sessionId: sessionId,
        authProvider: oauthProvider
    });
    console.log('🚢 Transport created');

    try {
        console.log('🔌 Attempting connection (this will trigger OAuth redirect if needed)...');
        await client!.connect(transport);
        sessionId = transport.sessionId;
        console.log('Transport created with session ID:', sessionId);
        console.log('✅ Connected successfully');
    } catch (error) {
        if (error instanceof UnauthorizedError) {
            console.log('🔐 OAuth required - waiting for authorization...');
            const callbackPromise = waitForOAuthCallback();
            const authCode = await callbackPromise;
            await transport.finishAuth(authCode);
            console.log('🔐 Authorization code received:', authCode);
            console.log('🔌 Reconnecting with authenticated transport...');
            // Recursively retry connection after OAuth completion
            await attemptConnection(oauthProvider);
        } else {
            console.error('❌ Connection failed with non-auth error:', error);
            throw error;
        }
    }
}

async function connect(url?: string): Promise<void> {
    if (client) {
        console.log('Already connected. Disconnect first.');
        return;
    }

    if (url) {
        serverUrl = url;
    }

    console.log(`🔗 Attempting to connect to ${serverUrl}...`);

    // Create a new client with elicitation capability
    console.log('👤 Creating MCP client...');
    client = new Client(
        {
            name: 'example-client',
            version: '1.0.0'
        },
        {
            capabilities: {
                elicitation: {
                    // Only URL elicitation is supported in this demo
                    // (see server/elicitationExample.ts for a demo of form mode elicitation)
                    url: {}
                }
            }
        }
    );
    console.log('👤 Client created');

    // Set up elicitation request handler with proper validation
    client.setRequestHandler('elicitation/create', elicitationRequestHandler);

    // Set up notification handler for elicitation completion
    client.setNotificationHandler('notifications/elicitation/complete', notification => {
        const { elicitationId } = notification.params;
        const pending = pendingURLElicitations.get(elicitationId);
        if (pending) {
            clearTimeout(pending.timeout);
            pendingURLElicitations.delete(elicitationId);
            console.log(`\u001B[32m✅ Elicitation ${elicitationId} completed!\u001B[0m`);
            pending.resolve();
        } else {
            // Shouldn't happen - discard it!
            console.warn(`Received completion notification for unknown elicitation: ${elicitationId}`);
        }
    });

    try {
        console.log('🔐 Starting OAuth flow...');
        await attemptConnection(oauthProvider!);
        console.log('Connected to MCP server');

        // Set up error handler after connection is established so we don't double log errors
        client.onerror = error => {
            console.error('\u001B[31mClient error:', error, '\u001B[0m');
        };
    } catch (error) {
        console.error('Failed to connect:', error);
        client = null;
        transport = null;
        return;
    }
}

async function disconnect(): Promise<void> {
    if (!client || !transport) {
        console.log('Not connected.');
        return;
    }

    try {
        await transport.close();
        console.log('Disconnected from MCP server');
        client = null;
        transport = null;
    } catch (error) {
        console.error('Error disconnecting:', error);
    }
}

async function terminateSession(): Promise<void> {
    if (!client || !transport) {
        console.log('Not connected.');
        return;
    }

    try {
        console.log('Terminating session with ID:', transport.sessionId);
        await transport.terminateSession();
        console.log('Session terminated successfully');

        // Check if sessionId was cleared after termination
        if (transport.sessionId) {
            console.log('Server responded with 405 Method Not Allowed (session termination not supported)');
            console.log('Session ID is still active:', transport.sessionId);
        } else {
            console.log('Session ID has been cleared');
            sessionId = undefined;

            // Also close the transport and clear client objects
            await transport.close();
            console.log('Transport closed after session termination');
            client = null;
            transport = null;
        }
    } catch (error) {
        console.error('Error terminating session:', error);
    }
}

async function reconnect(): Promise<void> {
    if (client) {
        await disconnect();
    }
    await connect();
}

async function listTools(): Promise<void> {
    if (!client) {
        console.log('Not connected to server.');
        return;
    }

    try {
        const toolsRequest: ListToolsRequest = {
            method: 'tools/list',
            params: {}
        };
        const toolsResult = await client.request(toolsRequest, ListToolsResultSchema);

        console.log('Available tools:');
        if (toolsResult.tools.length === 0) {
            console.log('  No tools available');
        } else {
            for (const tool of toolsResult.tools) {
                console.log(`  - id: ${tool.name}, name: ${getDisplayName(tool)}, description: ${tool.description}`);
            }
        }
    } catch (error) {
        console.log(`Tools not supported by this server (${error})`);
    }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
    if (!client) {
        console.log('Not connected to server.');
        return;
    }

    try {
        const request: CallToolRequest = {
            method: 'tools/call',
            params: {
                name,
                arguments: args
            }
        };

        console.log(`Calling tool '${name}' with args:`, args);
        const result = await client.request(request, CallToolResultSchema);

        console.log('Tool result:');
        const resourceLinks: ResourceLink[] = [];

        for (const item of result.content) {
            switch (item.type) {
                case 'text': {
                    console.log(`  ${item.text}`);

                    break;
                }
                case 'resource_link': {
                    const resourceLink = item as ResourceLink;
                    resourceLinks.push(resourceLink);
                    console.log(`  📁 Resource Link: ${resourceLink.name}`);
                    console.log(`     URI: ${resourceLink.uri}`);
                    if (resourceLink.mimeType) {
                        console.log(`     Type: ${resourceLink.mimeType}`);
                    }
                    if (resourceLink.description) {
                        console.log(`     Description: ${resourceLink.description}`);
                    }

                    break;
                }
                case 'resource': {
                    console.log(`  [Embedded Resource: ${item.resource.uri}]`);

                    break;
                }
                case 'image': {
                    console.log(`  [Image: ${item.mimeType}]`);

                    break;
                }
                case 'audio': {
                    console.log(`  [Audio: ${item.mimeType}]`);

                    break;
                }
                default: {
                    console.log(`  [Unknown content type]:`, item);
                }
            }
        }

        // Offer to read resource links
        if (resourceLinks.length > 0) {
            console.log(`\nFound ${resourceLinks.length} resource link(s). Use 'read-resource <uri>' to read their content.`);
        }
    } catch (error) {
        if (error instanceof UrlElicitationRequiredError) {
            console.log('\n🔔 Elicitation Required Error Received:');
            console.log(`Message: ${error.message}`);
            for (const e of error.elicitations) {
                await handleURLElicitation(e); // For the error handler, we discard the action result because we don't respond to an error response
            }
            return;
        }
        console.log(`Error calling tool ${name}: ${error}`);
    }
}

async function cleanup(): Promise<void> {
    if (client && transport) {
        try {
            // First try to terminate the session gracefully
            if (transport.sessionId) {
                try {
                    console.log('Terminating session before exit...');
                    await transport.terminateSession();
                    console.log('Session terminated successfully');
                } catch (error) {
                    console.error('Error terminating session:', error);
                }
            }

            // Then close the transport
            await transport.close();
        } catch (error) {
            console.error('Error closing transport:', error);
        }
    }

    process.stdin.setRawMode(false);
    readline.close();
    console.log('\nGoodbye!');
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
}

async function callPaymentConfirmTool(): Promise<void> {
    console.log('Calling payment-confirm tool...');
    await callTool('payment-confirm', { cartId: 'cart_123' });
}

async function callThirdPartyAuthTool(): Promise<void> {
    console.log('Calling third-party-auth tool...');
    await callTool('third-party-auth', { param1: 'test' });
}

// Set up raw mode for keyboard input to capture Escape key
process.stdin.setRawMode(true);
process.stdin.on('data', async data => {
    // Check for Escape key (27)
    if (data.length === 1 && data[0] === 27) {
        console.log('\nESC key pressed. Disconnecting from server...');

        // Abort current operation and disconnect from server
        if (client && transport) {
            await disconnect();
            console.log('Disconnected. Press Enter to continue.');
        } else {
            console.log('Not connected to server.');
        }

        // Re-display the prompt
        process.stdout.write('> ');
    }
});

// Handle Ctrl+C
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT. Cleaning up...');
    await cleanup();
});

// Start the interactive client
try {
    await main();
} catch (error) {
    console.error('Error running MCP client:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
