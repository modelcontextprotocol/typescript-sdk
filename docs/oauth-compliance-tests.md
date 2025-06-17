# OAuth Compliance Tests

## Overview

The MCP TypeScript SDK includes comprehensive OAuth 2.0 compliance tests that validate authentication flows according to OAuth 2.0, PKCE (RFC 7636), and Resource Indicators (RFC 8707) specifications. These tests mirror the functionality of the Auth Debugger in the MCP Inspector and ensure the SDK properly implements OAuth authentication.

## Quick Start

### Running Tests

```bash
# Run all OAuth compliance tests
npm test src/compliance/auth/*.test.ts

# Run specific test suite
npm test src/compliance/auth/oauth-flows.test.ts
npm test src/compliance/auth/pkce-compliance.test.ts  
npm test src/compliance/auth/resource-indicators.test.ts

# Run specific test pattern
npx jest -t "PKCE"
npx jest -t "should complete quick OAuth flow"
```

### Test Results Status

**Current Status**: ✅ **All 38 tests passing (100%)**

| Test Suite | Tests | Status | Description |
|------------|-------|--------|-------------|
| **OAuth Flows** | 15 | ✅ All Passing | Core OAuth 2.0 flow testing |
| **PKCE Compliance** | 13 | ✅ All Passing | RFC 7636 PKCE implementation testing |
| **Resource Indicators** | 10 | ✅ All Passing | RFC 8707 resource parameter testing |

---

## Test Architecture

### Infrastructure Components

#### 1. **Mock OAuth Server** (`src/compliance/fixtures/oauth-test-server.ts`)

A comprehensive Express-based OAuth 2.0 server implementation for testing:

**Features:**
- **Configurable Compliance Modes**: PKCE support, resource requirements, validation strictness
- **Full OAuth 2.0 Flow**: Authorization, token exchange, token introspection, refresh tokens
- **Metadata Discovery**: 
  - `/.well-known/oauth-authorization-server` (RFC 8414)
  - `/.well-known/openid-configuration` (OpenID Connect)
  - `/.well-known/oauth-protected-resource` (RFC 8707)
- **Dynamic Client Registration**: RFC 7591 support
- **Error Simulation**: Configurable error scenarios for testing failure modes
- **CORS Support**: Cross-origin requests for web clients

**Server Configurations:**
- `fullCompliance`: Supports all features with strict validation
- `pkceOnly`: PKCE support without resource indicators
- `resourceRequired`: Requires resource parameters for authorization
- `minimal`: Basic OAuth without advanced features
- `withErrors`: Error simulation scenarios

**Endpoints Implemented:**
- `/authorize` - Authorization endpoint with PKCE and resource parameter support
- `/token` - Token endpoint with PKCE verification
- `/introspect` - Token introspection (RFC 7662)
- `/revoke` - Token revocation (RFC 7009)
- `/register` - Dynamic client registration (RFC 7591)

#### 2. **Test Utilities** (`src/compliance/fixtures/test-utils.ts`)

**Core Testing Classes:**

**`TestOAuthClientProvider`**
- Mock implementation of `OAuthClientProvider` interface
- Simulates OAuth client behavior without browser redirects
- Stores tokens, code verifiers, and authorization URLs
- Throws controlled errors for testing redirect flows
- PKCE-aware with automatic challenge generation

**`OAuthFlowTester`**
- **Purpose**: Orchestrates complete OAuth flows for testing
- **Guided Flow** (`runGuidedFlow`): Step-by-step execution with validation callbacks
- **Quick Flow** (`runQuickFlow`): Automated end-to-end flow with error handling
- **Compliance Verification** (`verifyCompliance`): Validates flow results against OAuth specs
- **Multi-server Support**: Tests token isolation between different authorization servers

**`ComplianceAssertions`**
- Static assertion methods for OAuth specification compliance
- **PKCE Validation**: Code challenge format, method requirements, length constraints
- **Resource Indicators**: URI validation, fragment restrictions, consistency checks
- **Security Headers**: CORS, cache control, content type requirements
- **Token Response**: Required fields, token type validation, expiration handling
- **Error Response**: Standard OAuth error codes and structure validation

**Flow Testing Types:**
```typescript
interface FlowStep {
  name: string;
  action: () => Promise<FlowStepResult>;
  validate?: (result: any) => void;
}

interface FlowResult {
  success: boolean;
  steps: Array<{
    name: string;
    success: boolean;
    result?: FlowStepResult;
    error?: FlowStepError;
  }>;
  tokens?: OAuthTokens;
}

interface ComplianceReport {
  passed: string[];
  failed: string[];
  warnings: string[];
  details: Record<string, unknown>;
}
```

#### 3. **Test Data** (`src/compliance/fixtures/test-data.ts`)

**Predefined Test Configurations:**

