import { clientRegistrationHandler, ClientRegistrationHandlerOptions } from './register.js';
import { OAuthRegisteredClientsStore } from '../clients.js';
import { OAuthClientInformationFull, OAuthClientMetadata } from '../../../shared/auth.js';
import express from 'express';
import supertest from 'supertest';

describe('Client Registration Handler', () => {
  // Mock client store with registration support
  const mockClientStoreWithRegistration: OAuthRegisteredClientsStore = {
    async getClient(_clientId: string): Promise<OAuthClientInformationFull | undefined> {
      return undefined;
    },

    async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
      // Return the client info as-is in the mock
      return client;
    }
  };

  // Mock client store without registration support
  const mockClientStoreWithoutRegistration: OAuthRegisteredClientsStore = {
    async getClient(_clientId: string): Promise<OAuthClientInformationFull | undefined> {
      return undefined;
    }
    // No registerClient method
  };

  describe('Handler creation', () => {
    it('throws error if client store does not support registration', () => {
      const options: ClientRegistrationHandlerOptions = {
        clientsStore: mockClientStoreWithoutRegistration
      };

      expect(() => clientRegistrationHandler(options)).toThrow('does not support registering clients');
    });

    it('creates handler if client store supports registration', () => {
      const options: ClientRegistrationHandlerOptions = {
        clientsStore: mockClientStoreWithRegistration
      };

      expect(() => clientRegistrationHandler(options)).not.toThrow();
    });
  });

  describe('Request handling', () => {
    let app: express.Express;
    let spyRegisterClient: jest.SpyInstance;

    beforeEach(() => {
      // Setup express app with registration handler
      app = express();
      const options: ClientRegistrationHandlerOptions = {
        clientsStore: mockClientStoreWithRegistration,
        clientSecretExpirySeconds: 86400 // 1 day for testing
      };

      app.use('/register', clientRegistrationHandler(options));

      // Spy on the registerClient method
      spyRegisterClient = jest.spyOn(mockClientStoreWithRegistration, 'registerClient');
    });

    afterEach(() => {
      spyRegisterClient.mockRestore();
    });

    it('requires POST method', async () => {
      const response = await supertest(app)
        .get('/register')
        .send({
          redirect_uris: ['https://example.com/callback']
        });

      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('POST');
      expect(response.body).toEqual({
        error: "method_not_allowed",
        error_description: "The method GET is not allowed for this endpoint"
      });
      expect(spyRegisterClient).not.toHaveBeenCalled();
    });

    it('validates required client metadata', async () => {
      const response = await supertest(app)
        .post('/register')
        .send({
          // Missing redirect_uris (required)
          client_name: 'Test Client'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_client_metadata');
      expect(spyRegisterClient).not.toHaveBeenCalled();
    });

    it('validates redirect URIs format', async () => {
      const response = await supertest(app)
        .post('/register')
        .send({
          redirect_uris: ['invalid-url'] // Invalid URL format
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_client_metadata');
      expect(response.body.error_description).toContain('redirect_uris');
      expect(spyRegisterClient).not.toHaveBeenCalled();
    });

    it('successfully registers client with minimal metadata', async () => {
      const clientMetadata: OAuthClientMetadata = {
        redirect_uris: ['https://example.com/callback']
      };

      const response = await supertest(app)
        .post('/register')
        .send(clientMetadata);

      expect(response.status).toBe(201);

      // Verify the generated client information
      expect(response.body.client_id).toBeDefined();
      expect(response.body.client_secret).toBeDefined();
      expect(response.body.client_id_issued_at).toBeDefined();
      expect(response.body.client_secret_expires_at).toBeDefined();
      expect(response.body.redirect_uris).toEqual(['https://example.com/callback']);

      // Verify client was registered
      expect(spyRegisterClient).toHaveBeenCalledTimes(1);
    });

    it('sets client_secret to undefined for token_endpoint_auth_method=none', async () => {
      const clientMetadata: OAuthClientMetadata = {
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none'
      };

      const response = await supertest(app)
        .post('/register')
        .send(clientMetadata);

      expect(response.status).toBe(201);
      expect(response.body.client_secret).toBeUndefined();
      expect(response.body.client_secret_expires_at).toBeUndefined();
    });
    
    it('sets client_secret_expires_at for public clients only', async () => {
      // Test for public client (token_endpoint_auth_method not 'none')
      const publicClientMetadata: OAuthClientMetadata = {
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'client_secret_basic'
      };

      const publicResponse = await supertest(app)
        .post('/register')
        .send(publicClientMetadata);

      expect(publicResponse.status).toBe(201);
      expect(publicResponse.body.client_secret).toBeDefined();
      expect(publicResponse.body.client_secret_expires_at).toBeDefined();
      
      // Test for non-public client (token_endpoint_auth_method is 'none')
      const nonPublicClientMetadata: OAuthClientMetadata = {
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none'
      };

      const nonPublicResponse = await supertest(app)
        .post('/register')
        .send(nonPublicClientMetadata);

      expect(nonPublicResponse.status).toBe(201);
      expect(nonPublicResponse.body.client_secret).toBeUndefined();
      expect(nonPublicResponse.body.client_secret_expires_at).toBeUndefined();
    });

    it('sets expiry based on clientSecretExpirySeconds', async () => {
      // Create handler with custom expiry time
      const customApp = express();
      const options: ClientRegistrationHandlerOptions = {
        clientsStore: mockClientStoreWithRegistration,
        clientSecretExpirySeconds: 3600 // 1 hour
      };

      customApp.use('/register', clientRegistrationHandler(options));

      const response = await supertest(customApp)
        .post('/register')
        .send({
          redirect_uris: ['https://example.com/callback']
        });

      expect(response.status).toBe(201);

      // Verify the expiration time (~1 hour from now)
      const issuedAt = response.body.client_id_issued_at;
      const expiresAt = response.body.client_secret_expires_at;
      expect(expiresAt - issuedAt).toBe(3600);
    });

    it('sets no expiry when clientSecretExpirySeconds=0', async () => {
      // Create handler with no expiry
      const customApp = express();
      const options: ClientRegistrationHandlerOptions = {
        clientsStore: mockClientStoreWithRegistration,
        clientSecretExpirySeconds: 0 // No expiry
      };

      customApp.use('/register', clientRegistrationHandler(options));

      const response = await supertest(customApp)
        .post('/register')
        .send({
          redirect_uris: ['https://example.com/callback']
        });

      expect(response.status).toBe(201);
      expect(response.body.client_secret_expires_at).toBe(0);
    });

    it('handles client with all metadata fields', async () => {
      const fullClientMetadata: OAuthClientMetadata = {
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'Test Client',
        client_uri: 'https://example.com',
        logo_uri: 'https://example.com/logo.png',
        scope: 'profile email',
        contacts: ['dev@example.com'],
        tos_uri: 'https://example.com/tos',
        policy_uri: 'https://example.com/privacy',
        jwks_uri: 'https://example.com/jwks',
        software_id: 'test-software',
        software_version: '1.0.0'
      };

      const response = await supertest(app)
        .post('/register')
        .send(fullClientMetadata);

      expect(response.status).toBe(201);

      // Verify all metadata was preserved
      Object.entries(fullClientMetadata).forEach(([key, value]) => {
        expect(response.body[key]).toEqual(value);
      });
    });

    it('includes CORS headers in response', async () => {
      const response = await supertest(app)
        .post('/register')
        .set('Origin', 'https://example.com')
        .send({
          redirect_uris: ['https://example.com/callback']
        });

      expect(response.header['access-control-allow-origin']).toBe('*');
    });
  });
});