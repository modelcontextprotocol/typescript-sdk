import express from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { OAuthMetadata, OAuthProtectedResourceMetadata, OAuthTokens, OAuthClientInformationFull } from '../../shared/auth.js';

export interface MockOAuthServerConfig {
  supportsPKCE: boolean;
  supportsResourceIndicators: boolean;
  requiresResourceParameter: boolean;
  validationMode: 'strict' | 'lenient';
  serverUrl: string;
  authorizationServers?: string[];
  simulateErrors?: {
    metadataDiscovery?: boolean;
    authorization?: boolean;
    tokenExchange?: boolean;
    tokenRefresh?: boolean;
    introspection?: boolean;
  };
}

interface StoredAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scopes?: string[];
  state?: string;
  resource?: string;
  expiresAt: number;
}

interface StoredToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  refreshToken?: string;
}

interface StoredClient {
  client_id: string;
  client_name?: string;
  client_secret?: string;
  redirect_uris: string[];
  allowed_resources?: string[];
}

export class MockOAuthServer {
  private app: express.Express;
  private config: MockOAuthServerConfig;
  private authCodes: Map<string, StoredAuthCode> = new Map();
  private tokens: Map<string, StoredToken> = new Map();
  private refreshTokens: Map<string, StoredToken> = new Map();
  private clients: Map<string, StoredClient> = new Map();
  private server: { close: (callback: () => void) => void } | null = null;

