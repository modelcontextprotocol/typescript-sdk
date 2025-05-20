import { OAuthClientInformationFull, OAuthMetadata, OAuthTokens } from "src/shared/auth.js";
import { Response } from "express";
import { AuthorizationParams, OAuthServerProvider } from "src/server/auth/provider.js";
import { OAuthRegisteredClientsStore } from "src/server/auth/clients.js";
import { AuthInfo } from "src/server/auth/types.js";


/**
 * An OAuthProvider that forwards requests to endpoints provided in OAuthMetadata.
 *
 * This provider acts as a client to an external OAuth server and forwards
 * all authorization, token, and verification requests.
 */
export class ForwardingOAuthProvider implements OAuthServerProvider {
  private metadata: OAuthMetadata;
  // private clients = new Map<string, OAuthClientInformationFull>();

  constructor(oauthMetadata: OAuthMetadata) {
    this.metadata = oauthMetadata;
  }

  // This is not needed.
  clientsStore: OAuthRegisteredClientsStore = {
    async getClient(_clientId: string) {
      throw new Error("Not Implemented");
    },

    async registerClient(_clientMetadata: OAuthClientInformationFull) {
      throw new Error("Not Implemented");
    }
  };

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Forward to authorization endpoint from metadata
    const authEndpoint = this.metadata.authorization_endpoint;

    const searchParams = new URLSearchParams({
      client_id: client.client_id,
      response_type: 'code',
      redirect_uri: client.redirect_uris[0],
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
    });

    if (params.state) {
      searchParams.set('state', params.state);
    }

    if (params.scopes && params.scopes.length > 0) {
      searchParams.set('scope', params.scopes.join(' '));
    }

    const authUrl = new URL(authEndpoint);
    authUrl.search = searchParams.toString();

    res.redirect(authUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    _authorizationCode: string
  ): Promise<string> {
    throw new Error("Not Implemented");
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string
  ): Promise<OAuthTokens> {
    // Forward to token endpoint from metadata
    const tokenEndpoint = this.metadata.token_endpoint;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
    });

    if (codeVerifier) {
      params.append('code_verifier', codeVerifier);
    }

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Failed to exchange token: ${response.statusText}`);
    }

    return await response.json();
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[]
  ): Promise<OAuthTokens> {
    // Not implemented for brevity, but follows token above.
    throw new Error("Not Implemented");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Use introspection endpoint if available, or userinfo endpoint
    const endpoint = this.metadata.introspection_endpoint;

    if (!endpoint) {
      throw new Error('No token verification endpoint available in metadata');
    }

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error('Invalid or expired token');
    }

    const data = await response.json();

    // Convert the response to AuthInfo format
    return {
      token,
      clientId: data.client_id || data.azp,
      scopes: data.scope ? data.scope.split(' ') : [],
      expiresAt: data.exp || Math.floor(Date.now() / 1000) + 3600,
    };
  }
}