**Test Clients:**
- `publicClient`: Standard public OAuth client for PKCE flows
- `confidentialClient`: Client with secret for private client flows
- `resourceLimitedClient`: Client restricted to specific resource URIs
- `multiRedirectClient`: Client with multiple valid redirect URIs

**Test Resources:**
- `local`: `http://localhost:3001` - Primary test resource
- `localWithPath`: `http://localhost:3001/api/v1` - Resource with path
- `localWithQuery`: `http://localhost:3001/api?version=1` - Resource with query parameters
- `external`: `https://api.example.com` - External resource
- `invalidWithFragment`: Invalid resource URLs for negative testing

**Test Scopes:**
- `basic`: `read` - Basic read access
- `standard`: `read write` - Standard access  
- `extended`: `read write profile email` - Extended user information
- `mcp`: `mcp:tools mcp:resources` - MCP-specific capabilities

---

## Test Suites Detailed

### 1. OAuth Flows Test Suite (`oauth-flows.test.ts`)

**Purpose**: Validates core OAuth 2.0 flow implementation and end-to-end authentication.

#### Metadata Discovery Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **OAuth metadata discovery** | Fetches from `/.well-known/oauth-authorization-server` | RFC 8414 metadata endpoint |
| **OpenID configuration fallback** | Fallback to `/.well-known/openid-configuration` | OpenID Connect compatibility |
| **Protected resource metadata** | Fetches resource-specific metadata | RFC 8707 resource discovery |

#### Client Registration Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Dynamic client registration** | Registers new OAuth clients via API | RFC 7591 registration |

#### Authorization Flow Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Authorization URL generation** | Creates proper OAuth authorization URLs | Parameter encoding, required fields |
| **Optional parameters** | Includes scope, state, resource parameters | Parameter inclusion logic |
| **Server redirect handling** | Processes authorization server redirects | Redirect flow, callback URL parsing |

#### Token Exchange Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Code to token exchange** | Exchanges authorization code for tokens | Token endpoint compliance |
| **Invalid code rejection** | Rejects forged/invalid authorization codes | Error handling |
| **PKCE verification** | Validates PKCE code verifier during exchange | PKCE flow security |

#### Complete Flow Integration Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Guided OAuth flow** | Step-by-step flow with inspection points | Full flow with intermediates |
| **Quick OAuth flow** | Automated end-to-end authentication | Production-ready flow path |
| **User cancellation handling** | Graceful handling of user flow cancellation | Cancellation scenarios |
| **Token exchange errors** | Error handling during token exchange | Failure mode recovery |

#### Multi-Server Authentication Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Token isolation** | Separate tokens for different servers | Server-specific token storage |

**Key Implementation Details:**
- Uses real HTTP requests to mock server (no mocking of `fetch`)
- Restores real `fetch` to avoid conflicts with other test mocks
- Validates PKCE parameters in authorization URLs and token exchanges
- Tests both successful and error scenarios
- Verifies token structure and required fields

---

### 2. PKCE Compliance Test Suite (`pkce-compliance.test.ts`)

**Purpose**: Validates PKCE (Proof Key for Code Exchange) implementation per RFC 7636.

#### Code Verifier Requirements Tests
| Test | Description | RFC 7636 Reference |
|------|-------------|-------------------|
| **Verifier length validation** | 43-128 characters | Section 4.1 |
| **Character set validation** | Only unreserved chars: `[A-Z] [a-z] [0-9] - . _ ~` | Section 4.1 |

#### Code Challenge Requirements Tests  
| Test | Description | RFC 7636 Reference |
|------|-------------|-------------------|
| **Challenge parameter inclusion** | `code_challenge` in authorization request | Section 4.2 |
| **Method specification** | `code_challenge_method=S256` | Section 4.2 |
| **SHA-256 calculation** | `BASE64URL(SHA256(code_verifier))` | Section 4.2 |
| **Base64URL encoding** | No padding, URL-safe characters | Section 4.2 |

#### PKCE Flow Integration Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Complete PKCE flow** | End-to-end flow with PKCE | Full RFC 7636 compliance |
| **Missing verifier rejection** | Token exchange fails without verifier | PKCE security enforcement |
| **Incorrect verifier rejection** | Token exchange fails with wrong verifier | Verifier validation |

#### Server PKCE Enforcement Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **PKCE requirement enforcement** | Servers can require PKCE for all clients | Security policy enforcement |
| **Legacy server compatibility** | Graceful handling of non-PKCE servers | Backward compatibility |

#### Error Cases Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Code replay attack prevention** | Authorization codes cannot be reused | Replay attack mitigation |
| **Plain method rejection** | Rejects insecure plain code challenge method | Security best practices |

**Security Notes:**
- Only S256 method is supported (SHA-256 based)
- Plain method is explicitly rejected for security
- Code verifiers are cryptographically secure
- Global Jest mock provides consistent challenge generation for testing

---

### 3. Resource Indicators Test Suite (`resource-indicators.test.ts`)

**Purpose**: Validates Resource Indicators implementation per RFC 8807.

