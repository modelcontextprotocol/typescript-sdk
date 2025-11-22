#!/usr/bin/env node

import { Client } from '../../client/index.js';
import { StreamableHTTPClientTransport } from '../../client/streamableHttp.js';
import { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '../../shared/auth.js';
import { OAuthClientProvider } from '../../client/auth.js';

const DEFAULT_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp';

class InMemoryOAuthClientProvider implements OAuthClientProvider {
    constructor(
        private readonly _clientMetadata: OAuthClientMetadata,
        private readonly addAuth?: OAuthClientProvider['addClientAuthentication']
    ) {}

    private _tokens?: OAuthTokens;
    private _client?: OAuthClientInformationMixed;

    get redirectUrl(): string | URL {
        return 'http://localhost/void';
    }
    get clientMetadata(): OAuthClientMetadata {
        return this._clientMetadata;
    }
    clientInformation(): OAuthClientInformationMixed | undefined {
        return this._client;
    }
    saveClientInformation(info: OAuthClientInformationMixed): void {
        this._client = info;
    }
    tokens(): OAuthTokens | undefined {
        return this._tokens;
    }
    saveTokens(tokens: OAuthTokens): void {
        this._tokens = tokens;
    }
    redirectToAuthorization(): void {
        // Not used for client_credentials
    }
    saveCodeVerifier(): void {
        // Not used for client_credentials
    }
    codeVerifier(): string {
        throw new Error('Not used for client_credentials');
    }
    addClientAuthentication = this.addAuth;
}

async function main() {
    // Option A: client_secret_post
    const clientMetadata: OAuthClientMetadata = {
        client_name: 'Client-Credentials Demo',
        redirect_uris: ['http://localhost/void'],
        grant_types: ['client_credentials'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'mcp:tools'
    };

    // Option B: private_key_jwt (uncomment and configure to test)
    // const addAuth = createPrivateKeyJwtAuth({
    //     issuer: 'your-client-id',
    //     subject: 'your-client-id',
    //     privateKey: process.env.PRIVATE_KEY_PEM as string,
    //     alg: 'RS256'
    // });

    const provider = new InMemoryOAuthClientProvider(clientMetadata /*, addAuth*/);
    const client = new Client({ name: 'cc-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(DEFAULT_SERVER_URL), { authProvider: provider });

    await client.connect(transport);
    console.log('Connected with client_credentials token.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
