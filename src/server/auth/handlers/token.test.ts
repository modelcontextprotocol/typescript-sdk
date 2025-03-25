import { tokenHandler, TokenHandlerOptions } from './token.js';
import { OAuthServerProvider, AuthorizationParams } from '../provider.js';
import { OAuthRegisteredClientsStore } from '../clients.js';
import { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '../../../shared/auth.js';
import express, { Response } from 'express';
import supertest from 'supertest';
import * as pkceChallenge from 'pkce-challenge';
import { InvalidGrantError, InvalidTokenError } from '../errors.js';
import { AuthInfo } from '../types.js';

// Mock pkce-challenge
jest.mock('pkce-challenge', () => ({
  verifyChallenge: jest.fn().mockImplementation(async (verifier, challenge) => {
    return verifier === 'valid_verifier' && challenge === 'mock_challenge';
  })
}));

describe('Token Handler', () => {
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

  // Mock provider
  let mockProvider: OAuthServerProvider;
  let app: express.Express;

  beforeEach(() => {
    // Create fresh mocks for each test
    mockProvider = {
      clientsStore: mockClientStore,

      async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
        res.redirect('https://example.com/callback?code=mock_auth_code');
      },

      async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
        if (authorizationCode === 'valid_code') {
          return 'mock_challenge';
        } else if (authorizationCode === 'expired_code') {
          throw new InvalidGrantError('The authorization code has expired');
        }
        throw new InvalidGrantError('The authorization code is invalid');
      },

      async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
        if (authorizationCode === 'valid_code') {
          return {
            access_token: 'mock_access_token',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'mock_refresh_token'
          };
        }
        throw new InvalidGrantError('The authorization code is invalid or has expired');
      },

      async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
        if (refreshToken === 'valid_refresh_token') {
          const response: OAuthTokens = {
            access_token: 'new_mock_access_token',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'new_mock_refresh_token'
          };

          if (scopes) {
            response.scope = scopes.join(' ');
          }

          return response;
        }
        throw new InvalidGrantError('The refresh token is invalid or has expired');
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
        // Do nothing in mock
      }
    };

    // Mock PKCE verification
    (pkceChallenge.verifyChallenge as jest.Mock).mockImplementation(
      async (verifier: string, challenge: string) => {
        return verifier === 'valid_verifier' && challenge === 'mock_challenge';
      }
    );

    // Setup express app with token handler
    app = express();
    const options: TokenHandlerOptions = { provider: mockProvider };
    app.use('/token', tokenHandler(options));
  });

  describe('Basic request validation', () => {
    it('requires POST method', async () => {
      const response = await supertest(app)
        .get('/token')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'authorization_code'
        });

      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('POST');
      expect(response.body).toEqual({
        error: "method_not_allowed",
        error_description: "The method GET is not allowed for this endpoint"
      });
    });

    it('requires grant_type parameter', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret'
          // Missing grant_type
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('rejects unsupported grant types', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'password' // Unsupported grant type
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('unsupported_grant_type');
    });
  });

  describe('Client authentication', () => {
    it('requires valid client credentials', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'invalid-client',
          client_secret: 'wrong-secret',
          grant_type: 'authorization_code'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_client');
    });

    it('accepts valid client credentials', async () => {
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

      expect(response.status).toBe(200);
    });
  });

  describe('Authorization code grant', () => {
    it('requires code parameter', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'authorization_code',
          // Missing code
          code_verifier: 'valid_verifier'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('requires code_verifier parameter', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'authorization_code',
          code: 'valid_code'
          // Missing code_verifier
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('verifies code_verifier against challenge', async () => {
      // Setup invalid verifier
      (pkceChallenge.verifyChallenge as jest.Mock).mockResolvedValueOnce(false);

      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'authorization_code',
          code: 'valid_code',
          code_verifier: 'invalid_verifier'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_grant');
      expect(response.body.error_description).toContain('code_verifier');
    });

    it('rejects expired or invalid authorization codes', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'authorization_code',
          code: 'expired_code',
          code_verifier: 'valid_verifier'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_grant');
    });

    it('returns tokens for valid code exchange', async () => {
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

      expect(response.status).toBe(200);
      expect(response.body.access_token).toBe('mock_access_token');
      expect(response.body.token_type).toBe('bearer');
      expect(response.body.expires_in).toBe(3600);
      expect(response.body.refresh_token).toBe('mock_refresh_token');
    });
  });

  describe('Refresh token grant', () => {
    it('requires refresh_token parameter', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'refresh_token'
          // Missing refresh_token
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('rejects invalid refresh tokens', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'refresh_token',
          refresh_token: 'invalid_refresh_token'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_grant');
    });

    it('returns new tokens for valid refresh token', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'refresh_token',
          refresh_token: 'valid_refresh_token'
        });

      expect(response.status).toBe(200);
      expect(response.body.access_token).toBe('new_mock_access_token');
      expect(response.body.token_type).toBe('bearer');
      expect(response.body.expires_in).toBe(3600);
      expect(response.body.refresh_token).toBe('new_mock_refresh_token');
    });

    it('respects requested scopes on refresh', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'refresh_token',
          refresh_token: 'valid_refresh_token',
          scope: 'profile email'
        });

      expect(response.status).toBe(200);
      expect(response.body.scope).toBe('profile email');
    });
  });

  describe('CORS support', () => {
    it('includes CORS headers in response', async () => {
      const response = await supertest(app)
        .post('/token')
        .type('form')
        .set('Origin', 'https://example.com')
        .send({
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          grant_type: 'authorization_code',
          code: 'valid_code',
          code_verifier: 'valid_verifier'
        });

      expect(response.header['access-control-allow-origin']).toBe('*');
    });
  });
});