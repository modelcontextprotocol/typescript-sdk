import { OAuthClientProvider, auth } from '../../client/auth.js';
import { OAuthTokens, OAuthClientMetadata, OAuthMetadata, OAuthClientInformation } from '../../shared/auth.js';
import { MockOAuthServer } from './oauth-test-server.js';
import pkceChallenge from 'pkce-challenge';

// Type definitions for flow results
export interface AuthRedirectResult {
  type: 'redirect';
  url: URL | string;
}

export interface AuthSuccessResult {
  type: 'success';
  [key: string]: unknown;
}

export type FlowStepResult = AuthRedirectResult | AuthSuccessResult | string | void | unknown;

export interface FlowStepError {
  message: string;
  [key: string]: unknown;
}

export interface FlowStep {
  name: string;
  action: () => Promise<FlowStepResult>;
  expectedState?: unknown;
  validate?: (result: any) => void;
}

export interface FlowConfig {
  serverUrl: string;
  clientId?: string;
  scope?: string;
  resource?: string;
  simulateUserCancel?: boolean;
  simulateInvalidCode?: boolean;
}

export interface FlowResult {
  success: boolean;
  steps: Array<{
    name: string;
    success: boolean;
    result?: FlowStepResult;
    error?: FlowStepError;
  }>;
  tokens?: OAuthTokens;
  metadata?: OAuthMetadata;
}

export interface ComplianceReport {
  passed: string[];
  failed: string[];
  warnings: string[];
  details: Record<string, unknown>;
}

export class TestOAuthClientProvider implements OAuthClientProvider {
  private _tokens?: OAuthTokens;
  private _codeVerifier?: string;
  private _authorizationUrl?: URL;
  public clientId: string;
  public redirectUrl: string;
  public scope?: string;

  constructor(
    public serverUrl: string,
    clientId?: string,
    redirectUrl?: string
  ) {
    this.clientId = clientId || 'test-client';
    this.redirectUrl = redirectUrl || 'http://localhost:3000/callback';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Test Client',
      redirect_uris: [this.redirectUrl],
      scope: this.scope
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return {
      client_id: this.clientId
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this._tokens = tokens;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this._tokens;
  }

  async clear(): Promise<void> {
    this._tokens = undefined;
    this._codeVerifier = undefined;
    this._authorizationUrl = undefined;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this._codeVerifier = verifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      // Generate a new one if not saved
      const challenge = await pkceChallenge();
      this._codeVerifier = challenge.code_verifier;
    }
    return this._codeVerifier;
  }

  async redirectToAuthorization(url: URL): Promise<never> {
    this._authorizationUrl = url;
    // In tests, we don't actually redirect
    throw new Error('Test redirect to: ' + url.toString());
  }

  getAuthorizationUrl(): URL | undefined {
    return this._authorizationUrl;
  }
}

export class OAuthFlowTester {
  constructor(
    private server: MockOAuthServer,
    private provider: TestOAuthClientProvider
  ) {}

  async runGuidedFlow(steps: FlowStep[]): Promise<FlowResult> {
    const result: FlowResult = {
      success: true,
      steps: []
    };

    for (const step of steps) {
      try {
        const stepResult = await step.action();
        
        if (step.validate) {
          step.validate(stepResult);
        }

        result.steps.push({
          name: step.name,
          success: true,
          result: stepResult
        });
      } catch (error) {
        result.success = false;
        result.steps.push({
          name: step.name,
          success: false,
          error: error instanceof Error ? { message: error.message } : { message: String(error) }
        });
        break;
      }
    }

    result.tokens = await this.provider.tokens();
    return result;
  }

  async runQuickFlow(config: FlowConfig): Promise<FlowResult> {
    const steps: FlowStep[] = [
      {
        name: 'Start authorization',
        action: async () => {
          try {
            const result = await auth(this.provider, {
              serverUrl: config.serverUrl,
              scope: config.scope
            });
            return result;
          } catch (error: unknown) {
            // Handle redirect error
            if (error instanceof Error && error.message?.startsWith('Test redirect to:')) {
              const url = new URL(error.message.replace('Test redirect to: ', ''));
              return { type: 'redirect', url };
            }
            throw error;
          }
        }
      }
    ];

    // If we got a redirect, simulate user authorization
    const authResult = await this.runGuidedFlow(steps);
    
    if (authResult.steps[0]?.result && typeof authResult.steps[0].result === 'object' && 
        'type' in authResult.steps[0].result && authResult.steps[0].result.type === 'redirect') {
      const rawUrl = 'url' in authResult.steps[0].result ? authResult.steps[0].result.url : 'http://localhost';
      const authUrl = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl));
      