#### Resource Parameter Validation Tests
| Test | Description | RFC 8707 Reference |
|------|-------------|-------------------|
| **URI format validation** | Resource must be valid URI | Section 2 |
| **Fragment restriction** | Resource URIs cannot contain fragments | Section 2 |
| **Valid URI acceptance** | Accepts properly formatted URIs | Section 2 |

#### Token Exchange Consistency Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Resource consistency** | Same resource in authorization and token exchange | Parameter consistency |
| **Matching resource acceptance** | Allows token exchange with matching resource | Flow completion |

#### Token Introspection Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Resource in introspection** | Token introspection includes resource info | RFC 8707 introspection |

#### Server Resource Requirements Tests
| Test | Description | Validates |
|------|-------------|-----------|
| **Required resource enforcement** | Servers can require resource parameter | Policy enforcement |
| **Optional resource support** | Servers can work without resource parameter | Flexibility |

#### Protected Resource Metadata Tests
| Test | Description | RFC 8707 Reference |
|------|-------------|-------------------|
| **Metadata discovery** | Discovers resource metadata endpoint | Section 4 |
| **Authorization server references** | Uses authorization servers from metadata | Section 4 |

**Resource Parameter Rules:**
- Must be absolute URI without fragment
- Can include path and query parameters  
- Enforced consistently across authorization and token requests
- Included in token introspection responses
- Multiple resources can be specified in some flows

---

## OAuth Flow Mechanics

### Guided OAuth Flow

**Purpose**: Step-by-step OAuth process for detailed inspection and debugging.

**Flow Steps:**

1. **Metadata Discovery**
   - Fetch OAuth server metadata from well-known endpoints
   - Validate required endpoints (authorization, token)
   - Parse supported features (PKCE, resource indicators)

2. **Authorization Request**  
   - Generate PKCE code verifier and challenge
   - Build authorization URL with all parameters
   - Handle user redirect to authorization server

3. **Authorization Response**
   - Parse callback URL for authorization code  
   - Validate state parameter if provided
   - Handle user cancellation gracefully

4. **Token Exchange**
   - Exchange authorization code for tokens
   - Include PKCE code verifier for verification
   - Validate token response structure

5. **Token Storage**
   - Store tokens in provider implementation
   - Associate with specific server URL
   - Enable future token reuse

**Benefits:**
- Complete visibility into each OAuth step
- Detailed error information at each stage
- Customizable validation at each step
- Ideal for debugging authentication issues

### Quick OAuth Flow  

**Purpose**: Automated end-to-end OAuth authentication for rapid testing.

**Process:**
- Automatically handles entire OAuth flow including redirects
- Simulates authorization server redirect internally 
- Returns final tokens or detailed error information
- Maintains compliance with all OAuth/PKCE requirements

**Implementation:**
- Uses real HTTP requests to mock authorization server
- Proper redirect handling via `fetch` with `redirect: 'manual'`  
- Extracts authorization code from callback URL
- Handles both success and error scenarios automatically

**Benefits:**
- Fast authentication for standard testing
- Production-equivalent flow path
- Automated error handling
- Minimal test setup required

---

## Compliance Verification

### PKCE Detection Logic

The compliance verification system checks for PKCE usage across multiple result structures:

1. **Direct URL Result**: When authorization returns redirect URL directly
2. **Error Message Extraction**: When redirect is caught as error with URL 
3. **Saved Provider URL**: For guided flows where URL is stored in provider
4. **Parameter Validation**: Verifies `code_challenge` and `code_challenge_method` parameters

**Type-Safe Implementation:**
```typescript
// Checks result object structure safely
if (authStep?.result && typeof authStep.result === 'object' && 'url' in authStep.result) {
  const resultUrl = authStep.result.url;
  const urlString = typeof resultUrl === 'string' ? resultUrl : 
                   resultUrl instanceof URL ? resultUrl.toString() : String(resultUrl);
  const url = new URL(urlString);
  if (url.searchParams.get('code_challenge')) {
    pkceChallengeFound = true;
  }
}
```

### Compliance Report Generation

Each OAuth flow generates a comprehensive compliance report:

**Structure:**
- **Passed**: Successfully validated compliance aspects
- **Failed**: Specification violations found  
- **Warnings**: Potential issues (missing optional features)
- **Details**: Quantitative flow metrics (steps, success rate)

**Key Checks:**
- Flow completion success
- Token reception and structure
- PKCE parameter presence and format
- Security header compliance
- Error response format compliance

---

## Mock Server Configuration

### Server Compliance Modes

| Mode | PKCE Support | Resource Indicators | Resource Required | Validation Mode | Use Case |
|------|--------------|---------------------|-------------------|-----------------|-----------|
| **Full Compliance** | ✅ | ✅ | ❌ | Strict | Complete spec testing |
| **PKCE Only** | ✅ | ❌ | ❌ | Lenient | PKCE-focused testing |  
| **Resource Required** | ✅ | ✅ | ✅ | Strict | Resource indicators testing |
| **Minimal** | ❌ | ❌ | ❌ | Lenient | Legacy compatibility testing |
| **With Errors** | ✅ | ✅ | ❌ | Strict | Error scenario testing |

