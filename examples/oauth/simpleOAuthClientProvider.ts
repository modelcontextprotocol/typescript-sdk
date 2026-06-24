import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthClientProvider,
    OAuthDiscoveryState,
    OAuthTokens
} from '@modelcontextprotocol/client';
import { validateClientMetadataUrl } from '@modelcontextprotocol/client';

/**
 * In-memory OAuth client provider for demonstration purposes.
 * In production, you should persist tokens and client credentials securely.
 *
 * Tokens and client credentials are stored as single-slot blobs. The SDK stamps an
 * `issuer` field onto every value it saves; round-tripping the blob unchanged means
 * a credential issued by one authorization server is never reused at another (the
 * SDK reads the stamp back as a key-not-found and re-registers / re-authorizes).
 * To hold credentials for several authorization servers at once, key your storage
 * on the `ctx.issuer` argument instead.
 */
export class InMemoryOAuthClientProvider implements OAuthClientProvider {
    private _clientInformation?: OAuthClientInformationMixed;
    private _tokens?: OAuthTokens;
    private _codeVerifier?: string;
    private _discoveryState?: OAuthDiscoveryState;

    constructor(
        private readonly _redirectUrl: string | URL,
        private readonly _clientMetadata: OAuthClientMetadata,
        onRedirect?: (url: URL) => void,
        public readonly clientMetadataUrl?: string
    ) {
        // Validate clientMetadataUrl at construction time (fail-fast)
        validateClientMetadataUrl(clientMetadataUrl);

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

    saveDiscoveryState(state: OAuthDiscoveryState): void {
        this._discoveryState = state;
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        return this._discoveryState;
    }

    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
        if (scope === 'all' || scope === 'client') this._clientInformation = undefined;
        if (scope === 'all' || scope === 'tokens') this._tokens = undefined;
        if (scope === 'all' || scope === 'verifier') this._codeVerifier = undefined;
        if (scope === 'all' || scope === 'discovery') this._discoveryState = undefined;
    }
}