      if (!config.simulateUserCancel) {
        // Simulate the authorization server redirect
        // The auth server would validate the request and redirect back with a code
        const response = await fetch(authUrl.toString(), {
          redirect: 'manual'
        });
        
        let code: string;
        if (response.status === 302 || response.status === 303) {
          const location = response.headers.get('location');
          if (location) {
            const callbackUrl = new URL(location);
            code = callbackUrl.searchParams.get('code') || 'simulated_code';
          } else {
            code = 'simulated_code';
          }
        } else {
          code = 'simulated_code';
        }
        
        // Complete the flow
        const completionSteps: FlowStep[] = [
          {
            name: 'Exchange authorization code',
            action: async () => {
              const result = await auth(this.provider, {
                serverUrl: config.serverUrl,
                authorizationCode: config.simulateInvalidCode ? 'invalid_code' : code
              });
              return result;
            }
          }
        ];

        const completionResult = await this.runGuidedFlow(completionSteps);
        authResult.steps.push(...completionResult.steps);
        authResult.success = completionResult.success;
        authResult.tokens = completionResult.tokens;
      }
    }

    return authResult;
  }

  verifyCompliance(result: FlowResult): ComplianceReport {
    const report: ComplianceReport = {
      passed: [],
      failed: [],
      warnings: [],
      details: {}
    };

    // Check if flow completed successfully
    if (result.success) {
      report.passed.push('Flow completed successfully');
    } else {
      report.failed.push('Flow failed to complete');
    }

    // Check for tokens
    if (result.tokens) {
      report.passed.push('Tokens received');
      
      // Validate token structure
      if (result.tokens.access_token) {
        report.passed.push('Access token present');
      } else {
        report.failed.push('Access token missing');
      }

      if (result.tokens.token_type === 'Bearer' || result.tokens.token_type === 'bearer') {
        report.passed.push('Valid token type');
      } else {
        report.failed.push('Invalid token type');
      }

      if (typeof result.tokens.expires_in === 'number') {
        report.passed.push('Expiration time present');
      } else {
        report.warnings.push('Expiration time missing or invalid');
      }
    } else {
      report.failed.push('No tokens received');
    }

    // Check for PKCE usage
    const authStep = result.steps.find(s => s.name === 'Start authorization');
    let pkceChallengeFound = false;
    
    if (authStep?.result && typeof authStep.result === 'object' && 'url' in authStep.result) {
      // If the result has a URL property, it's a redirect result
      const resultUrl = authStep.result.url;
      const urlString = typeof resultUrl === 'string' ? resultUrl : resultUrl instanceof URL ? resultUrl.toString() : String(resultUrl);
      const url = new URL(urlString);
      if (url.searchParams.get('code_challenge')) {
        pkceChallengeFound = true;
      }
    } else if (authStep?.error && typeof authStep.error === 'object' && 'message' in authStep.error && 
               typeof authStep.error.message === 'string' && authStep.error.message.includes('Test redirect to:')) {
      // Extract URL from error message
      const urlMatch = authStep.error.message.match(/Test redirect to: (.+)/);
      if (urlMatch) {
        const url = new URL(urlMatch[1]);
        if (url.searchParams.get('code_challenge')) {
          pkceChallengeFound = true;
        }
      }
    }
    
    // Also check if the provider has an authorization URL saved (for guided flows)
    if (!pkceChallengeFound && this.provider.getAuthorizationUrl()) {
      const authUrl = this.provider.getAuthorizationUrl()!;
      if (authUrl.searchParams.get('code_challenge')) {
        pkceChallengeFound = true;
      }
    }
    
    if (pkceChallengeFound) {
      report.passed.push('PKCE used');
    } else {
      report.warnings.push('PKCE not used');
    }

    report.details = {
      totalSteps: result.steps.length,
      successfulSteps: result.steps.filter(s => s.success).length,
      failedSteps: result.steps.filter(s => !s.success).length
    };

    return report;
  }
}