### Port Configuration

**Port Isolation:**
- **OAuth Flows**: Port 3001 (matches test data configuration)
- **Resource Indicators**: Port 3003 (isolated testing environment)  
- **PKCE Compliance**: Uses main test port with specific client setup
- **Multi-server Tests**: Dynamically assigned ports for isolation

**Important:** Test server configurations override hardcoded `serverUrl` values to ensure proper port usage and avoid conflicts.

### Error Simulation

The mock server supports configurable error scenarios:

- **Metadata Discovery Errors**: Missing or invalid metadata endpoints
- **Authorization Errors**: Invalid client, unsupported response type  
- **Token Exchange Errors**: Invalid code, PKCE mismatch, expired code
- **Token Refresh Errors**: Invalid refresh token, expired refresh

---

## Technical Implementation Details

### TypeScript Type Safety

**Flow Result Types:**
```typescript
interface AuthRedirectResult {
  type: 'redirect';
  url: URL | string;
}

interface FlowStepResult {
  // Union type supporting various step result formats
  // Properly typed for step-specific validation
}

interface FlowStepError {
  message: string;
  [key: string]: unknown;
}
```

**Benefits:**
- Full type safety for OAuth flow results
- Eliminates `any` types from test infrastructure
- Enables proper IntelliSense and error detection
- Supports multiple result format patterns

### Jest Configuration Compatibility

**Fetch Mock Handling:**
- Restores real `fetch` for integration testing
- Avoids conflicts with global Jest mocks
- Enables proper HTTP request testing

**PKCE Mock Integration:**
- Uses global `pkce-challenge` mock for consistent testing
- Mock provides cryptographically correct SHA-256 challenges
- Fixed test values enable reproducible test results

---

## Running the Tests

### Individual Test Execution

```bash
# OAuth flows (15 tests)
npm test src/compliance/auth/oauth-flows.test.ts

# PKCE compliance (13 tests)  
npm test src/compliance/auth/pkce-compliance.test.ts

# Resource indicators (10 tests)
npm test src/compliance/auth/resource-indicators.test.ts
```

### Targeted Test Patterns

```bash
# Run PKCE-related tests across all suites
npx jest -t "PKCE"

# Run flow completion tests
npx jest -t "flow"

# Run specific test by exact name
npx jest -t "should complete quick OAuth flow automatically"
```

### Build and Lint Integration

**Before Test Execution:**
```bash
npm run build        # Ensures TypeScript compilation  
npm run lint         # Validates code quality
npm test             # Runs all tests including compliance
```

**Test Requirements:**
- Node.js >= 18 required
- No external OAuth providers needed
- Self-contained test environment
- Full offline execution capability

---

## External Testing Capabilities

The OAuth compliance testing infrastructure can be extended to test both external OAuth clients and real OAuth servers. This section analyzes the current capabilities and provides implementation guidance.

### Testing External OAuth Clients Against Mock Server

**Use Case**: Validate that external OAuth clients (like the MCP Inspector Auth Debugger) can successfully authenticate with MCP servers.

#### Current Capabilities

✅ **Already Possible:**
- **Interface Compatibility**: The `OAuthClientProvider` interface is shared between test and production environments
- **Full OAuth Flow Support**: Mock server implements complete authorization, token exchange, and introspection endpoints  
- **PKCE Validation**: Can test external clients' PKCE implementation compliance
- **Resource Indicators**: Can validate external clients' RFC 8707 resource parameter handling
- **Error Scenario Testing**: Mock server can simulate various failure modes

#### Required Extensions

**1. Network-Enabled Mock Server**

**Current Limitation**: Mock server only binds to `localhost`, making it inaccessible to external clients.

**Solution Implementation**:
```typescript
interface ExternalAccessConfig {
  enableExternalAccess: boolean;
  bindAddress: string;      // "0.0.0.0" for external access
  publicUrl: string;        // For redirect URI validation 
  corsPolicy: {
    origins: string[];      // Allowed client origins
    credentials: boolean;   // Allow cookies/auth headers
  };
  tlsMode: 'none' | 'self-signed' | 'real-cert';
  certificatePath?: string;
}

class ExternalMockOAuthServer extends MockOAuthServer {
  constructor(
    config: MockOAuthServerConfig,
    networkConfig: ExternalAccessConfig
  ) { /* ... */ }
  
  async start(port: number): Promise<ServerInfo> {
    if (this.networkConfig.tlsMode !== 'none') {
      return this.startHTTPS(port);  // Enable HTTPS for external clients
    }
    return super.start(port);
  }
}
```

**Benefits**:
- External clients can connect from any network location
- HTTPS support enables testing with real-world security requirements
- CORS configuration allows web-based clients
- Proper redirect URI validation across domains

