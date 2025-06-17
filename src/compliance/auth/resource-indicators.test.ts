import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { MockOAuthServer } from '../fixtures/oauth-test-server.js';
import { testServerConfigs, testClients, testResources } from '../fixtures/test-data.js';
import { exchangeAuthorization } from '../../client/auth.js';

describe('Resource Indicators Compliance Tests (RFC 8707)', () => {
  let server: MockOAuthServer;
  const TEST_PORT = 3003;

  beforeAll(async () => {
    // Restore real fetch for integration tests
    if (jest.isMockFunction(global.fetch)) {
      (global.fetch as jest.Mock).mockRestore();
    }
    
    server = new MockOAuthServer({
      ...testServerConfigs.resourceRequired,
      serverUrl: `http://localhost:${TEST_PORT}`
    });
    await server.start(TEST_PORT);
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.clearAll();
    // Add test client with resource restrictions
    server.addClient({
      client_id: testClients.resourceLimitedClient.client_id,
      redirect_uris: testClients.resourceLimitedClient.redirect_uris || [],
      allowed_resources: testClients.resourceLimitedClient.allowed_resources
    });
  });

  describe('Resource Parameter Validation', () => {
    it('should validate resource parameter is a valid URI', async () => {
      // Try with invalid URI
      const authUrl = new URL(`http://localhost:${TEST_PORT}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', testClients.resourceLimitedClient.client_id);
      authUrl.searchParams.set('redirect_uri', testClients.resourceLimitedClient.redirect_uris![0]);
      authUrl.searchParams.set('code_challenge', '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA');
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('resource', 'not-a-valid-uri');

      const response = await fetch(authUrl.toString(), {
        redirect: 'manual'
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe('invalid_target');
    });

    it('should reject resource URI with fragment', async () => {
      const authUrl = new URL(`http://localhost:${TEST_PORT}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', testClients.resourceLimitedClient.client_id);
      authUrl.searchParams.set('redirect_uri', testClients.resourceLimitedClient.redirect_uris![0]);
      authUrl.searchParams.set('code_challenge', '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA');
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('resource', testResources.withFragment);

      const response = await fetch(authUrl.toString(), {
        redirect: 'manual'
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe('invalid_target');
      expect(error.error_description).toContain('fragment');
    });

    it('should accept valid resource URIs', async () => {
      const validResources = [
        testResources.local,
        testResources.localWithPath,
        testResources.localWithQuery,
        testResources.remote,
        testResources.remoteWithPath,
        testResources.withPort
      ];

      for (const resource of validResources) {
        const authUrl = new URL(`http://localhost:${TEST_PORT}/authorize`);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', testClients.publicClient.client_id);
        authUrl.searchParams.set('redirect_uri', testClients.publicClient.redirect_uris![0]);
        authUrl.searchParams.set('code_challenge', '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA');
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('resource', resource);

        // Switch to public client for this test
        server.addClient({
          client_id: testClients.publicClient.client_id,
          redirect_uris: testClients.publicClient.redirect_uris || []
        });

        const response = await fetch(authUrl.toString(), {
          redirect: 'manual'
        });

        expect(response.status).toBe(302);
        const location = response.headers.get('location');
        expect(location).toContain('code=');
      }
    });
  });

  describe('Resource Parameter in Token Exchange', () => {
    it('should enforce resource consistency between authorization and token exchange', async () => {
      const resource = testResources.local;
      
      // Get authorization code with resource
      const authUrl = new URL(`http://localhost:${TEST_PORT}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', testClients.publicClient.client_id);
      authUrl.searchParams.set('redirect_uri', testClients.publicClient.redirect_uris![0]);
      authUrl.searchParams.set('code_challenge', '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA');
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('resource', resource);

      server.addClient({
        client_id: testClients.publicClient.client_id,
        redirect_uris: testClients.publicClient.redirect_uris || []
      });

      const authResponse = await fetch(authUrl.toString(), {
        redirect: 'manual'
      });
      const callbackUrl = new URL(authResponse.headers.get('location')!);
      const code = callbackUrl.searchParams.get('code')!;

      // Try token exchange with different resource (should fail)
      const tokenUrl = new URL(`http://localhost:${TEST_PORT}/token`);
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: testClients.publicClient.client_id,
          redirect_uri: testClients.publicClient.redirect_uris![0],
          code_verifier: 'test_verifier',
          resource: testResources.remote // Different resource
        })
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe('invalid_target');
    });

    it('should allow token exchange with matching resource', async () => {
      const resource = testResources.local;
      
      // Get authorization code with resource
      const authUrl = new URL(`http://localhost:${TEST_PORT}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', testClients.publicClient.client_id);
      authUrl.searchParams.set('redirect_uri', testClients.publicClient.redirect_uris![0]);
      authUrl.searchParams.set('code_challenge', '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA');
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('resource', resource);

      server.addClient({
        client_id: testClients.publicClient.client_id,
        redirect_uris: testClients.publicClient.redirect_uris || []
      });

      const authResponse = await fetch(authUrl.toString(), {
        redirect: 'manual'
      });
      const callbackUrl = new URL(authResponse.headers.get('location')!);
      const code = callbackUrl.searchParams.get('code')!;

      // Token exchange with same resource
      const tokens = await exchangeAuthorization(
        `http://localhost:${TEST_PORT}`,
        {
          clientInformation: {
            client_id: testClients.publicClient.client_id
          },
          authorizationCode: code,
          codeVerifier: 'test_verifier',
          redirectUri: testClients.publicClient.redirect_uris![0]
        }
      );

      expect(tokens.access_token).toBeTruthy();
    });
  });

  describe('Resource Introspection', () => {
    it('should include resource in token introspection response', async () => {
      const resource = testResources.local;
      
      // Complete OAuth flow with resource
      const authUrl = new URL(`http://localhost:${TEST_PORT}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', testClients.publicClient.client_id);
      authUrl.searchParams.set('redirect_uri', testClients.publicClient.redirect_uris![0]);
      authUrl.searchParams.set('code_challenge', '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA');
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('resource', resource);

      server.addClient({
        client_id: testClients.publicClient.client_id,
        redirect_uris: testClients.publicClient.redirect_uris || []
      });

      const authResponse = await fetch(authUrl.toString(), {
        redirect: 'manual'
      });
      const callbackUrl = new URL(authResponse.headers.get('location')!);
      const code = callbackUrl.searchParams.get('code')!;

      const tokens = await exchangeAuthorization(
        `http://localhost:${TEST_PORT}`,
        {
          clientInformation: {
            client_id: testClients.publicClient.client_id
          },
          authorizationCode: code,
          codeVerifier: 'test_verifier',
          redirectUri: testClients.publicClient.redirect_uris![0]
        }
      );

      // Introspect the token
      const introspectionUrl = new URL(`http://localhost:${TEST_PORT}/introspect`);
      const introspectionResponse = await fetch(introspectionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          token: tokens.access_token
        })
      });

      const introspection = await introspectionResponse.json();
      expect(introspection.active).toBe(true);
      expect(introspection.resource).toBe(resource);
    });
  });

  describe('Server Resource Requirements', () => {
    it('should reject authorization without resource when server requires it', async () => {
      // Server is configured with requiresResourceParameter: true
      const authUrl = new URL(`http://localhost:${TEST_PORT}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', testClients.publicClient.client_id);
      authUrl.searchParams.set('redirect_uri', testClients.publicClient.redirect_uris![0]);
      authUrl.searchParams.set('code_challenge', '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA');
      authUrl.searchParams.set('code_challenge_method', 'S256');
      // No resource parameter

      server.addClient({
        client_id: testClients.publicClient.client_id,
        redirect_uris: testClients.publicClient.redirect_uris || []
      });

      const response = await fetch(authUrl.toString(), {
        redirect: 'manual'
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe('invalid_request');
      expect(error.error_description).toContain('Resource parameter required');
    });

    it('should work with servers that do not require resource parameter', async () => {
      // Create a lenient server
      const lenientServer = new MockOAuthServer({
        ...testServerConfigs.fullCompliance,
        requiresResourceParameter: false,
        serverUrl: `http://localhost:${TEST_PORT + 1}`
      });
      
      await lenientServer.start(TEST_PORT + 1);
      lenientServer.addClient({
        client_id: testClients.publicClient.client_id,
        redirect_uris: testClients.publicClient.redirect_uris || []
      });

      try {
        // Authorization without resource should succeed
        const authUrl = new URL(`http://localhost:${TEST_PORT + 1}/authorize`);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', testClients.publicClient.client_id);
        authUrl.searchParams.set('redirect_uri', testClients.publicClient.redirect_uris![0]);
        authUrl.searchParams.set('code_challenge', '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA');
        authUrl.searchParams.set('code_challenge_method', 'S256');
        // No resource parameter

        const response = await fetch(authUrl.toString(), {
          redirect: 'manual'
        });

        expect(response.status).toBe(302);
        const location = response.headers.get('location');
        expect(location).toContain('code=');
      } finally {
        await lenientServer.stop();
      }
    });
  });

  describe('Protected Resource Metadata', () => {
    it('should discover protected resource metadata', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/.well-known/oauth-protected-resource`);
      expect(response.status).toBe(200);

      const metadata = await response.json();
      expect(metadata).toMatchObject({
        resource: `http://localhost:${TEST_PORT}`,
        authorization_servers: expect.arrayContaining([`http://localhost:${TEST_PORT}`])
      });
    });

    it('should use authorization servers from resource metadata', async () => {
      // Create separate auth and resource servers
      const resourceServer = new MockOAuthServer({
        ...testServerConfigs.fullCompliance,
        serverUrl: `http://localhost:${TEST_PORT + 2}`,
        authorizationServers: [`http://localhost:${TEST_PORT + 3}`]
      });
      
      const authServer = new MockOAuthServer({
        ...testServerConfigs.fullCompliance,
        serverUrl: `http://localhost:${TEST_PORT + 3}`
      });

      await resourceServer.start(TEST_PORT + 2);
      await authServer.start(TEST_PORT + 3);

      try {
        // Discover resource metadata
        const response = await fetch(`http://localhost:${TEST_PORT + 2}/.well-known/oauth-protected-resource`);
        const metadata = await response.json();

        expect(metadata.resource).toBe(`http://localhost:${TEST_PORT + 2}`);
        expect(metadata.authorization_servers).toContain(`http://localhost:${TEST_PORT + 3}`);
      } finally {
        await resourceServer.stop();
        await authServer.stop();
      }
    });
  });
});