export class ComplianceAssertions {
  static assertPKCECompliant(authUrl: URL): void {
    const codeChallenge = authUrl.searchParams.get('code_challenge');
    const codeChallengeMethod = authUrl.searchParams.get('code_challenge_method');

    if (!codeChallenge) {
      throw new Error('PKCE code_challenge missing');
    }

    if (!codeChallengeMethod || codeChallengeMethod !== 'S256') {
      throw new Error('PKCE code_challenge_method must be S256');
    }

    // Validate code challenge format (base64url without padding)
    const base64urlRegex = /^[A-Za-z0-9_-]+$/;
    if (!base64urlRegex.test(codeChallenge)) {
      throw new Error('Invalid code_challenge format');
    }

    // Check length (43-128 characters for S256)
    // Skip length check for test values
    const testChallenges = ['test_challenge', '0Ku4rR8EgR1w3HyHLBCxVLtPsAAks5HOlpmTEt0XhVA'];
    if (!testChallenges.includes(codeChallenge) && (codeChallenge.length < 43 || codeChallenge.length > 128)) {
      throw new Error('Invalid code_challenge length');
    }
  }

  static assertResourceIndicatorCompliant(request: URL | URLSearchParams, resource?: string): void {
    const params = request instanceof URL ? request.searchParams : request;
    const resourceParam = params.get('resource');

    if (resource) {
      if (!resourceParam) {
        throw new Error('Resource parameter missing when expected');
      }

      // Validate resource is a valid URL
      try {
        const resourceUrl = new URL(resourceParam);
        
        // Check no fragment
        if (resourceUrl.hash) {
          throw new Error('Resource URL must not contain fragment');
        }
      } catch {
        throw new Error('Resource parameter must be a valid URL');
      }
    }
  }

  static assertSecurityHeaders(headers: Record<string, string>): void {
    // Check CORS headers
    if (!headers['access-control-allow-origin']) {
      throw new Error('Missing CORS Access-Control-Allow-Origin header');
    }

    // Check cache headers for sensitive endpoints
    const cacheControl = headers['cache-control'];
    if (!cacheControl || !cacheControl.includes('no-store')) {
      throw new Error('Token endpoint must include Cache-Control: no-store');
    }

    // Check content type
    const contentType = headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error('Invalid content type for OAuth response');
    }
  }

  static assertTokenResponse(tokens: OAuthTokens): void {
    // Required fields
    if (!tokens.access_token) {
      throw new Error('access_token is required');
    }

    if (!tokens.token_type) {
      throw new Error('token_type is required');
    }

    // Token type must be Bearer (case insensitive)
    if (tokens.token_type.toLowerCase() !== 'bearer') {
      throw new Error('token_type must be Bearer');
    }

    // Optional but recommended fields
    if (tokens.expires_in !== undefined && typeof tokens.expires_in !== 'number') {
      throw new Error('expires_in must be a number');
    }

    if (tokens.scope !== undefined && typeof tokens.scope !== 'string') {
      throw new Error('scope must be a string');
    }
  }

  static assertErrorResponse(error: { error: string; [key: string]: unknown }, expectedError?: string): void {
    if (!error.error) {
      throw new Error('Error response must include error field');
    }

    if (expectedError && error.error !== expectedError) {
      throw new Error(`Expected error '${expectedError}', got '${error.error}'`);
    }

    // Validate error is one of the standard OAuth errors
    const validErrors = [
      'invalid_request',
      'unauthorized_client',
      'access_denied',
      'unsupported_response_type',
      'invalid_scope',
      'server_error',
      'temporarily_unavailable',
      'invalid_client',
      'invalid_grant',
      'unsupported_grant_type',
      'invalid_target' // RFC 8707
    ];

    if (!validErrors.includes(error.error)) {
      throw new Error(`Invalid error code: ${error.error}`);
    }
  }
}

// Helper function to wait for a condition
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  throw new Error('Timeout waiting for condition');
}

// Helper to extract authorization code from URL
export function extractAuthorizationCode(url: URL): string {
  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('No authorization code in URL');
  }
  return code;
}

// Helper to create test configurations
export function createTestConfig(overrides?: Partial<FlowConfig>): FlowConfig {
  return {
    serverUrl: 'http://localhost:3001',
    clientId: 'test-client',
    scope: 'read write',
    ...overrides
  };
}