import { authenticateClient, ClientAuthenticationMiddlewareOptions } from './clientAuth.js';
import { OAuthRegisteredClientsStore } from '../clients.js';
import { OAuthClientInformationFull } from '../../../shared/auth.js';
import express from 'express';
import supertest from 'supertest';

describe('clientAuth middleware', () => {
  // Mock client store
  const mockClientStore: OAuthRegisteredClientsStore = {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      if (clientId === 'valid-client') {
        return {
          client_id: 'valid-client',
          client_secret: 'valid-secret',
          redirect_uris: ['https://example.com/callback']
        };
      } else if (clientId === 'expired-client') {
        // Client with no secret
        return {
          client_id: 'expired-client',
          redirect_uris: ['https://example.com/callback']
        };
      } else if (clientId === 'client-with-expired-secret') {
        // Client with an expired secret
        return {
          client_id: 'client-with-expired-secret',
          client_secret: 'expired-secret',
          client_secret_expires_at: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
          redirect_uris: ['https://example.com/callback']
        };
      }
      return undefined;
    }
  };

  // Setup Express app with middleware
  let app: express.Express;
  let options: ClientAuthenticationMiddlewareOptions;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    options = {
      clientsStore: mockClientStore
    };

    // Setup route with client auth
    app.post('/protected', authenticateClient(options), (req, res) => {
      res.status(200).json({ success: true, client: req.client });
    });
  });

  it('authenticates valid client credentials', async () => {
    const response = await supertest(app)
      .post('/protected')
      .send({
        client_id: 'valid-client',
        client_secret: 'valid-secret'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.client.client_id).toBe('valid-client');
  });

  it('rejects invalid client_id', async () => {
    const response = await supertest(app)
      .post('/protected')
      .send({
        client_id: 'non-existent-client',
        client_secret: 'some-secret'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_client');
    expect(response.body.error_description).toBe('Invalid client_id');
  });

  it('rejects invalid client_secret', async () => {
    const response = await supertest(app)
      .post('/protected')
      .send({
        client_id: 'valid-client',
        client_secret: 'wrong-secret'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_client');
    expect(response.body.error_description).toBe('Invalid client_secret');
  });

  it('rejects missing client_id', async () => {
    const response = await supertest(app)
      .post('/protected')
      .send({
        client_secret: 'valid-secret'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('allows missing client_secret if client has none', async () => {
    const response = await supertest(app)
      .post('/protected')
      .send({
        client_id: 'expired-client'
      });

    // Since the client has no secret, this should pass without providing one
    expect(response.status).toBe(200);
  });
  
  it('rejects request when client secret has expired', async () => {
    const response = await supertest(app)
      .post('/protected')
      .send({
        client_id: 'client-with-expired-secret',
        client_secret: 'expired-secret'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_client');
    expect(response.body.error_description).toBe('Client secret has expired');
  });

  it('handles malformed request body', async () => {
    const response = await supertest(app)
      .post('/protected')
      .send('not-json-format');

    expect(response.status).toBe(400);
  });

  // Testing request with extra fields to ensure they're ignored
  it('ignores extra fields in request', async () => {
    const response = await supertest(app)
      .post('/protected')
      .send({
        client_id: 'valid-client',
        client_secret: 'valid-secret',
        extra_field: 'should be ignored'
      });

    expect(response.status).toBe(200);
  });
});