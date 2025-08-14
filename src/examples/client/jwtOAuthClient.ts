import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { URL } from 'node:url';
import { exec } from 'node:child_process';
import { Client } from '../../client/index.js';
import { StreamableHTTPClientTransport } from '../../client/streamableHttp.js';
import {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
  JWTClientCredentials
} from '../../shared/auth.js';
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
 * JWT-based OAuth client provider that fully utilizes auth.ts infrastructure
 * No custom authentication logic - everything is handled by the framework
 */
class JWTOAuthClientProvider implements OAuthClientProvider {
  private _clientInformation?: OAuthClientInformationFull;
  private _tokens?: OAuthTokens;
  private _codeVerifier?: string;

  constructor(
    private readonly _redirectUrl: string | URL,
    private readonly _clientMetadata: OAuthClientMetadata,
    private readonly _jwtCredentials?: JWTClientCredentials,
    private readonly _jwtBearerAssertion?: string,
    onRedirect?: (url: URL) => void
  ) {
    this._onRedirect = onRedirect || ((url) => {
      console.log(`Redirect to: ${url.toString()}`);
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
    console.log('💾 Saved client information:', {
      client_id: clientInformation.client_id,
      client_secret: clientInformation.client_secret ? '[REDACTED]' : undefined,
      token_endpoint_auth_method: clientInformation.token_endpoint_auth_method
    });
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
    console.log('🎫 Saved tokens:', {
      access_token: tokens.access_token ? `${tokens.access_token.substring(0, 20)}...` : undefined,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      scope: tokens.scope
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
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

  /**
   * Provide JWT credentials - auth.ts will use these automatically for:
   * 1. JWT bearer assertion generation
   * 2. Client authentication method selection
   * 3. JWT client assertion generation
   */
  jwtCredentials(): JWTClientCredentials | undefined {
    return this._jwtCredentials;
  }

  /**
   * Get pre-provided JWT bearer assertion - auth.ts will use this automatically
   */
  getJwtBearerAssertion(): string | undefined {
    return this._jwtBearerAssertion;
  }

  /**
   * Invalidate credentials on auth failures
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
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
}

/**
 * Interactive MCP client with JWT-based OAuth authentication
 * Fully utilizes auth.ts infrastructure - no custom auth logic
 */
class InteractiveJWTOAuthClient {
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

    const command = process.platform === 'darwin' ? `open "${url}"` :
      process.platform === 'win32' ? `start "${url}"` :
        `xdg-open "${url}"`;

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
                <h1>Authorization Successful!</h1>
                <p>JWT OAuth client authenticated successfully.</p>
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

      server.listen(CALLBACK_PORT, () => {
        console.log(`OAuth callback server started on http://localhost:${CALLBACK_PORT}`);
      });
    });
  }

  private createJWTCredentials(): JWTClientCredentials | undefined {
    const clientSecret = process.env.JWT_CLIENT_SECRET;
    const privateKey = process.env.JWT_PRIVATE_KEY;
    const algorithm = process.env.JWT_ALGORITHM as JWTClientCredentials['algorithm'];
    const keyId = process.env.JWT_KEY_ID;
    const tokenLifetime = process.env.JWT_TOKEN_LIFETIME ? parseInt(process.env.JWT_TOKEN_LIFETIME) : undefined;

    if (clientSecret || privateKey) {
      return {
        clientSecret,
        privateKey,
        algorithm: algorithm || (clientSecret ? 'HS256' : 'RS256'),
        keyId,
        tokenLifetime: tokenLifetime || 300
      };
    }

    return undefined;
  }

  private async getJWTBearerAssertion(): Promise<string | undefined> {
    const bearerAssertion = process.env.JWT_BEARER_ASSERTION;
    if (bearerAssertion) {
      console.log('🎫 Using provided JWT bearer assertion');
      return bearerAssertion;
    }

    return undefined;
  }

  /**
   * Simplified connection method that fully trusts auth.ts to handle everything
   */
  private async attemptConnection(oauthProvider: JWTOAuthClientProvider): Promise<void> {
    console.log('🚢 Creating transport with JWT OAuth provider...');
    const baseUrl = new URL(this.serverUrl);
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      authProvider: oauthProvider
    });
    console.log('🚢 Transport created');

    try {
      console.log('🔌 Attempting connection...');
      
      // Let auth.ts handle EVERYTHING:
      // - JWT bearer assertion generation from jwtCredentials()
      // - Pre-provided JWT bearer assertion handling
      // - Client authentication method selection
      // - JWT client assertion generation
      // - Authorization code flow fallback
      // - Token refresh
      // - Error handling and retries
      await this.client!.connect(transport);
      console.log('✅ Connected successfully with JWT authentication');
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        // Only handle the interactive part - let auth.ts handle the JWT logic
        console.log('🔐 Starting authorization code flow...');
        const callbackPromise = this.waitForOAuthCallback();
        const authCode = await callbackPromise;
        await transport.finishAuth(authCode);
        console.log('🔐 Authorization completed - reconnecting...');
        await this.attemptConnection(oauthProvider);
      } else {
        console.error('❌ Connection failed:', error);
        throw error;
      }
    }
  }