**2. External Client Integration Adapter**

**Current Limitation**: No mechanism to coordinate with external client testing.

**Solution Implementation**:
```typescript
interface ExternalClientInfo {
  clientType: 'inspector-debugger' | 'vscode-extension' | 'cli-tool';
  authEndpointOverride?: string;
  clientId: string;
  redirectUri: string;
  expectedBehavior: {
    supportsPKCE: boolean;
    supportsResourceIndicators: boolean;
    authenticationMethod: string;
  };
}

class ExternalClientTestAdapter {
  constructor(
    serverInfo: ServerInfo,
    clientInfo: ExternalClientInfo
  ) { /* ... */ }
  
  async validateClientRegistration(): Promise<ValidationReport> {
    // Test client's metadata discovery capabilities
    // Verify client can perform dynamic registration (RFC 7591)
    // Validate client's endpoint connectivity
  }
  
  async runExternalClientFlow(): Promise<FlowResult> {
    // Monitor server logs for client interactions
    // Return results in standard FlowResult format
    // Apply same compliance validation as internal tests
  }
}
```

**3. HTTPS/TLS Support**

**Current Limitation**: Mock server only supports HTTP, but production OAuth requires HTTPS.

**Required Components**:
- Self-signed certificate generation for testing
- Certificate trust management for test environments  
- TLS configuration with proper cipher suites
- Redirect URI scheme validation (HTTPS enforcement)

**Implementation Priority**: **High** - Essential for testing real clients that enforce HTTPS

---

### Testing Real OAuth Servers Against Test Client

**Use Case**: Validate that the MCP SDK OAuth client works correctly with production OAuth servers like Google, GitHub, or enterprise Identity Providers.

#### Current Capabilities

✅ **Already Possible:**
- **Client Interface Reuse**: `TestOAuthClientProvider` implements the same interface as production clients
- **Flow Orchestration**: `OAuthFlowTester` can orchestrate flows regardless of server backend
- **Compliance Validation**: Same compliance assertions apply to real server responses
- **PKCE Generation**: Can test PKCE compliance with real servers

#### Required Extensions

**1. Real Network Transport Layer**

**Current Limitation**: Test client is designed to work with mock server's predictable responses.

**Solution Implementation**:
```typescript
interface RealServerConfig {
  serverType: 'google' | 'github' | 'auth0' | 'okta' | 'azure-ad' | 'custom';
  discoveryUrl: string;
  clientId: string;           // Pre-registered client ID
  clientSecret?: string;      // For confidential clients
  redirectUri: string;        // Must be externally accessible
  scope: string;
  resourceUri?: string;       // For RFC 8707 testing
}

class RealServerTestProvider extends TestOAuthClientProvider {
  constructor(
    config: RealServerConfig,
    networkHandler: RedirectHandler
  ) {
    super(config.discoveryUrl);
    this.networkHandler = networkHandler;
  }
  
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Use pluggable redirect handler instead of throwing test error
    return this.networkHandler.handleAuthorization(authorizationUrl);
  }
}
```

**2. Redirect Flow Handlers**

**Current Limitation**: Test environment cannot handle real browser redirects.

**Solution - Multiple Handler Implementations**:

**Option A: Headless Browser Handler**
```typescript
class HeadlessBrowserHandler implements RedirectHandler {
  private page: playwright.Page;
  
  async handleAuthorization(url: URL): Promise<void> {
    // Navigate to authorization URL in headless browser
    await this.page.goto(url.toString());
    
    // Auto-detect authorization page and simulate user consent
    // For test accounts: automatically approve requests
    // For real testing: capture OAuth consent flow
    
    const callbackUrl = await this.waitForCallback();
    this.extractedCode = new URL(callbackUrl).searchParams.get('code');
  }
}
```

**Benefits**: 
- Fully automated testing including user consent
- Can handle JavaScript-heavy authorization pages
- Enables testing of dynamic consent flows

**Option B: Callback Server Handler**  
```typescript
class CallbackServerHandler implements RedirectHandler {
  async handleAuthorization(url: URL): Promise<void> {
    // Start local HTTP server on redirect URI port
    // Open system browser to authorization URL  
    // Wait for callback request to local server
    // Extract authorization code automatically
  }
}
```

**Benefits**:
- Works with any browser/device combination
- Handles complex authentication flows (MFA, SSO)
- Good for interactive testing scenarios

**Option C: Manual Testing Handler**
```typescript
class ManualTestingHandler implements RedirectHandler {
  async handleAuthorization(url: URL): Promise<void> {
    console.log('Manual authorization required:');
    console.log(url.toString());
    
    // Prompt for callback URL via command line
    const callbackUrl = await this.promptForInput();
    this.extractedCode = new URL(callbackUrl).searchParams.get('code');
  }
}
```

**Benefits**:
- Simplest implementation for development
- Useful for debugging specific authorization flows
- No additional dependencies required

