import { mcpAuthRouter, AuthRouterOptions } from './router.js';
import { OAuthServerProvider, AuthorizationParams } from './provider.js';
import { OAuthRegisteredClientsStore } from './clients.js';
import { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '../../shared/auth.js';
import express, { Response } from 'express';
import supertest from 'supertest';
import { AuthInfo } from './types.js';
import { InvalidTokenError } from './errors.js';

describe('MCP Auth Router', () => {
  // Setup mock provider with full capabilities
  const mockClientStore: OAuthRegisteredClientsStore = {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      if (clientId === 'valid-client') {
        return {
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          redirect_uris: ['https://example.com/callback']
        };
      }
      return undefined;
    },

    async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
      return client;
    }
  };

  const mockProvider: OAuthServerProvider = {
    clientsStore: mockClientStore,

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
      const redirectUrl = new URL(params.redirectUri);
      redirectUrl.searchParams.set('code', 'mock_auth_code');
      if (params.state) {
        redirectUrl.searchParams.set('state', params.state);
      }
      res.redirect(302, redirectUrl.toString());
    },

    async challengeForAuthorizationCode(): Promise<string> {
      return 'mock_challenge';
    },

    async exchangeAuthorizationCode(): Promise<OAuthTokens> {
      return {
        access_token: 'mock_access_token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'mock_refresh_token'
      };
    },

    async exchangeRefreshToken(): Promise<OAuthTokens> {
      return {
        access_token: 'new_mock_access_token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'new_mock_refresh_token'
      };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token === 'valid_token') {
        return {
          token,
          clientId: 'valid-client',
          scopes: ['read', 'write'],
          expiresAt: Date.now() / 1000 + 3600
        };
      }
      throw new InvalidTokenError('Token is invalid or expired');
    },

    async revokeToken(_client: OAuthClientInformationFull, _request: OAuthTokenRevocationRequest): Promise<void> {
      // Success - do nothing in mock
    }
  };

  // Provider without registration and revocation
  const mockProviderMinimal: OAuthServerProvider = {
    clientsStore: {
      async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        if (clientId === 'valid-client') {
          return {
            client_id: 'valid-client',
            client_secret: 'valid-secret',
            redirect_uris: ['https://example.com/callback']
          };
        }
        return undefined;
      }
    },

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
      const redirectUrl = new URL(params.redirectUri);
      redirectUrl.searchParams.set('code', 'mock_auth_code');
      if (params.state) {
        redirectUrl.searchParams.set('state', params.state);
      }
      res.redirect(302, redirectUrl.toString());
    },

    async challengeForAuthorizationCode(): Promise<string> {
      return 'mock_challenge';
    },

    async exchangeAuthorizationCode(): Promise<OAuthTokens> {
      return {
        access_token: 'mock_access_token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'mock_refresh_token'
      };
    },

    async exchangeRefreshToken(): Promise<OAuthTokens> {
      return {
        access_token: 'new_mock_access_token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'new_mock_refresh_token'
      };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token === 'valid_token') {
        return {
          token,
          clientId: 'valid-client',
          scopes: ['read'],
          expiresAt: Date.now() / 1000 + 3600
        };
      }
      throw new InvalidTokenError('Token is invalid or expired');
    }
  };

  describe('Router creation', () => {
    it('throws error for non-HTTPS issuer URL', () => {
      const options: AuthRouterOptions = {
        provider: mockProvider,
        issuerUrl: new URL('http://auth.example.com')
      };

      expect(() => mcpAuthRouter(options)).toThrow('Issuer URL must be HTTPS');
    });

    it('allows localhost HTTP for development', () => {
      const options: AuthRouterOptions = {
        provider: mockProvider,
        issuerUrl: new URL('http://localhost:3000')
      };

      expect(() => mcpAuthRouter(options)).not.toThrow();
    });

    it('throws error for issuer URL with fragment', () => {
      const options: AuthRouterOptions = {
        provider: mockProvider,
        issuerUrl: new URL('https://auth.example.com#fragment')
      };

      expect(() => mcpAuthRouter(options)).toThrow('Issuer URL must not have a fragment');
    });

    it('throws error for issuer URL with query string', () => {
      const options: AuthRouterOptions = {
        provider: mockProvider,
        issuerUrl: new URL('https://auth.example.com?param=value')
      };

      expect(() => mcpAuthRouter(options)).toThrow('Issuer URL must not have a query string');
    });

    it('successfully creates router with valid options', () => {
      const options: AuthRouterOptions = {
        provider: mockProvider,
        issuerUrl: new URL('https://auth.example.com')
      };

      expect(() => mcpAuthRouter(options)).not.toThrow();
    });
  });

  describe('Metadata endpoint', () => {
    let app: express.Express;

    beforeEach(() => {
      // Setup full-featured router
      app = express();
      const options: AuthRouterOptions = {
        provider: mockProvider,
        issuerUrl: new URL('https://auth.example.com'),
        serviceDocumentationUrl: new URL('https://docs.example.com')
      };
      app.use(mcpAuthRouter(options));
    });

    it('returns complete metadata for full-featured router', async () => {
      const response = await supertest(app)
        .get('/.well-known/oauth-authorization-server');

      expect(response.status).toBe(200);

      // Verify essential fields
      expect(response.body.issuer).toBe('https://auth.example.com/');
      expect(response.body.authorization_endpoint).toBe('https://auth.example.com/authorize');
      expect(response.body.token_endpoint).toBe('https://auth.example.com/token');
      expect(response.body.registration_endpoint).toBe('https://auth.example.com/register');
      expect(response.body.revocation_endpoint).toBe('https://auth.example.com/revoke');

      // Verify supported features
      expect(response.body.response_types_supported).toEqual(['code']);
      expect(response.body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(response.body.code_challenge_methods_supported).toEqual(['S256']);
      expect(response.body.token_endpoint_auth_methods_supported).toEqual(['client_secret_post']);
      expect(response.body.revocation_endpoint_auth_methods_supported).toEqual(['client_secret_post']);

      // Verify optional fields
      expect(response.body.service_documentation).toBe('https://docs.example.com/');
    });

    it('returns minimal metadata for minimal router', async () => {
      // Setup minimal router
      const minimalApp = express();
      const options: AuthRouterOptions = {
        provider: mockProviderMinimal,
        issuerUrl: new URL('https://auth.example.com')
      };
      minimalApp.use(mcpAuthRouter(options));

      const response = await supertest(minimalApp)
        .get('/.well-known/oauth-authorization-server');

      expect(response.status).toBe(200);

      // Verify essential endpoints
      expect(response.body.issuer).toBe('https://auth.example.com/');
      expect(response.body.authorization_endpoint).toBe('https://auth.example.com/authorize');
      expect(response.body.token_endpoint).toBe('https://auth.example.com/token');

      // Verify missing optional endpoints
      expect(response.body.registration_endpoint).toBeUndefined();
      expect(response.body.revocation_endpoint).toBeUndefined();
      expect(response.body.revocation_endpoint_auth_methods_supported).toBeUndefined();
      expect(response.body.service_documentation).toBeUndefined();
    });

    it('provides protected resource metadata when protocol version is draft', async () => {
      // Setup router with draft protocol version
      const draftApp = express();
      const options: AuthRouterOptions = {
        provider: mockProvider,
        issuerUrl: new URL('https://auth.example.com'),
        scopesSupported: ['read', 'write'],
        protectedResourceOptions: {
          serverUrl: new URL('https://api.example.com'),
          resourceName: 'Test API'
        }
      };
      draftApp.use(mcpAuthRouter(options));

      const response = await supertest(draftApp)
        .get('/.well-known/oauth-protected-resource');

      expect(response.status).toBe(200);

      // Verify protected resource metadata
      expect(response.body.resource).toBe('https://api.example.com/');
      expect(response.body.authorization_servers).toContain('https://auth.example.com/');
      expect(response.body.scopes_supported).toEqual(['read', 'write']);
      expect(response.body.resource_name).toBe('Test API');
    });
  });

  describe('Endpoint routing', () => {
    let app: express.Express;

    beforeEach(() => {
      // Setup full-featured router
      app = express();
      const options: AuthRouterOptions = {
        provider: mockProvider,
        issuerUrl: new URL('https://auth.example.com')
      };
      app.use(mcpAuthRouter(options));
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('routes to authorization endpoint', async () => {
      const response = await supertest(app)
        .get('/authorize')
        .query({
          client_id: 'valid-client',
          response_type: 'code',
          code_challenge: 'challenge123',
          code_challenge_method: 'S256'
        });

      expect(response.status).toBe(302);
      const location = new URL(response.header.location);
      expect(location.searchParams.has('code')).toBe(true);
    });

    it('routes to token endpoint', async () => {
      // Setup verifyChallenge mock for token handler
      jest.mock('pkce-challenge', () => ({
        verifyChallenge: jest.fn().mockResolvedValue(true)
      }));

      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'authorization_code',
          code: 'valid_code',
          code_verifier: 'valid_verifier'
        });

      // The request will fail in testing due to mocking limitations,
      // but we can verify the route was matched
      expect(response.status).not.toBe(404);
    });

    it('routes to registration endpoint', async () => {
      const response = await supertest(app)
        .post('/register')
        .send({
          redirect_uris: ['https://example.com/callback']
        });

      // The request will fail in testing due to mocking limitations,
      // but we can verify the route was matched
      expect(response.status).not.toBe(404);
    });

    it('routes to revocation endpoint', async () => {
      const response = await supertest(app)
        .post('/revoke')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          token: 'token_to_revoke'
        });

      // The request will fail in testing due to mocking limitations,
      // but we can verify the route was matched
      expect(response.status).not.toBe(404);
    });

    it('excludes endpoints for unsupported features', async () => {
      // Setup minimal router
      const minimalApp = express();
      const options: AuthRouterOptions = {
        provider: mockProviderMinimal,
        issuerUrl: new URL('https://auth.example.com')
      };
      minimalApp.use(mcpAuthRouter(options));

      // Registration should not be available
      const regResponse = await supertest(minimalApp)
        .post('/register')
        .send({
          redirect_uris: ['https://example.com/callback']
        });
      expect(regResponse.status).toBe(404);

      // Revocation should not be available
      const revokeResponse = await supertest(minimalApp)
        .post('/revoke')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          token: 'token_to_revoke'
        });
      expect(revokeResponse.status).toBe(404);
    });
  });
});
