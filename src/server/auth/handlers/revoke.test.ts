import { revocationHandler, RevocationHandlerOptions } from './revoke.js';
import { OAuthServerProvider, AuthorizationParams } from '../provider.js';
import { OAuthRegisteredClientsStore } from '../clients.js';
import { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '../../../shared/auth.js';
import express, { Response } from 'express';
import supertest from 'supertest';
import { AuthInfo } from '../types.js';
import { InvalidTokenError } from '../errors.js';

describe('Revocation Handler', () => {
  // Mock client data
  const validClient: OAuthClientInformationFull = {
    client_id: 'valid-client',
    client_secret: 'valid-secret',
    redirect_uris: ['https://example.com/callback']
  };

  // Mock client store
  const mockClientStore: OAuthRegisteredClientsStore = {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      if (clientId === 'valid-client') {
        return validClient;
      }
      return undefined;
    }
  };

  // Mock provider with revocation capability
  const mockProviderWithRevocation: OAuthServerProvider = {
    clientsStore: mockClientStore,

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
      res.redirect('https://example.com/callback?code=mock_auth_code');
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

  // Mock provider without revocation capability
  const mockProviderWithoutRevocation: OAuthServerProvider = {
    clientsStore: mockClientStore,

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
      res.redirect('https://example.com/callback?code=mock_auth_code');
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
    }
    // No revokeToken method
  };

  describe('Handler creation', () => {
    it('throws error if provider does not support token revocation', () => {
      const options: RevocationHandlerOptions = { provider: mockProviderWithoutRevocation };
      expect(() => revocationHandler(options)).toThrow('does not support revoking tokens');
    });

    it('creates handler if provider supports token revocation', () => {
      const options: RevocationHandlerOptions = { provider: mockProviderWithRevocation };
      expect(() => revocationHandler(options)).not.toThrow();
    });
  });

  describe('Request handling', () => {
    let app: express.Express;
    let spyRevokeToken: jest.SpyInstance;

    beforeEach(() => {
      // Setup express app with revocation handler
      app = express();
      const options: RevocationHandlerOptions = { provider: mockProviderWithRevocation };
      app.use('/revoke', revocationHandler(options));

      // Spy on the revokeToken method
      spyRevokeToken = jest.spyOn(mockProviderWithRevocation, 'revokeToken');
    });

    afterEach(() => {
      spyRevokeToken.mockRestore();
    });

    it('requires POST method', async () => {
      const response = await supertest(app)
        .get('/revoke')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          token: 'token_to_revoke'
        });

      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('POST');
      expect(response.body).toEqual({
        error: "method_not_allowed",
        error_description: "The method GET is not allowed for this endpoint"
      });
      expect(spyRevokeToken).not.toHaveBeenCalled();
    });

    it('requires token parameter', async () => {
      const response = await supertest(app)
        .post('/revoke')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret'
          // Missing token
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
      expect(spyRevokeToken).not.toHaveBeenCalled();
    });

    it('authenticates client before revoking token', async () => {
      const response = await supertest(app)
        .post('/revoke')
        .type('form')
        .send({
          client_id: 'invalid-client',
          client_secret: 'wrong-secret',
          token: 'token_to_revoke'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_client');
      expect(spyRevokeToken).not.toHaveBeenCalled();
    });

    it('successfully revokes token', async () => {
      const response = await supertest(app)
        .post('/revoke')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          token: 'token_to_revoke'
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({}); // Empty response on success
      expect(spyRevokeToken).toHaveBeenCalledTimes(1);
      expect(spyRevokeToken).toHaveBeenCalledWith(validClient, {
        token: 'token_to_revoke'
      });
    });

    it('accepts optional token_type_hint', async () => {
      const response = await supertest(app)
        .post('/revoke')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          token: 'token_to_revoke',
          token_type_hint: 'refresh_token'
        });

      expect(response.status).toBe(200);
      expect(spyRevokeToken).toHaveBeenCalledWith(validClient, {
        token: 'token_to_revoke',
        token_type_hint: 'refresh_token'
      });
    });

    it('includes CORS headers in response', async () => {
      const response = await supertest(app)
        .post('/revoke')
        .type('form')
        .set('Origin', 'https://example.com')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          token: 'token_to_revoke'
        });

      expect(response.header['access-control-allow-origin']).toBe('*');
    });
  });
});