**3. Server-Specific Adaptation Layer**

**Challenge**: Different OAuth providers have implementation quirks.

**Real-World Provider Differences**:

| Provider | Discovery Path | Special Parameters | Auth Method Support |
|----------|----------------|-------------------|---------------------|
| **Google** | `/.well-known/openid-configuration` | `access_type=offline` for refresh tokens | All standard methods |
| **GitHub** | `/.well-known/oauth-authorization-server` | `scope` format: space-separated | Client secret only |
| **Azure AD** | `/v2.0/.well-known/openid-configuration` | `prompt=consent` for admin consent | Supports mTLS, JWT |
| **Auth0** | `/.well-known/openid-configuration` | Custom domain discovery | Full RFC compliance |

**Implementation Pattern**:
```typescript
interface ServerAdapter {
  discoverMetadata(serverUrl: string): Promise<OAuthMetadata>;
  prepareAuthorizationRequest(params: AuthParams): Promise<AuthParams>;
  processTokenResponse(response: any): Promise<OAuthTokens>;
}

class GoogleOAuthAdapter implements ServerAdapter {
  async discoverMetadata(serverUrl: string): Promise<OAuthMetadata> {
    // Google uses OpenID Connect discovery endpoint
    const response = await fetch(`${serverUrl}/.well-known/openid-configuration`);
    return this.normalizeGoogleMetadata(await response.json());
  }
  
  async prepareAuthorizationRequest(params: AuthParams): Promise<AuthParams> {
    // Google-specific parameters for refresh token support
    return {
      ...params,
      additionalParams: {
        access_type: 'offline'
      }
    };
  }
}

class ServerAdapterRegistry {
  constructor() {
    this.register('google', new GoogleOAuthAdapter());
    this.register('github', new GitHubOAuthAdapter());
    this.register('azure-ad', new AzureADAdapter());
  }
}
```

---

### End-to-End External Testing

**Use Case**: Test that real OAuth clients can successfully authenticate with real OAuth servers, with the testing infrastructure mediating and validating the complete flow.

#### Architecture Overview

```typescript
interface E2ETestConfig {
  client: {
    type: 'inspector-debugger' | 'vscode-extension' | 'mobile-app';
    connectionMode: 'direct' | 'proxied';
    configuration: any;
  };
  server: {
    type: 'google' | 'github' | 'self-hosted';
    testAccount: {
      username: string;
      password: string;  // For automated testing only
    };
  };
  validationRules: {
    pkceRequired: boolean;
    resourceIndicatorsExpected: boolean;
    securityHeadersRequired: string[];
  };
}

class EndToEndComplianceTester {
  constructor(config: E2ETestConfig) {
    this.trafficCapture = new NetworkTrafficCapture();
    this.clientAdapter = this.createClientAdapter(config.client);
    this.serverAdapter = this.createServerAdapter(config.server);
  }
  
  async runE2ETest(): Promise<E2ETestResult> {
    // 1. Start network traffic capture for protocol analysis
    await this.trafficCapture.startCapture();
    
    // 2. Run authentication flow with both client and server monitoring
    const flowResult = await this.runMonitoredFlow();
    
    // 3. Analyze captured OAuth protocol messages
    const trafficAnalysis = await this.trafficCapture.analyzeCompliance();
    
    // 4. Generate comprehensive compliance report
    return this.generateReport(flowResult, trafficAnalysis);
  }
}
```

**Benefits of E2E Testing**:
- **Real-World Validation**: Tests actual production scenarios
- **Cross-System Compatibility**: Ensures different OAuth implementations work together
- **Security Validation**: Can detect real security issues that mocks might miss
- **Performance Analysis**: Can measure real-world latency and reliability

---

## Implementation Roadmap

### Phase 1: External Client Testing Foundation 
**Timeline**: 1-2 weeks | **Complexity**: Medium | **Value**: High

**Deliverables**:
1. **Network-Enabled Mock Server** 
   - Bind to external addresses beyond localhost
   - CORS configuration for web clients
   - Optional HTTPS/TLS support with self-signed certificates

2. **External Client Integration Infrastructure**
   - Connection monitoring and logging
   - Client behavior validation against expected patterns
   - Integration with existing `FlowResult` and `ComplianceReport` structures

3. **Documentation Updates**
   - External client testing guide
   - Network configuration requirements  
   - Security considerations and limitations

**Immediate Benefits**:
- **MCP Inspector Auth Debugger** can be tested against the compliance server
- **External web applications** can be validated for OAuth compliance
- **Development teams** can test their OAuth clients without setting up production servers

**Example Usage**:
```bash
# Start external-enabled compliance server
npm run test:compliance -- --external-access --https=self-signed --port=8443

# In another terminal, point external client to:
# https://localhost:8443/.well-known/oauth-authorization-server
```

---

### Phase 2: Real Server Integration
**Timeline**: 2-3 weeks | **Complexity**: Medium | **Value**: High  

