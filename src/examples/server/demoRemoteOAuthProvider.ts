import { OAuthClientInformationFull, OAuthMetadata, OAuthTokens } from "src/shared/auth.js";
import { Response } from "express";
import { AuthorizationParams, OAuthServerProvider } from "src/server/auth/provider.js";
import { OAuthRegisteredClientsStore } from "src/server/auth/clients.js";
import { AuthInfo } from "src/server/auth/types.js";


/**
 * An OAuthProvider that forwards requests to endpoints provided in OAuthMetadata.
 *
 * This is meant for an MCP server acting solely as a Resource Server and
 * relying on a separate Authorization server. For more details, see:
 * https://modelcontextprotocol.io/specification/draft/basic/authorization#2-2-roles
 *
 * This provider acts as a client to an external OAuth server and forwards
 * all authorization, token, and verification requests.
 */
export class DemoRemoteOAuthProvider implements OAuthServerProvider {
  private metadata: OAuthMetadata;

  constructor(oauthMetadata: OAuthMetadata) {
    this.metadata = oauthMetadata;// Validate required endpoints exist in the metadata
    // For token verification, either introspection endpoint or userinfo endpoint is needed
    if (!oauthMetadata.introspection_endpoint) {
      throw new Error('Missing required introspection_endpoint in OAuth metadata');
    }
  }

  // This is not needed, since the AS handles client registration
  clientsStore: OAuthRegisteredClientsStore = {
    async getClient(_clientId: string) {
      throw new Error("Not Implemented");
    },

    async registerClient(_clientMetadata: OAuthClientInformationFull) {
      throw new Error("Not Implemented");
    }
  };

  async authorize(
    _client: OAuthClientInformationFull,
    _params: AuthorizationParams,
    _res: Response
  ): Promise<void> {
    // Not implemented, this is handled by the authorization server.
    throw new Error("Not Implemented");
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    _authorizationCode: string
  ): Promise<string> {
    // Not implemented, this is handled by the authorization server.
    throw new Error("Not Implemented");
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    _authorizationCode: string,
    _codeVerifier?: string
  ): Promise<OAuthTokens> {
    // Not implemented, this is handled by the authorization server.
    throw new Error("Not Implemented");
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[]
  ): Promise<OAuthTokens> {
    // Not implemented, this is handled by the authorization server.
    throw new Error("Not Implemented");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Use introspection endpoint if available
    const endpoint = this.metadata.introspection_endpoint;

    if (!endpoint) {
      throw new Error('No token verification endpoint available in metadata');
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        token: token
      }).toString()
    });


    if (!response.ok) {
      throw new Error(`Invalid or expired token: ${await response.text()}`);
    }

    const data = await response.json();

    // Convert the response to AuthInfo format
    return {
      token,
      clientId: data.client_id,
      scopes: data.scope ? data.scope.split(' ') : [],
      expiresAt: data.exp,
    };
  }
}
