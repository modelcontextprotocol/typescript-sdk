import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthClientProvider, OAuthTokens } from '@modelcontextprotocol/client';

/**
 * In-memory OAuth client provider for demonstration purposes
 * In production, you should persist tokens securely
 */
export class InMemoryOAuthClientProvider implements OAuthClientProvider {
    private _clientInformation?: OAuthClientInformationMixed;
    private _tokens?: OAuthTokens;
    private _codeVerifier?: string;

    constructor(
        private readonly _redirectUrl: string | URL,
        private readonly _clientMetadata: OAuthClientMetadata,
        onRedirect?: (url: URL) => void,
        public readonly clientMetadataUrl?: string
    ) {
        this._onRedirect =
            onRedirect ||
            (url => {
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

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this._clientInformation;
    }

    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
        this._clientInformation = clientInformation;
    }

    tokens(): OAuthTokens | undefined {
        return this._tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this._tokens = tokens;
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
}