**Deliverables**:
1. **Server Adapter Registry**
   - Google OAuth 2.0 adapter with OpenID Connect discovery
   - GitHub OAuth adapter with scope handling
   - Generic adapter for RFC-compliant servers

2. **Redirect Flow Handlers** 
   - Headless browser handler using Playwright
   - HTTP callback server for local testing
   - Manual testing handler for development debugging

3. **Test Account Management**
   - Secure credential handling for automated testing
   - Test account provisioning for major providers
   - Consent flow automation for streamlined testing

**Immediate Benefits**:
- **Real Provider Validation**: Test SDK against Google, GitHub, etc.
- **Automated Regression Testing**: Continuous validation against external servers
- **Provider Compatibility Matrix**: Clear documentation of which providers work with which features

**Example Usage**:
```bash
# Test SDK client against Google OAuth
npm run test:compliance -- --real-server=google --client-id=XXX --redirect-handler=headless

# Generate compatibility report
npm run test:compliance -- --matrix-test --output=compatibility-report.json
```

---

### Phase 3: Advanced Protocol Testing
**Timeline**: 4-6 weeks | **Complexity**: High | **Value**: Medium

**Deliverables**:
1. **Network Traffic Analysis**
   - Protocol message capture and validation
   - Security header analysis  
   - RFC compliance verification from packet level

2. **Multi-Server Cross-Testing**
   - Different clients against different servers
   - Token isolation validation across environments
   - Cross-provider consistency verification

3. **Advanced Error Scenario Testing**
   - Network fault injection for resilience testing
   - Race condition simulation  
   - Protocol edge case validation

**Benefits**:
- **Deep Protocol Validation**: Beyond functional testing to RFC compliance
- **Security Analysis**: Real-world security header and flow validation  
- **Resilience Testing**: Network failure and recovery capabilities

---

## Testing Real-World Scenarios

### Scenario 1: MCP Inspector Auth Debugger Validation

**Setup Process**:

1. **Start Network-Enabled Mock Server**:
   ```bash
   cd mcp-typescript-sdk
   npm run test:compliance -- --external-access --https=self-signed --port=8443
   ```

2. **Configure MCP Inspector**:
   - Point to server: `https://localhost:8443`
   - Accept self-signed certificate  
   - Use predefined test client ID: `test-client`

3. **Test Both Flow Modes**:
   - **Guided Flow**: Step through authorization, inspect each stage
   - **Quick Flow**: Complete automated flow, verify token reception

**Expected Validation**:
- ✅ Metadata discovery via `/.well-known/oauth-authorization-server`
- ✅ PKCE parameter generation and inclusion
- ✅ Authorization URL formation with all required parameters
- ✅ Callback handling and code extraction  
- ✅ Token exchange with PKCE verification
- ✅ Token storage and reuse capability

**Troubleshooting Common Issues**:
- **Certificate Trust**: Browser may require manual certificate acceptance
- **CORS Errors**: Ensure origins are configured in server CORS policy
- **Redirect URI Mismatch**: Verify Inspector uses same URI as configured in mock server

---

### Scenario 2: SDK Client Against Google OAuth

**Setup Process**:

1. **Register Test Application**:
   - Create OAuth client in Google Cloud Console
   - Configure redirect URI: `http://localhost:3000/callback`
   - Obtain client ID (no client secret needed for PKCE flow)

2. **Configure Test Environment**:
   - Install redirect handler: `npm install --save-dev playwright`
   - Set up test Google account with minimal permissions
   - Configure SDK test with Google-specific adapter

3. **Run Compliance Test**:
   ```bash
   npm run test:compliance -- \
     --real-server=google \
     --client-id="123456789.apps.googleusercontent.com" \
     --redirect-handler=headless \
     --scope="openid email" \
     --test-account=oauth-test@gmail.com
   ```

**Expected Validation**:
- ✅ OpenID Connect metadata discovery  
- ✅ PKCE challenge generation (SDK client)
- ✅ Google-specific parameter handling (`access_type=offline`)
- ✅ Automated user consent via headless browser
- ✅ Token response validation including ID token
- ✅ Refresh token capability verification

**Compatibility Verification**:
- **PKCE Method**: Google supports S256 (SHA-256) method
- **Resource Indicators**: Google has limited support, may ignore resource parameters
- **Refresh Tokens**: Requires `access_type=offline` parameter
- **Scope Handling**: Uses space-separated scopes, supports OpenID Connect scopes

---

## Security Considerations for External Testing

### Network Security

**HTTPS Requirements**:
- **Self-signed certificates** are sufficient for local testing
- **Certificate pinning** should be disabled for test environments  
- **TLS version compatibility** should match production requirements

**Network Isolation**:
- **External access mode** should bind only to required interfaces
- **Firewall rules** should restrict access to test networks when possible
- **VPN considerations** may be needed for security-sensitive testing

