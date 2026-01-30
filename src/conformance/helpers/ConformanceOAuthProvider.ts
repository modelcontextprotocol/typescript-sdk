import type {
    OAuthClientProvider,
    OAuthClientInformation,
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthTokens
} from '@modelcontextprotocol/client';

export class ConformanceOAuthProvider implements OAuthClientProvider {
    private _clientInformation?: OAuthClientInformationFull;
    private _tokens?: OAuthTokens;
    private _codeVerifier?: string;
    private _authCode?: string;
    private _authCodePromise?: Promise<string>;

    constructor(
        private readonly _redirectUrl: string | URL,
        private readonly _clientMetadata: OAuthClientMetadata,
        private readonly _clientMetadataUrl?: string | URL
    ) {}

    get redirectUrl(): string | URL {
        return this._redirectUrl;
    }

    get clientMetadata(): OAuthClientMetadata {
        return this._clientMetadata;
    }

    get clientMetadataUrl(): string | undefined {
        return this._clientMetadataUrl?.toString();
    }

    clientInformation(): OAuthClientInformation | undefined {
        return this._clientInformation;
    }

    saveClientInformation(clientInformation: OAuthClientInformationFull): void {
        this._clientInformation = clientInformation;
    }

    tokens(): OAuthTokens | undefined {
        return this._tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this._tokens = tokens;
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        try {
            const response = await fetch(authorizationUrl.toString(), {
                redirect: 'manual' // Don't follow redirects automatically
            });

            // Get the Location header which contains the redirect with auth code
            const location = response.headers.get('location');
            if (location) {
                const redirectUrl = new URL(location);
                const code = redirectUrl.searchParams.get('code');
                if (code) {
                    this._authCode = code;
                    return;
                } else {
                    throw new Error('No auth code in redirect URL');
                }
            } else {
                throw new Error(`No redirect location received, from '${authorizationUrl.toString()}'`);
            }
        } catch (error) {
            console.error('Failed to fetch authorization URL:', error);
            throw error;
        }
    }

    async getAuthCode(): Promise<string> {
        if (this._authCode) {
            return this._authCode;
        }
        throw new Error('No authorization code');
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
