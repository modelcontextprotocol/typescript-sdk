#!/usr/bin/env node

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { URL } from 'node:url';
import { exec } from 'node:child_process';
import { Client } from '../../client/index.js';
import { StreamableHTTPClientTransport } from '../../client/streamableHttp.js';
import { OAuthClientInformation, OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '../../shared/auth.js';
import {
  CallToolRequest,
  ListToolsRequest,
  CallToolResultSchema,
  ListToolsResultSchema
} from '../../types.js';
import { OAuthClientProvider, UnauthorizedError } from '../../client/auth.js';

// Configuration
const DEFAULT_SERVER_URL = 'http://localhost:3000/mcp';
const CALLBACK_PORT = 8090;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;

/**
 * Scope-aware OAuth client provider demonstrating SEP-835 features
 * This example shows how to implement dynamic scope handling and upgrade flows
 */
class ScopeAwareOAuthClientProvider implements OAuthClientProvider {
  private _clientInformation?: OAuthClientInformationFull;
  private _tokens?: OAuthTokens;
  private _codeVerifier?: string;

  constructor(
    private readonly _redirectUrl: string | URL,
    private readonly _clientMetadata: OAuthClientMetadata,
    onRedirect?: (url: URL) => void
  ) {
    this._onRedirect = onRedirect || ((url) => {
      console.log(`🔀 Redirect to: ${url.toString()}`);
    });
  }

  private _onRedirect: (url: URL) => void;

  get redirectUrl(): string | URL {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata;
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this._clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationFull): void {
    this._clientInformation = clientInformation;
    console.log('💾 Saved client information with client_id:', clientInformation.client_id);
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
    console.log('🎫 Saved tokens with scopes:', tokens.scope || 'no scopes specified');
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const scopes = authorizationUrl.searchParams.get('scope');
    console.log('🔐 Redirecting to authorization with scopes:', scopes || 'none');
    this._onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error('No code verifier saved');
    }
    return this._codeVerifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
    console.log(`🗑️ Invalidating credentials: ${scope}`);
    switch (scope) {
      case 'all':
        this._clientInformation = undefined;
        this._tokens = undefined;
        this._codeVerifier = undefined;
        break;
      case 'client':
        this._clientInformation = undefined;
        break;
      case 'tokens':
        this._tokens = undefined;
        break;
      case 'verifier':
        this._codeVerifier = undefined;
        break;
    }
  }

  /**
   * SEP-835: Smart scope upgrade decision making
   * Demonstrates how clients can implement intelligent scope upgrade logic
   */
  shouldAttemptScopeUpgrade(
    currentScopes?: string[], 
    requiredScopes?: string[], 
    isInteractiveFlow?: boolean
  ): boolean {
    console.log('🤔 Scope upgrade decision:');
    console.log('   Current scopes:', currentScopes?.join(' ') || 'none');
    console.log('   Required scopes:', requiredScopes?.join(' ') || 'none');
    console.log('   Interactive flow:', isInteractiveFlow);

    // For this demo, always attempt upgrade for interactive flows
    // In production, you might want to:
    // - Check if user previously declined similar upgrades
    // - Validate that required scopes are reasonable
    // - Implement retry limits to prevent infinite authorization loops
    if (isInteractiveFlow) {
      console.log('✅ Attempting scope upgrade (interactive flow)');
      return true;
    } else {
      console.log('❌ Skipping scope upgrade (non-interactive flow)');
      return false;
    }
  }
}

/**
 * Enhanced MCP client demonstrating SEP-835 OAuth scope features
 */
class ScopeAwareOAuthClient {
  private client: Client | null = null;
  private readonly rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  constructor(private serverUrl: string) { }

