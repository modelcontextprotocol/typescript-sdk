#!/usr/bin/env node

import { Client } from '../../client/index.js';
import { StreamableHTTPClientTransport } from '../../client/streamableHttp.js';
import { JwtAssertionSigningOptions, OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '../../shared/auth.js';
import { OAuthClientProvider, auth } from '../../client/auth.js';

const DEFAULT_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp';

class InMemoryJwtBearerProvider implements OAuthClientProvider {
    constructor(
        private readonly _clientMetadata: OAuthClientMetadata,
        private readonly _jwtSigningOptions: JwtAssertionSigningOptions
    ) {}

    private _tokens?: OAuthTokens;
    private _client?: OAuthClientInformationMixed;

    get redirectUrl(): string | URL {
        // Not used for JWT-bearer grant
        return 'http://localhost/void';
    }

    get clientMetadata(): OAuthClientMetadata {
        return this._clientMetadata;
    }

    clientMetadataUrl?: string | undefined;

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

    // The following methods are part of the interface but are not used for JWT-bearer M2M flows.
    redirectToAuthorization(): void {
        throw new Error('redirectToAuthorization is not used for JWT-bearer grant');
    }

    saveCodeVerifier(): void {
        // Not used for JWT-bearer
    }

    codeVerifier(): string {
        throw new Error('codeVerifier is not used for JWT-bearer grant');
    }

    async state(): Promise<string> {
        // Not used in this example
        return '';
    }

    /**
     * Simple helper to perform a JWT-bearer token exchange when needed.
     * This can be called by consumers before connecting, or wired into a higher-level helper.
     */
    async ensureJwtBearerTokens(serverUrl: URL): Promise<void> {
        if (this._tokens?.access_token) {
            return;
        }

        // Use the high-level auth() API with jwtBearerOptions, which now performs a
        // client_credentials grant with private_key_jwt client authentication.
        const result = await auth(this, {
            serverUrl,
            jwtBearerOptions: this._jwtSigningOptions
        });

        if (result !== 'AUTHORIZED') {
            throw new Error('Failed to obtain JWT-bearer access token');
        }
    }
}

async function main() {
    const clientMetadata: OAuthClientMetadata = {
        client_name: 'JWT-Bearer Demo',
        redirect_uris: ['http://localhost/void'],
        grant_types: ['urn:ietf:params:oauth:grant-type:jwt-bearer'],
        scope: 'mcp:tools'
    };

    const jwtSigningOptions: JwtAssertionSigningOptions = {
        issuer: process.env.MCP_CLIENT_ID || 'your-client-id',
        subject: process.env.MCP_CLIENT_ID || 'your-client-id',
        privateKey: process.env.MCP_CLIENT_PRIVATE_KEY_PEM as string,
        alg: 'RS256'
    };

    const provider = new InMemoryJwtBearerProvider(clientMetadata, jwtSigningOptions);

    await provider.ensureJwtBearerTokens(new URL(DEFAULT_SERVER_URL));

    const client = new Client({ name: 'jwt-bearer-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(DEFAULT_SERVER_URL), { authProvider: provider });

    await client.connect(transport);
    console.log('Connected with JWT-bearer access token.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