  constructor(config: MockOAuthServerConfig) {
    this.config = config;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // CORS middleware
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });
  }

  private setupRoutes() {
    // OAuth metadata endpoint
    this.app.get('/.well-known/oauth-authorization-server', (req, res) => {
      if (this.config.simulateErrors?.metadataDiscovery) {
        res.status(500).json({ error: 'server_error' });
        return;
      }
      res.json(this.getMetadata());
    });

    // Alternative OpenID configuration endpoint
    this.app.get('/.well-known/openid-configuration', (req, res) => {
      if (this.config.simulateErrors?.metadataDiscovery) {
        res.status(500).json({ error: 'server_error' });
        return;
      }
      res.json(this.getMetadata());
    });

    // Protected resource metadata endpoint
    this.app.get('/.well-known/oauth-protected-resource', (req, res) => {
      const metadata: OAuthProtectedResourceMetadata = {
        resource: this.config.serverUrl,
        authorization_servers: this.config.authorizationServers || [this.config.serverUrl]
      };
      res.json(metadata);
    });

    // Client registration endpoint
    this.app.post('/register', (req, res) => {
      const clientId = `client_${randomUUID()}`;
      const client: StoredClient = {
        client_id: clientId,
        client_name: req.body.client_name,
        redirect_uris: req.body.redirect_uris || [],
        allowed_resources: req.body.allowed_resources
      };
      
      this.clients.set(clientId, client);
      
      const response: OAuthClientInformationFull = {
        client_id: clientId,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris
      };
      
      res.status(201).json(response);
    });

    // Authorization endpoint
    this.app.get('/authorize', (req, res) => {
      if (this.config.simulateErrors?.authorization) {
        res.status(500).json({ error: 'server_error' });
        return;
      }
      
      const {
        client_id,
        redirect_uri,
        response_type,
        code_challenge,
        code_challenge_method,
        scope,
        state,
        resource
      } = req.query;

      // Validate required parameters
      if (!client_id || !redirect_uri || response_type !== 'code') {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }

      // Validate PKCE if required
      if (this.config.supportsPKCE && !code_challenge) {
        res.status(400).json({ error: 'invalid_request', error_description: 'PKCE required' });
        return;
      }

      // Validate resource parameter if required
      if (this.config.requiresResourceParameter && !resource) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Resource parameter required' });
        return;
      }

      // Validate resource parameter format
      if (resource && this.config.validationMode === 'strict') {
        try {
          const url = new URL(resource as string);
          if (url.hash) {
            res.status(400).json({ error: 'invalid_target', error_description: 'Resource URI must not contain fragment' });
            return;
          }
        } catch {
          res.status(400).json({ error: 'invalid_target', error_description: 'Invalid resource URI' });
          return;
        }
      }

      // Generate authorization code
      const code = `code_${randomUUID()}`;
      const authCode: StoredAuthCode = {
        code,
        clientId: client_id as string,
        redirectUri: redirect_uri as string,
        codeChallenge: code_challenge as string,
        codeChallengeMethod: code_challenge_method as string,
        scopes: scope ? (scope as string).split(' ') : [],
        state: state as string,
        resource: resource as string,
        expiresAt: Date.now() + 600000 // 10 minutes
      };
      
      this.authCodes.set(code, authCode);

      // Redirect back with code
      const redirectUrl = new URL(redirect_uri as string);
      redirectUrl.searchParams.set('code', code);
      if (state) {
        redirectUrl.searchParams.set('state', state as string);
      }
      
      res.redirect(redirectUrl.toString());
    });

    // Token endpoint
    this.app.post('/token', (req, res) => {
      if (this.config.simulateErrors?.tokenExchange) {
        res.status(500).json({ error: 'server_error' });
        return;
      }

      const { grant_type } = req.body;

      if (grant_type === 'authorization_code') {
        this.handleAuthorizationCodeGrant(req, res);
      } else if (grant_type === 'refresh_token') {
        this.handleRefreshTokenGrant(req, res);
      } else {
        res.status(400).json({ error: 'unsupported_grant_type' });
      }
    });

    // Introspection endpoint
    this.app.post('/introspect', (req, res) => {
      if (this.config.simulateErrors?.introspection) {
        res.status(500).json({ error: 'server_error' });
        return;
      }

      const { token } = req.body;
      const tokenData = this.tokens.get(token);

      if (!tokenData || tokenData.expiresAt < Date.now()) {
        res.json({ active: false });
        return;
      }

      res.json({
        active: true,
        scope: tokenData.scopes.join(' '),
        client_id: tokenData.clientId,
        exp: Math.floor(tokenData.expiresAt / 1000),
        resource: tokenData.resource
      });
    });
  }

  private handleAuthorizationCodeGrant(req: Request, res: Response) {
    const {
      code,
      code_verifier,
      client_id,
      redirect_uri,
      resource
    } = req.body;

    const authCode = this.authCodes.get(code);
    if (!authCode) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }

    // Check expiration
    if (authCode.expiresAt < Date.now()) {
      this.authCodes.delete(code);
      res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
      return;
    }

    // Validate client
    if (authCode.clientId !== client_id) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Client mismatch' });
      return;
    }

    // Validate redirect URI
    if (authCode.redirectUri !== redirect_uri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' });
      return;
    }

    // Validate PKCE
    if (authCode.codeChallenge) {
      if (!code_verifier) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Code verifier required' });
        return;
      }

      const verifierHash = createHash('sha256').update(code_verifier).digest('base64url');
      if (verifierHash !== authCode.codeChallenge) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid code verifier' });
        return;
      }
    }

    // Validate resource consistency
    if (authCode.resource && resource && authCode.resource !== resource) {
      res.status(400).json({ error: 'invalid_target', error_description: 'Resource mismatch' });
      return;
    }

    // Generate tokens
    const accessToken = `access_${randomUUID()}`;
    const refreshToken = `refresh_${randomUUID()}`;
    
    const tokenData: StoredToken = {
      token: accessToken,
      clientId: authCode.clientId,
      scopes: authCode.scopes || [],
      resource: authCode.resource || resource,
      expiresAt: Date.now() + 3600000, // 1 hour
      refreshToken
    };

    this.tokens.set(accessToken, tokenData);
    this.refreshTokens.set(refreshToken, tokenData);
    this.authCodes.delete(code);

    const response: OAuthTokens = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken
    };
    
    // Only include scope if there are scopes
    if (tokenData.scopes.length > 0) {
      response.scope = tokenData.scopes.join(' ');
    }

    res.json(response);
  }

  private handleRefreshTokenGrant(req: Request, res: Response) {
    if (this.config.simulateErrors?.tokenRefresh) {
      res.status(500).json({ error: 'server_error' });
      return;
    }

    const { refresh_token, scope, resource } = req.body;

    const tokenData = this.refreshTokens.get(refresh_token);
    if (!tokenData) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }

    // Validate requested scopes are subset of original
    if (scope) {
      const requestedScopes = scope.split(' ');
      const validScopes = requestedScopes.every((s: string) => tokenData.scopes.includes(s));
      if (!validScopes) {
        res.status(400).json({ error: 'invalid_scope' });
        return;
      }
    }

    // Generate new access token
    const newAccessToken = `access_${randomUUID()}`;
    const newTokenData: StoredToken = {
      ...tokenData,
      token: newAccessToken,
      scopes: scope ? scope.split(' ') : tokenData.scopes,
      resource: resource || tokenData.resource,
      expiresAt: Date.now() + 3600000
    };

    this.tokens.set(newAccessToken, newTokenData);

    const response: OAuthTokens = {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token,
      scope: newTokenData.scopes.join(' ')
    };

    res.json(response);
  }

  getMetadata(): OAuthMetadata {
    return {
      issuer: this.config.serverUrl,
      authorization_endpoint: `${this.config.serverUrl}/authorize`,
      token_endpoint: `${this.config.serverUrl}/token`,
      registration_endpoint: `${this.config.serverUrl}/register`,
      introspection_endpoint: `${this.config.serverUrl}/introspect`,
      scopes_supported: ['read', 'write', 'profile'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: this.config.supportsPKCE ? ['S256'] : undefined,
      authorization_response_iss_parameter_supported: true
    };
  }

  async start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // Test helper methods
  addClient(client: StoredClient) {
    this.clients.set(client.client_id, client);
  }

  getAuthCode(code: string): StoredAuthCode | undefined {
    return this.authCodes.get(code);
  }

  getToken(token: string): StoredToken | undefined {
    return this.tokens.get(token);
  }

  clearAll() {
    this.authCodes.clear();
    this.tokens.clear();
    this.refreshTokens.clear();
    this.clients.clear();
  }
}