  async connect(): Promise<void> {
    console.log(`🔗 Attempting to connect to ${this.serverUrl}...`);
    console.log('🔑 JWT OAuth Client - fully integrated with auth.ts');

    const jwtCredentials = this.createJWTCredentials();
    if (jwtCredentials) {
      console.log('✅ JWT credentials loaded from environment');
      console.log('   Algorithm:', jwtCredentials.algorithm);
      console.log('   Key type:', jwtCredentials.clientSecret ? 'HMAC secret' : 'Private key');
    } else {
      console.log('⚠️  No JWT credentials found in environment variables');
    }

    const jwtBearerAssertion = await this.getJWTBearerAssertion();

    const clientMetadata: OAuthClientMetadata = {
      client_name: 'JWT OAuth MCP Client',
      redirect_uris: [CALLBACK_URL],
      grant_types: (jwtCredentials || jwtBearerAssertion) ?
        ['urn:ietf:params:oauth:grant-type:jwt-bearer', 'authorization_code', 'refresh_token'] :
        ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: jwtCredentials ?
        (jwtCredentials.clientSecret ? 'client_secret_jwt' : 'private_key_jwt') :
        'client_secret_post',
      scope: 'mcp:tools'
    };

    console.log('🔐 Creating JWT OAuth provider...');
    const oauthProvider = new JWTOAuthClientProvider(
      CALLBACK_URL,
      clientMetadata,
      jwtCredentials,
      jwtBearerAssertion,
      (redirectUrl: URL) => {
        console.log(`📌 OAuth redirect - opening browser`);
        this.openBrowser(redirectUrl.toString());
      }
    );

    console.log('👤 Creating MCP client...');
    this.client = new Client({
      name: 'jwt-oauth-client',
      version: '1.0.0',
    }, { capabilities: {} });

    console.log('🔐 Starting JWT OAuth flow...');
    await this.attemptConnection(oauthProvider);
    await this.interactiveLoop();
  }

  async interactiveLoop(): Promise<void> {
    console.log('\n🎯 Interactive MCP Client with JWT OAuth');
    console.log('Commands: list, call <tool_name> [args], quit');
    console.log();

    while (true) {
      try {
        const command = await this.question('mcp-jwt> ');

        if (!command.trim()) continue;

        if (command === 'quit') {
          console.log('\n👋 Goodbye!');
          this.close();
          process.exit(0);
        } else if (command === 'list') {
          await this.listTools();
        } else if (command.startsWith('call ')) {
          await this.handleCallTool(command);
        } else {
          console.log('❌ Unknown command. Try \'list\', \'call <tool_name>\', or \'quit\'');
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

  private async listTools(): Promise<void> {
    if (!this.client) {
      console.log('❌ Not connected to server');
      return;
    }

    try {
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
      console.error('❌ Failed to list tools:', error);
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
      console.error(`❌ Failed to call tool '${toolName}':`, error);
    }
  }

  close(): void {
    this.rl.close();
  }
}

function printUsage(): void {
  console.log('🔑 JWT OAuth Client Configuration');
  console.log('================================');
  console.log('Environment Variables:');
  console.log('  JWT_CLIENT_SECRET    - HMAC secret for client authentication');
  console.log('  JWT_PRIVATE_KEY      - RSA/ECDSA private key for client authentication');
  console.log('  JWT_ALGORITHM        - JWT signing algorithm (default: HS256/RS256)');
  console.log('  JWT_KEY_ID           - Key ID for JWT header (optional)');
  console.log('  JWT_TOKEN_LIFETIME   - Token lifetime in seconds (default: 300)');
  console.log('  JWT_BEARER_ASSERTION - Pre-generated JWT bearer assertion');
  console.log('  MCP_SERVER_URL       - MCP server URL (default: http://localhost:3000/mcp)');
  console.log();
  console.log('Examples:');
  console.log('  export JWT_CLIENT_SECRET="your-secret-key"');
  console.log('  export JWT_BEARER_ASSERTION="eyJ0eXAiOiJKV1Q..."');
  console.log();
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const serverUrl = process.env.MCP_SERVER_URL || DEFAULT_SERVER_URL;

  console.log('🚀 JWT OAuth MCP Client (Simplified)');
  console.log(`Connecting to: ${serverUrl}`);
  console.log();

  const client = new InteractiveJWTOAuthClient(serverUrl);

  process.on('SIGINT', () => {
    console.log('\n\n👋 Goodbye!');
    client.close();
    process.exit(0);
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to start JWT OAuth client:', error);
    console.log('\nFor configuration help, run: node jwtOAuthClient.js --help');
    process.exit(1);
  } finally {
    client.close();
  }
}

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('jwtOAuthClient_simplified.ts') ||
  process.argv[1].endsWith('jwtOAuthClient_simplified.js')
);

if (isMainModule) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

export { InteractiveJWTOAuthClient, JWTOAuthClientProvider };