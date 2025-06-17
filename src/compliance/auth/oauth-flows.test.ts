import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { MockOAuthServer } from '../fixtures/oauth-test-server.js';
import { TestOAuthClientProvider, OAuthFlowTester, ComplianceAssertions } from '../fixtures/test-utils.js';
import { testServerConfigs, testClients, testScopes } from '../fixtures/test-data.js';
import { auth, startAuthorization, exchangeAuthorization } from '../../client/auth.js';

describe('OAuth Flow Compliance Tests', () => {
  let server: MockOAuthServer;
  let provider: TestOAuthClientProvider;
  let flowTester: OAuthFlowTester;
  const TEST_PORT = 3001;

  beforeAll(async () => {
    // Restore real fetch for integration tests
    if (jest.isMockFunction(global.fetch)) {
      (global.fetch as jest.Mock).mockRestore();
    }
    
    server = new MockOAuthServer(testServerConfigs.fullCompliance);
    await server.start(TEST_PORT);
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.clearAll();
    provider = new TestOAuthClientProvider(`http://localhost:${TEST_PORT}`);
    flowTester = new OAuthFlowTester(server, provider);
    
    // Add test client
    server.addClient({
      client_id: testClients.publicClient.client_id,
      redirect_uris: testClients.publicClient.redirect_uris || []
    });
  });

  describe('Metadata Discovery', () => {
    it('should discover OAuth metadata from authorization server endpoint', async () => {
      const metadata = await fetch(`http://localhost:${TEST_PORT}/.well-known/oauth-authorization-server`)
        .then(res => res.json());

      expect(metadata).toMatchObject({
        issuer: `http://localhost:${TEST_PORT}`,
        authorization_endpoint: expect.any(String),
        token_endpoint: expect.any(String),
        scopes_supported: expect.arrayContaining(['read', 'write']),
        response_types_supported: expect.arrayContaining(['code']),
        grant_types_supported: expect.arrayContaining(['authorization_code']),
        code_challenge_methods_supported: expect.arrayContaining(['S256'])
      });
    });

    it('should fall back to OpenID configuration endpoint', async () => {
      const metadata = await fetch(`http://localhost:${TEST_PORT}/.well-known/openid-configuration`)
        .then(res => res.json());

      expect(metadata).toMatchObject({
        issuer: `http://localhost:${TEST_PORT}`,
        authorization_endpoint: expect.any(String),
        token_endpoint: expect.any(String)
      });
    });

    it('should discover protected resource metadata', async () => {
      const metadata = await fetch(`http://localhost:${TEST_PORT}/.well-known/oauth-protected-resource`)
        .then(res => res.json());

      expect(metadata).toMatchObject({
        resource: `http://localhost:${TEST_PORT}`,
        authorization_servers: expect.arrayContaining([`http://localhost:${TEST_PORT}`])
      });
    });
  });

  describe('Client Registration', () => {
    it('should support dynamic client registration', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Dynamic Test Client',
          redirect_uris: ['http://localhost:4000/callback']
        })
      });

      expect(response.status).toBe(201);
      const client = await response.json();
      
      expect(client).toMatchObject({
        client_id: expect.any(String),
        client_name: 'Dynamic Test Client',
        redirect_uris: ['http://localhost:4000/callback']
      });
    });
  });

  describe('Authorization Flow', () => {
    it('should generate authorization URL with all required parameters', async () => {
      const { authorizationUrl, codeVerifier } = await startAuthorization(
        `http://localhost:${TEST_PORT}`,
        {
          clientInformation: {
            client_id: testClients.publicClient.client_id
          },
          redirectUrl: testClients.publicClient.redirect_uris![0],
          scope: testScopes.standard
        }
      );

      // Verify URL structure
      expect(authorizationUrl.origin).toBe(`http://localhost:${TEST_PORT}`);
      expect(authorizationUrl.pathname).toBe('/authorize');

      // Verify required parameters
      expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
      expect(authorizationUrl.searchParams.get('client_id')).toBe(testClients.publicClient.client_id);
      expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(testClients.publicClient.redirect_uris![0]);
      
      // Verify PKCE parameters exist (accepting mocked values for now)
      const codeChallenge = authorizationUrl.searchParams.get('code_challenge');
      const codeChallengeMethod = authorizationUrl.searchParams.get('code_challenge_method');
      expect(codeChallenge).toBeTruthy();
      expect(codeChallengeMethod).toBe('S256');
      
      // Verify code verifier (will be mocked value)
      expect(codeVerifier).toBeTruthy();
      // Note: In real implementation, this would be 43-128 chars, but we have mocked values
      expect(codeVerifier).toBe('test_verifier');
    });

    it('should include optional parameters when provided', async () => {
      const state = 'test-state-123';
      const { authorizationUrl } = await startAuthorization(
        `http://localhost:${TEST_PORT}`,
        {
          clientInformation: {
            client_id: testClients.publicClient.client_id
          },
          redirectUrl: testClients.publicClient.redirect_uris![0],
          scope: testScopes.extended,
          state
        }
      );

      expect(authorizationUrl.searchParams.get('scope')).toBe(testScopes.extended);
      expect(authorizationUrl.searchParams.get('state')).toBe(state);
    });

    it('should handle authorization server redirect', async () => {
      // Start authorization flow
      const { authorizationUrl } = await startAuthorization(
        `http://localhost:${TEST_PORT}`,
        {
          clientInformation: {
            client_id: testClients.publicClient.client_id
          },
          redirectUrl: testClients.publicClient.redirect_uris![0]
        }
      );

      // Simulate user authorization by following the URL
      const response = await fetch(authorizationUrl.toString(), {
        redirect: 'manual'
      });

      expect(response.status).toBe(302);
      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      
      const callbackUrl = new URL(location!);
      expect(callbackUrl.origin + callbackUrl.pathname).toBe(testClients.publicClient.redirect_uris![0]);
      expect(callbackUrl.searchParams.get('code')).toBeTruthy();
    });
  });

  describe('Token Exchange', () => {
    it('should exchange authorization code for tokens', async () => {
      // Since we're using mocked PKCE values, we need to work with them
      const mockCodeVerifier = 'test_verifier';
      const mockCodeChallenge = '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA';
      
      // Manually create authorization URL with mock values
      const authUrl = new URL(`http://localhost:${TEST_PORT}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', testClients.publicClient.client_id);
      authUrl.searchParams.set('redirect_uri', testClients.publicClient.redirect_uris![0]);
      authUrl.searchParams.set('code_challenge', mockCodeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      // Simulate authorization
      const authResponse = await fetch(authUrl.toString(), {
        redirect: 'manual'
      });
      const callbackUrl = new URL(authResponse.headers.get('location')!);
      const code = callbackUrl.searchParams.get('code')!;

      // Exchange code for tokens with the mock verifier
      const tokens = await exchangeAuthorization(
        `http://localhost:${TEST_PORT}`,
        {
          clientInformation: {
            client_id: testClients.publicClient.client_id
          },
          authorizationCode: code,
          codeVerifier: mockCodeVerifier,
          redirectUri: testClients.publicClient.redirect_uris![0]
        }
      );

      ComplianceAssertions.assertTokenResponse(tokens);
      expect(tokens.refresh_token).toBeTruthy();
      // Scope is optional in OAuth 2.0
    });

    it('should reject invalid authorization code', async () => {
      await expect(
        exchangeAuthorization(
          `http://localhost:${TEST_PORT}`,
          {
            clientInformation: {
              client_id: testClients.publicClient.client_id
            },
            authorizationCode: 'invalid_code',
            codeVerifier: 'test_verifier',
            redirectUri: testClients.publicClient.redirect_uris![0]
          }
        )
      ).rejects.toThrow();
    });

    it('should validate PKCE code verifier', async () => {
      // Setup: Get an authorization code with PKCE
      const { authorizationUrl } = await startAuthorization(
        `http://localhost:${TEST_PORT}`,
        {
          clientInformation: {
            client_id: testClients.publicClient.client_id
          },
          redirectUrl: testClients.publicClient.redirect_uris![0]
        }
      );

      const authResponse = await fetch(authorizationUrl.toString(), {
        redirect: 'manual'
      });
      const callbackUrl = new URL(authResponse.headers.get('location')!);
      const code = callbackUrl.searchParams.get('code')!;

      // Try with wrong verifier
      await expect(
        exchangeAuthorization(
          `http://localhost:${TEST_PORT}`,
          {
            clientInformation: {
              client_id: testClients.publicClient.client_id
            },
            authorizationCode: code,
            codeVerifier: 'wrong_verifier',
            redirectUri: testClients.publicClient.redirect_uris![0]
          }
        )
      ).rejects.toThrow();
    });
  });

  describe('Complete OAuth Flow Integration', () => {
    it('should complete guided OAuth flow step by step', async () => {
      const result = await flowTester.runGuidedFlow([
        {
          name: 'Start OAuth flow',
          action: async () => {
            provider.clientId = testClients.publicClient.client_id;
            provider.redirectUrl = testClients.publicClient.redirect_uris![0];
            provider.scope = testScopes.standard;
            
            try {
              return await auth(provider, {
                serverUrl: `http://localhost:${TEST_PORT}`,
                scope: testScopes.standard
              });
            } catch (error: unknown) {
              if (error instanceof Error && error.message?.includes('Test redirect to:')) {
                return { type: 'redirect', url: error.message.replace('Test redirect to: ', '') };
              }
              throw error;
            }
          },
          validate: (result: { type: string; url: string }) => {
            expect(result.type).toBe('redirect');
            expect(result.url).toContain('/authorize');
          }
        },
        {
          name: 'Simulate user authorization',
          action: async () => {
            const authUrl = provider.getAuthorizationUrl()!;
            const response = await fetch(authUrl.toString(), {
              redirect: 'manual'
            });
            const location = response.headers.get('location')!;
            return new URL(location);
          },
          validate: (callbackUrl: URL) => {
            expect(callbackUrl.searchParams.get('code')).toBeTruthy();
          }
        },
        {
          name: 'Exchange code for tokens',
          action: async () => {
            const authUrl = provider.getAuthorizationUrl()!;
            const response = await fetch(authUrl.toString(), {
              redirect: 'manual'
            });
            const callbackUrl = new URL(response.headers.get('location')!);
            const code = callbackUrl.searchParams.get('code')!;
            
            return await auth(provider, {
              serverUrl: `http://localhost:${TEST_PORT}`,
              authorizationCode: code
            });
          },
          validate: (result: string) => {
            expect(result).toBe('AUTHORIZED');
          }
        }
      ]);

      expect(result.success).toBe(true);
      expect(result.tokens).toBeTruthy();
      
      const report = flowTester.verifyCompliance(result);
      expect(report.failed).toHaveLength(0);
      expect(report.passed).toContain('Flow completed successfully');
      expect(report.passed).toContain('Tokens received');
      expect(report.passed).toContain('PKCE used');
    });

    it('should complete quick OAuth flow automatically', async () => {
      const result = await flowTester.runQuickFlow({
        serverUrl: `http://localhost:${TEST_PORT}`,
        clientId: testClients.publicClient.client_id,
        scope: testScopes.standard
      });

      expect(result.success).toBe(true);
      expect(result.tokens).toBeTruthy();
      
      const report = flowTester.verifyCompliance(result);
      expect(report.failed).toHaveLength(0);
    });

    it('should handle user cancellation in OAuth flow', async () => {
      const result = await flowTester.runQuickFlow({
        serverUrl: `http://localhost:${TEST_PORT}`,
        clientId: testClients.publicClient.client_id,
        scope: testScopes.standard,
        simulateUserCancel: true
      });

      expect(result.success).toBe(true); // Flow completes but without tokens
      expect(result.tokens).toBeUndefined();
    });

    it('should handle errors during token exchange', async () => {
      const result = await flowTester.runQuickFlow({
        serverUrl: `http://localhost:${TEST_PORT}`,
        clientId: testClients.publicClient.client_id,
        scope: testScopes.standard,
        simulateInvalidCode: true
      });

      expect(result.success).toBe(false);
      expect(result.steps[result.steps.length - 1].success).toBe(false);
      expect(result.tokens).toBeUndefined();
    });
  });

  describe('Multi-Server Authentication', () => {
    it('should maintain separate tokens for different servers', async () => {
      // Create second server
      const server2Config = { ...testServerConfigs.fullCompliance, serverUrl: 'http://localhost:3002' };
      const server2 = new MockOAuthServer(server2Config);
      await server2.start(3002);

      try {
        // Auth with first server
        const provider1 = new TestOAuthClientProvider(`http://localhost:${TEST_PORT}`);
        const flowTester1 = new OAuthFlowTester(server, provider1);
        
        const result1 = await flowTester1.runQuickFlow({
          serverUrl: `http://localhost:${TEST_PORT}`,
          clientId: testClients.publicClient.client_id
        });

        // Auth with second server
        const provider2 = new TestOAuthClientProvider('http://localhost:3002');
        const flowTester2 = new OAuthFlowTester(server2, provider2);
        
        server2.addClient({
          client_id: testClients.publicClient.client_id,
          redirect_uris: testClients.publicClient.redirect_uris || []
        });
        
        const result2 = await flowTester2.runQuickFlow({
          serverUrl: 'http://localhost:3002',
          clientId: testClients.publicClient.client_id
        });

        // Verify separate tokens
        expect(result1.tokens).toBeTruthy();
        expect(result2.tokens).toBeTruthy();
        expect(result1.tokens!.access_token).not.toBe(result2.tokens!.access_token);
      } finally {
        await server2.stop();
      }
    });
  });
});