import { MockOAuthServerConfig } from './oauth-test-server.js';
import { OAuthClientInformationFull } from '../../shared/auth.js';

// Test server configurations for different compliance scenarios
export const testServerConfigs = {
  fullCompliance: {
    supportsPKCE: true,
    supportsResourceIndicators: true,
    requiresResourceParameter: false,
    validationMode: 'strict',
    serverUrl: 'http://localhost:3001'
  } as MockOAuthServerConfig,

  pkceOnly: {
    supportsPKCE: true,
    supportsResourceIndicators: false,
    requiresResourceParameter: false,
    validationMode: 'lenient',
    serverUrl: 'http://localhost:3001'
  } as MockOAuthServerConfig,

  resourceRequired: {
    supportsPKCE: true,
    supportsResourceIndicators: true,
    requiresResourceParameter: true,
    validationMode: 'strict',
    serverUrl: 'http://localhost:3001'
  } as MockOAuthServerConfig,

  minimal: {
    supportsPKCE: false,
    supportsResourceIndicators: false,
    requiresResourceParameter: false,
    validationMode: 'lenient',
    serverUrl: 'http://localhost:3001'
  } as MockOAuthServerConfig,

  withErrors: {
    supportsPKCE: true,
    supportsResourceIndicators: true,
    requiresResourceParameter: false,
    validationMode: 'strict',
    serverUrl: 'http://localhost:3001',
    simulateErrors: {
      metadataDiscovery: false,
      authorization: false,
      tokenExchange: false,
      tokenRefresh: false
    }
  } as MockOAuthServerConfig
};

// Test client configurations
export const testClients = {
  publicClient: {
    client_id: 'test-public-client',
    client_name: 'Test Public Client',
    redirect_uris: ['http://localhost:3000/callback', 'http://localhost:3000/auth/callback']
  } as OAuthClientInformationFull,

  confidentialClient: {
    client_id: 'test-confidential-client',
    client_name: 'Test Confidential Client',
    client_secret: 'test-secret-123',
    redirect_uris: ['http://localhost:3000/callback']
  } as OAuthClientInformationFull,

  resourceLimitedClient: {
    client_id: 'test-resource-limited',
    client_name: 'Resource Limited Client',
    redirect_uris: ['http://localhost:3000/callback'],
    allowed_resources: ['http://localhost:3001', 'https://api.example.com']
  } as OAuthClientInformationFull & { allowed_resources: string[] },

  multiRedirectClient: {
    client_id: 'test-multi-redirect',
    client_name: 'Multi Redirect Client',
    redirect_uris: [
      'http://localhost:3000/callback',
      'http://localhost:3001/callback',
      'https://app.example.com/auth/callback'
    ]
  } as OAuthClientInformationFull
};

// Test scopes
export const testScopes = {
  basic: 'read',
  standard: 'read write',
  extended: 'read write profile email',
  mcp: 'mcp:tools mcp:resources',
  all: 'read write profile email mcp:tools mcp:resources'
};

// Test resources
export const testResources = {
  local: 'http://localhost:3001',
  localWithPath: 'http://localhost:3001/api/v1',
  localWithQuery: 'http://localhost:3001/api?version=1',
  remote: 'https://api.example.com',
  remoteWithPath: 'https://api.example.com/mcp',
  withPort: 'https://api.example.com:8443',
  withFragment: 'http://localhost:3001#section' // Should be rejected
};

// Test authorization codes
export const testAuthCodes = {
  valid: 'code_valid_12345',
  expired: 'code_expired_12345',
  used: 'code_used_12345',
  wrongClient: 'code_wrong_client_12345',
  invalidFormat: 'invalid-code-format'
};

// Test tokens
export const testTokens = {
  validAccess: 'access_valid_12345',
  expiredAccess: 'access_expired_12345',
  validRefresh: 'refresh_valid_12345',
  expiredRefresh: 'refresh_expired_12345',
  revokedRefresh: 'refresh_revoked_12345'
};

// PKCE test values
export const testPKCE = {
  // Valid PKCE pairs
  valid: {
    verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    method: 'S256'
  },
  
  // Another valid pair for testing
  alternate: {
    verifier: 'M25iVXpKU3puUQ3YWOKHtat8ytpI8Xi6Az1jA9qg8SA',
    challenge: 'qjrzSW9gMiUgv2_-7R9xEvg9cG9ZXWQJC2g6fXNqBWg',
    method: 'S256'
  },

  // Invalid pairs for error testing
  invalid: {
    verifier: 'invalid_verifier',
    challenge: 'invalid_challenge',
    method: 'S256'
  },

  // Verifier too short (should be 43-128 characters)
  tooShort: {
    verifier: 'short',
    challenge: 'wont_match',
    method: 'S256'
  },

  // Plain method (not supported by most implementations)
  plain: {
    verifier: 'plain_text_verifier',
    challenge: 'plain_text_verifier',
    method: 'plain'
  }
};

// Error scenarios
export const errorScenarios = {
  invalidClient: {
    error: 'invalid_client',
    error_description: 'Client authentication failed'
  },
  
  invalidGrant: {
    error: 'invalid_grant',
    error_description: 'The provided authorization grant is invalid'
  },
  
  invalidScope: {
    error: 'invalid_scope',
    error_description: 'The requested scope is invalid'
  },
  
  invalidTarget: {
    error: 'invalid_target',
    error_description: 'The requested resource is invalid'
  },
  
  serverError: {
    error: 'server_error',
    error_description: 'The authorization server encountered an unexpected condition'
  },
  
  accessDenied: {
    error: 'access_denied',
    error_description: 'The resource owner denied the request'
  }
};

// Test timing configurations
export const testTiming = {
  codeExpiration: 600000, // 10 minutes
  tokenExpiration: 3600000, // 1 hour
  refreshExpiration: 2592000000, // 30 days
  requestTimeout: 30000, // 30 seconds
  retryDelay: 1000 // 1 second
};

// Helper to generate dynamic test data
export function generateTestCode(): string {
  return `code_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

export function generateTestToken(type: 'access' | 'refresh' = 'access'): string {
  return `${type}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

export function generateTestState(): string {
  return `state_${Math.random().toString(36).substring(2, 15)}`;
}

// Test user actions
export const userActions = {
  approve: {
    action: 'approve',
    remember: false
  },
  
  approveAndRemember: {
    action: 'approve',
    remember: true
  },
  
  deny: {
    action: 'deny',
    reason: 'User denied access'
  },
  
  cancel: {
    action: 'cancel',
    reason: 'User cancelled the flow'
  }
};

// OAuth metadata variations for testing discovery
export const metadataVariations = {
  complete: {
    issuer: 'http://localhost:3001',
    authorization_endpoint: 'http://localhost:3001/authorize',
    token_endpoint: 'http://localhost:3001/token',
    registration_endpoint: 'http://localhost:3001/register',
    introspection_endpoint: 'http://localhost:3001/introspect',
    revocation_endpoint: 'http://localhost:3001/revoke',
    scopes_supported: ['read', 'write', 'profile'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic']
  },
  
  minimal: {
    issuer: 'http://localhost:3001',
    authorization_endpoint: 'http://localhost:3001/authorize',
    token_endpoint: 'http://localhost:3001/token'
  },
  
  noPKCE: {
    issuer: 'http://localhost:3001',
    authorization_endpoint: 'http://localhost:3001/authorize',
    token_endpoint: 'http://localhost:3001/token',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code']
  }
};