  private async question(query: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(query, resolve);
    });
  }

  private async openBrowser(url: string): Promise<void> {
    console.log(`🌐 Opening browser for authorization: ${url}`);

    const command = `open "${url}"`;
    exec(command, (error) => {
      if (error) {
        console.error(`Failed to open browser: ${error.message}`);
        console.log(`Please manually open: ${url}`);
      }
    });
  }

  private async waitForOAuthCallback(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
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
          console.log(`✅ Authorization code received: ${code?.substring(0, 10)}...`);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body>
                <h1>✅ Authorization Successful!</h1>
                <p>OAuth scopes have been granted successfully.</p>
                <p>You can close this window and return to the terminal.</p>
                <script>setTimeout(() => window.close(), 2000);</script>
              </body>
            </html>
          `);

          resolve(code);
          setTimeout(() => server.close(), 3000);
        } else if (error) {
          console.log(`❌ Authorization error: ${error}`);
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body>
                <h1>❌ Authorization Failed</h1>
                <p>Error: ${error}</p>
                <p>This might be due to insufficient scope or user denial.</p>
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

      server.listen(CALLBACK_PORT, () => {
        console.log(`🔗 OAuth callback server started on http://localhost:${CALLBACK_PORT}`);
      });
    });
  }

  private async attemptConnection(oauthProvider: ScopeAwareOAuthClientProvider): Promise<void> {
    console.log('🚢 Creating transport with scope-aware OAuth provider...');
    const baseUrl = new URL(this.serverUrl);
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      authProvider: oauthProvider
    });
    console.log('🚢 Transport created');

    try {
      console.log('🔌 Attempting connection (this will trigger OAuth flow with optimal scope selection)...');
      await this.client!.connect(transport);
      console.log('✅ Connected successfully with appropriate scopes');
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        console.log('🔐 OAuth required - starting scope-aware authorization flow...');
        const callbackPromise = this.waitForOAuthCallback();
        const authCode = await callbackPromise;
        await transport.finishAuth(authCode);
        console.log('🔐 Authorization completed with granted scopes');
        console.log('🔌 Reconnecting with authenticated transport...');
        await this.attemptConnection(oauthProvider);
      } else {
        console.error('❌ Connection failed with non-auth error:', error);
        throw error;
      }
    }
  }

  async connect(): Promise<void> {
    console.log(`🔗 Connecting to ${this.serverUrl} with SEP-835 scope support...`);

    // SEP-835: Start with minimal scopes following principle of least privilege
    const clientMetadata: OAuthClientMetadata = {
      client_name: 'SEP-835 Scope-Aware MCP Client',
      redirect_uris: [CALLBACK_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'mcp:tools:read' // Start with minimal read-only scope
    };

    console.log('🔐 Creating scope-aware OAuth provider...');
    console.log('📋 Initial scope request: mcp:tools:read (following least privilege principle)');
    
    const oauthProvider = new ScopeAwareOAuthClientProvider(
      CALLBACK_URL,
      clientMetadata,
      (redirectUrl: URL) => {
        const requestedScopes = redirectUrl.searchParams.get('scope');
        console.log(`📌 OAuth redirect - requesting scopes: ${requestedScopes || 'none'}`);
        console.log(`🌐 Opening browser for authorization...`);
        this.openBrowser(redirectUrl.toString());
      }
    );

    console.log('👤 Creating MCP client...');
    this.client = new Client({
      name: 'scope-aware-oauth-client',
      version: '1.0.0',
    }, { capabilities: {} });

    console.log('🔐 Starting SEP-835 compliant OAuth flow...');
    await this.attemptConnection(oauthProvider);
    await this.interactiveLoop();
  }

  async interactiveLoop(): Promise<void> {
    console.log('\n🎯 SEP-835 Scope-Aware MCP Client');
    console.log('This client demonstrates intelligent scope handling:');
    console.log('• Starts with minimal scopes (principle of least privilege)');
    console.log('• Automatically upgrades scopes when needed');
    console.log('• Uses WWW-Authenticate headers for contextual scope selection');
    console.log('• Falls back to Protected Resource Metadata scopes');
    console.log('\nCommands:');
    console.log('  list - List available tools');
    console.log('  call <tool_name> [args] - Call a tool (may trigger scope upgrade)');
    console.log('  scopes - Show current token scopes');
    console.log('  quit - Exit the client');
    console.log();

    while (true) {
      try {
        const command = await this.question('mcp> ');

        if (!command.trim()) {
          continue;
        }

        if (command === 'quit') {
          console.log('\n👋 Goodbye!');
          this.close();
          process.exit(0);
        } else if (command === 'list') {
          await this.listTools();
        } else if (command === 'scopes') {
          await this.showCurrentScopes();
        } else if (command.startsWith('call ')) {
          await this.handleCallTool(command);
        } else {
          console.log('❌ Unknown command. Try \'list\', \'call <tool_name>\', \'scopes\', or \'quit\'');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'SIGINT') {
          console.log('\n\n👋 Goodbye!');
          break;
        }
        console.error('❌ Error:', error);
      }
    }
  }

  private async showCurrentScopes(): Promise<void> {
    // In a real implementation, you'd get this from the OAuth provider
    console.log('🎫 Current token scopes: (this would show actual token scopes)');
    console.log('   Note: In a real implementation, this would display the');
    console.log('   actual scopes granted in the current access token.');
  }

  private async listTools(): Promise<void> {
    if (!this.client) {
      console.log('❌ Not connected to server');
      return;
    }

    try {
      console.log('📋 Listing tools (may require mcp:tools:read scope)...');
      const request: ListToolsRequest = {
        method: 'tools/list',
        params: {},
      };

      const result = await this.client.request(request, ListToolsResultSchema);

      if (result.tools && result.tools.length > 0) {
        console.log('\n📋 Available tools:');
        result.tools.forEach((tool, index) => {
          console.log(`${index + 1}. ${tool.name}`);
          if (tool.description) {
            console.log(`   Description: ${tool.description}`);
          }
          console.log();
        });
      } else {
        console.log('No tools available');
      }
    } catch (error) {
      console.error('❌ Failed to list tools (might need scope upgrade):', error);
    }
  }

  private async handleCallTool(command: string): Promise<void> {
    const parts = command.split(/\s+/);
    const toolName = parts[1];

    if (!toolName) {
      console.log('❌ Please specify a tool name');
      return;
    }

    let toolArgs: Record<string, unknown> = {};
    if (parts.length > 2) {
      const argsString = parts.slice(2).join(' ');
      try {
        toolArgs = JSON.parse(argsString);
      } catch {
        console.log('❌ Invalid arguments format (expected JSON)');
        return;
      }
    }

    await this.callTool(toolName, toolArgs);
  }

  private async callTool(toolName: string, toolArgs: Record<string, unknown>): Promise<void> {
    if (!this.client) {
      console.log('❌ Not connected to server');
      return;
    }

    try {
      console.log(`🔧 Calling tool '${toolName}' (may require additional scopes)...`);
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArgs,
        },
      };

      const result = await this.client.request(request, CallToolResultSchema);

      console.log(`\n🔧 Tool '${toolName}' result:`);
      if (result.content) {
        result.content.forEach((content) => {
          if (content.type === 'text') {
            console.log(content.text);
          } else {
            console.log(content);
          }
        });
      } else {
        console.log(result);
      }
    } catch (error) {
      console.error(`❌ Failed to call tool '${toolName}' (scope upgrade may be needed):`, error);
    }
  }

  close(): void {
    this.rl.close();
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const serverUrl = process.env.MCP_SERVER_URL || DEFAULT_SERVER_URL;

  console.log('🚀 SEP-835 Scope-Aware MCP OAuth Client');
  console.log('📋 Demonstrates intelligent OAuth scope handling');
  console.log(`🔗 Connecting to: ${serverUrl}`);
  console.log();

  const client = new ScopeAwareOAuthClient(serverUrl);

  process.on('SIGINT', () => {
    console.log('\n\n👋 Goodbye!');
    client.close();
    process.exit(0);
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to start client:', error);
    process.exit(1);
  } finally {
    client.close();
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}