### Credential Management  

**Test Account Security**:
- **Dedicated test accounts** should be used, never production accounts
- **Minimal permissions** should be granted to test applications
- **Credential rotation** should be performed regularly

**Client Registration**:
- **Test client IDs** should be clearly distinguished from production
- **Redirect URI validation** must be maintained even in test mode
- **Client secret handling** should follow same security practices as production

---

## Conclusion

The OAuth compliance testing infrastructure is **highly extensible for external testing scenarios** with moderate engineering effort. The foundational architecture's interface-based design and comprehensive protocol support provide an excellent foundation for both:

1. **Testing External Clients**: With Phase 1 network enhancements, external OAuth clients can be validated against the mock server for RFC compliance verification.

2. **Testing Against Real Servers**: With Phase 2 redirect handler and server adapter implementations, the SDK can be tested against production OAuth providers.

**Key Architectural Strengths**:
- Clean separation between client interface, flow orchestration, and server backend
- Comprehensive compliance validation that works regardless of component implementation  
- Well-tested infrastructure with high reliability
- Extensive configuration options for different testing scenarios

**Recommended Starting Point**: **Phase 1 External Client Testing** provides immediate value with manageable complexity and enables validation of the most critical use case: ensuring external clients work with MCP servers.

---

## Future Enhancements

### Additional Test Suites

1. **Error Handling Test Suite** (`error-handling.test.ts`):
   - Comprehensive error scenario testing across network failures
   - Protocol error response validation
   - Client error recovery capability testing
   - Server fault tolerance verification

2. **Token Management Test Suite** (`token-management.test.ts`):
   - Token lifecycle testing (issuance, refresh, expiration)  
   - Multi-token scenarios (different scopes, resources)
   - Token revocation and cleanup verification
   - Cross-session token isolation

3. **Security Compliance Test Suite** (`security-compliance.test.ts`):
   - TLS/HTTPS enforcement validation
   - PKCE implementation security testing
   - Replay attack prevention verification  
   - Cross-site request forgery (CSRF) protection testing

### Advanced Integration Capabilities

1. **Continuous Integration Support**:
   - Docker container packaging for easy CI deployment
   - GitHub Actions integration for automated testing
   - Compliance report generation for build artifacts
   - Test result dashboard integration

2. **Cross-Platform Testing**:
   - Mobile application OAuth flow testing
   - Native application redirect scheme handling
   - Desktop application local server callback testing
   - Web browser extension testing support

**Estimated Development Effort**: The complete external testing capability requires 8-12 engineer weeks, but provides significant value for OAuth ecosystem validation and debugging.

---

## Troubleshooting

### Common Test Issues

**1. Port Conflicts**
- **Symptom**: Server start failures, connection refused errors
- **Solution**: Ensure unique ports across test suites, check process cleanup

**2. Mock Interference**  
- **Symptom**: Unexpected `fetch` behavior, missing responses
- **Solution**: Verify real `fetch` restoration in test setup

**3. PKCE Verification Failures**
- **Symptom**: "PKCE not detected" warnings in compliance reports  
- **Solution**: Check PKCE parameter presence in authorization URLs

**4. TypeScript Compilation Errors**
- **Symptom**: Test file compilation failures
- **Solution**: Ensure proper type annotations, run `npm run build`

### Debug Mode

For detailed debugging, enable verbose Jest output:

```bash
npm test src/compliance/auth/*.test.ts -- --verbose
```

This provides:
- Individual test execution status
- Detailed assertion failures  
- Timing information
- Step-by-step flow progress

---

## Related Documentation

- **OAuth 2.0 RFC 6749**: [https://tools.ietf.org/html/rfc6749](https://tools.ietf.org/html/rfc6749)
- **PKCE RFC 7636**: [https://tools.ietf.org/html/rfc7636](https://tools.ietf.org/html/rfc7636)  
- **Resource Indicators RFC 8707**: [https://tools.ietf.org/html/rfc8707](https://tools.ietf.org/html/rfc8707)
- **MCP Auth Debugger**: `docs/auth_debugger.md`
- **SDK Auth Implementation**: `src/client/auth.ts`, `src/shared/auth.ts`

---

## Summary

The OAuth Compliance Tests provide comprehensive validation of the MCP TypeScript SDK's OAuth 2.0 implementation. With **100% test coverage across 38 tests**, the test infrastructure ensures:

- **Complete OAuth 2.0 Compliance**: Authorization flows, token management, error handling
- **PKCE Security**: Proper PKCE implementation preventing authorization code injection attacks  
- **Resource Indicators Support**: RFC 8707 compliance for multi-resource scenarios
- **Type-Safe Implementation**: Full TypeScript type safety without `any` usage
- **Production Readiness**: Tests validate both happy path and error scenarios

The test architecture mirrors the Auth Debugger functionality, ensuring that the SDK implementation matches the debugging tooling and providing confidence in OAuth authentication reliability.