import {
  JWTAssertionOptions,
  JWTSigningOptions,
  JWTClientCredentials,
  JWTValidationResult,
  JWTClientAssertionPayload,
  JWTBearerGrantPayload
} from './auth.js';
import type { JWTClaimVerificationOptions, JWTHeaderParameters } from 'jose';
import { SignJWT, importPKCS8, importJWK, decodeProtectedHeader, decodeJwt, jwtVerify, importSPKI } from 'jose';
import { randomUUID } from 'crypto';
import {
  InvalidJWTError,
  UnsupportedJWTAlgorithmError,
  ExpiredJWTError,
  InvalidJWTAudienceError
} from '../server/auth/errors.js';

/**
 * JWT Assertion Generator
 * Handles generation of JWT assertions for client authentication and bearer grants
 */
export class JWTAssertionGenerator {
  /**
   * Generate a JWT assertion with the given options and signing configuration
   */
  static async generateAssertion(
    options: JWTAssertionOptions,
    signingOptions: JWTSigningOptions
  ): Promise<string> {
    try {

      const now = Math.floor(Date.now() / 1000);
      const expiresIn = options.expiresIn || 300; // Default 5 minutes

      // Create JWT payload
      const payload = {
        iss: options.issuer,
        sub: options.subject,
        aud: options.audience,
        exp: now + expiresIn,
        iat: now,
        ...(options.notBefore && { nbf: options.notBefore }),
        ...(options.jwtId && { jti: options.jwtId }),
        ...options.additionalClaims,
      };

      // Create JWT builder
      const jwt = new SignJWT(payload)
        .setProtectedHeader({
          alg: signingOptions.algorithm,
          ...(signingOptions.keyId && { kid: signingOptions.keyId })
        });

      // Sign with appropriate key material using jose library's key handling
      if (signingOptions.secret) {
        // HMAC signing
        const secret = new TextEncoder().encode(signingOptions.secret);
        return await jwt.sign(secret);
      } else if (signingOptions.privateKey) {
        // RSA/ECDSA signing - let jose handle key format detection
        if (typeof signingOptions.privateKey === 'string') {
          try {
            // Try PKCS8 format first
            const key = await importPKCS8(signingOptions.privateKey, signingOptions.algorithm);
            return await jwt.sign(key);
          } catch {
            try {
              // Try JWK format if PKCS8 fails
              const key = await importJWK(JSON.parse(signingOptions.privateKey), signingOptions.algorithm);
              return await jwt.sign(key);
            } catch {
              // If both fail, throw JWT-specific error
              throw new InvalidJWTError('Invalid private key format. Expected PKCS8 PEM or JWK JSON format');
            }
          }
        } else {
          return await jwt.sign(signingOptions.privateKey);
        }
      } else {
        throw new InvalidJWTError('Either secret or privateKey must be provided for JWT signing');
      }
    } catch (error) {
      // Re-throw JWT-specific errors as-is
      if (error instanceof InvalidJWTError ||
        error instanceof UnsupportedJWTAlgorithmError ||
        error instanceof ExpiredJWTError ||
        error instanceof InvalidJWTAudienceError) {
        throw error;
      }

      // Wrap other errors as InvalidJWTError
      throw new InvalidJWTError(`Failed to generate JWT assertion: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate a JWT assertion for client authentication
   * Ensures MCP-compliant audience validation for token endpoints
   */
  static async generateClientAssertion(
    clientId: string,
    tokenEndpoint: string,
    credentials: JWTClientCredentials,
    resource?: URL
  ): Promise<string> {
    const jwtId = generateJwtId(clientId);

    // For MCP compliance, ensure audience is properly set to the token endpoint
    // The audience should be the token endpoint URL, not the resource URL
    const audience = normalizeMCPAudience(tokenEndpoint, resource);

    const options: JWTAssertionOptions = {
      issuer: credentials.issuer || clientId,
      subject: credentials.subject || clientId,
      audience,
      expiresIn: credentials.tokenLifetime || 300,
      jwtId,
    };

    const signingOptions: JWTSigningOptions = {
      algorithm: credentials.algorithm || (credentials.clientSecret ? 'HS256' : 'RS256'),
      secret: credentials.clientSecret,
      privateKey: credentials.privateKey,
      keyId: credentials.keyId,
    };

    return this.generateAssertion(options, signingOptions);
  }

  /**
   * Generate a JWT assertion for bearer authorization grants
   * Ensures MCP-compliant audience validation and resource binding
   */
  static async generateBearerAssertion(
    issuer: string,
    subject: string,
    audience: string,
    credentials: JWTClientCredentials,
    resource?: URL,
    additionalClaims?: Record<string, unknown>
  ): Promise<string> {
    const jwtId = generateJwtId(issuer);

    // For MCP compliance, ensure audience properly handles resource binding
    // The audience should include both the authorization server and the resource if specified
    const mcpAudience = normalizeMCPAudience(audience, resource);

    // Add MCP-specific claims for resource binding if resource is provided
    const mcpClaims = resource ? {
      ...additionalClaims,
      // Include resource URL in claims for MCP compliance
      resource: resource.toString(),
    } : additionalClaims;

    const options: JWTAssertionOptions = {
      issuer: credentials.issuer || issuer,
      subject: credentials.subject || subject,
      audience: mcpAudience,
      expiresIn: credentials.tokenLifetime || 300,
      jwtId,
      additionalClaims: mcpClaims,
    };

    const signingOptions: JWTSigningOptions = {
      algorithm: credentials.algorithm || (credentials.clientSecret ? 'HS256' : 'RS256'),
      secret: credentials.clientSecret,
      privateKey: credentials.privateKey,
      keyId: credentials.keyId,
    };

    return this.generateAssertion(options, signingOptions);
  }
}

/**
 * JWT Validator
 * Handles validation of JWT assertions for client authentication and bearer grants
 */
export class JWTValidator {
  /**
   * Validate a JWT client assertion
   */
  static async validateClientAssertion(
    assertion: string,
    tokenEndpoint: string,
    clientSecret?: string,
    publicKey?: string | Buffer,
    options?: Partial<JWTClaimVerificationOptions>
  ): Promise<JWTValidationResult> {
    const validationOptions: JWTClaimVerificationOptions = {
      audience: tokenEndpoint,
      clockTolerance: 30,
      maxTokenAge: 300,
      ...options,
    };

    return this.validateAssertion(assertion, clientSecret, publicKey, validationOptions);
  }

  /**
   * Validate a JWT bearer assertion
   */
  static async validateBearerAssertion(
    assertion: string,
    expectedAudience: string,
    clientSecret?: string,
    publicKey?: string | Buffer,
    options?: Partial<JWTClaimVerificationOptions>
  ): Promise<JWTValidationResult> {
    const validationOptions: JWTClaimVerificationOptions = {
      audience: expectedAudience,
      clockTolerance: 30,
      maxTokenAge: 300,
      ...options,
    };

    return this.validateAssertion(assertion, clientSecret, publicKey, validationOptions);
  }

  /**
   * Validate a JWT client assertion with client store integration
   * This method is designed for server-side validation where client credentials
   * are retrieved from the client store based on the JWT claims
   */
  static async validateClientAssertionWithStore(
    assertion: string,
    tokenEndpoint: string,
    clientsStore: unknown, // OAuthRegisteredClientsStore - avoiding import cycle
    options?: Partial<JWTClaimVerificationOptions>
  ): Promise<{ validationResult: JWTValidationResult; client: unknown }> {
    try {
      // First decode the JWT to extract client ID without verification

      const header = decodeProtectedHeader(assertion);
      const payload = decodeJwt(assertion);

      if (!header.alg) {
        throw new InvalidJWTError('JWT header must contain algorithm (alg) claim');
      }

      // Extract client ID from issuer or subject
      const clientId = payload.iss || payload.sub;
      if (!clientId || typeof clientId !== 'string') {
        throw new InvalidJWTError('JWT must contain valid issuer (iss) or subject (sub) claim');
      }

      // Get client information from store
      const client = await (clientsStore as { getClient: (id: string) => Promise<{ client_secret?: string;[key: string]: unknown }> }).getClient(clientId);
      if (!client) {
        throw new InvalidJWTError(`Client not found: ${clientId}`);
      }

      // Determine key material based on algorithm and client configuration
      let clientSecret: string | undefined;
      let publicKey: string | Buffer | undefined;

      if (header.alg.startsWith('HS')) {
        // HMAC algorithms require client secret
        if (!client.client_secret) {
          throw new InvalidJWTError('Client secret required for HMAC signature verification');
        }
        clientSecret = client.client_secret;
      } else {
        // RSA/ECDSA algorithms require public key
        // In a real implementation, this would come from client.jwks_uri or client.jwks
        // For now, we'll throw an error indicating this needs to be implemented
        throw new UnsupportedJWTAlgorithmError(header.alg);
      }

      // Validate the JWT with the appropriate key material
      const validationOptions: JWTClaimVerificationOptions = {
        audience: tokenEndpoint,
        clockTolerance: 30,
        maxTokenAge: 300,
        ...options,
      };

      const validationResult = await this.validateAssertion(
        assertion,
        clientSecret,
        publicKey,
        validationOptions
      );

      // Additional MCP-compliant validation
      if (validationResult.clientId !== clientId) {
        throw new InvalidJWTError('JWT client ID mismatch');
      }

      return { validationResult, client };
    } catch (error) {
      // Re-throw JWT-specific errors as-is
      if (error instanceof InvalidJWTError ||
        error instanceof UnsupportedJWTAlgorithmError ||
        error instanceof ExpiredJWTError ||
        error instanceof InvalidJWTAudienceError) {
        throw error;
      }

      // Wrap other errors as InvalidJWTError
      throw new InvalidJWTError(`JWT client assertion validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate a JWT bearer assertion for authorization grants
   * This method includes MCP-compliant audience and resource validation
   */
  static async validateBearerAssertionForGrant(
    assertion: string,
    expectedAudience: string,
    resource?: URL,
    options?: Partial<JWTClaimVerificationOptions>
  ): Promise<JWTValidationResult> {
    try {
      // For MCP compliance, create expected audience list that includes resource if provided
      const expectedAudiences = resource ?
        normalizeMCPAudience(expectedAudience, resource) :
        expectedAudience;

      const validationOptions: JWTClaimVerificationOptions = {
        audience: expectedAudiences,
        clockTolerance: 30,
        maxTokenAge: 300,
        ...options,
      };

      // For bearer grants, we need to validate without specific client credentials
      // The JWT should be self-contained with proper signature verification
      const validationResult = await this.validateAssertion(
        assertion,
        undefined, // No client secret for bearer grants
        undefined, // Public key would come from JWKS
        validationOptions
      );

      // Additional MCP resource parameter validation
      if (resource) {
        const resourceUrl = resource.toString();

        // Validate that the JWT contains the resource claim for MCP compliance
        const payload = validationResult.payload as JWTBearerGrantPayload;
        if ('resource' in payload && payload.resource && payload.resource !== resourceUrl) {
          throw new InvalidJWTAudienceError(resourceUrl, String(payload.resource));
        }

        // Ensure the JWT audience is compatible with the requested resource
        if (!validationResult.audience.some(aud =>
          aud === resourceUrl || aud === expectedAudience ||
          // Check if audience matches the resource origin for MCP compatibility
          (new URL(aud).origin === new URL(resourceUrl).origin)
        )) {
          throw new InvalidJWTAudienceError(resourceUrl, validationResult.audience.join(', '));
        }
      }

      return validationResult;
    } catch (error) {
      // Re-throw JWT-specific errors as-is
      if (error instanceof InvalidJWTError ||
        error instanceof UnsupportedJWTAlgorithmError ||
        error instanceof ExpiredJWTError ||
        error instanceof InvalidJWTAudienceError) {
        throw error;
      }

      // Wrap other errors as InvalidJWTError
      throw new InvalidJWTError(`JWT bearer assertion validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Internal method to validate JWT assertions
   * Simplified to use jose library's built-in key handling
   */
  private static async validateAssertion(
    assertion: string,
    secret?: string,
    publicKey?: string | Buffer,
    options?: JWTClaimVerificationOptions
  ): Promise<JWTValidationResult> {
    try {

      // Decode header to determine algorithm
      const header = decodeProtectedHeader(assertion);

      if (!header.alg) {
        throw new InvalidJWTError('JWT header must contain algorithm (alg) claim');
      }

      // Note: Using 'any' here because jose library accepts multiple key types (Uint8Array, KeyLike, JWK)
      // and the exact type depends on the algorithm and key source (HMAC secret vs RSA/ECDSA keys)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let verificationKey: any;

      if (header.alg.startsWith('HS')) {
        // HMAC verification
        if (!secret) {
          throw new InvalidJWTError('Secret required for HMAC signature verification');
        }
        verificationKey = new TextEncoder().encode(secret);
      } else {
        // RSA/ECDSA verification
        if (!publicKey) {
          throw new InvalidJWTError('Public key required for RSA/ECDSA signature verification');
        }

        if (typeof publicKey === 'string') {
          // Let jose library handle key format detection
          try {
            verificationKey = await importSPKI(publicKey, header.alg);
          } catch {
            try {
              verificationKey = await importPKCS8(publicKey, header.alg);
            } catch {
              // Try as JWK if other formats fail
              verificationKey = await importJWK(JSON.parse(publicKey), header.alg);
            }
          }
        } else {
          verificationKey = publicKey;
        }
      }

      // Use validation options directly (they now extend JWTClaimVerificationOptions)
      const validationOptions = options ? {
        ...options,
        clockTolerance: options.clockTolerance || 30,
        maxTokenAge: options.maxTokenAge || 300, // Default maxTokenAge if not provided
      } : {};

      const result = await jwtVerify(assertion, verificationKey, validationOptions);

      const payload = result.payload as JWTClientAssertionPayload | JWTBearerGrantPayload;

      // Extract client ID from issuer or subject
      const clientId = payload.iss || payload.sub;
      if (!clientId) {
        throw new InvalidJWTError('JWT must contain issuer (iss) or subject (sub) claim');
      }

      // Normalize audience to array
      const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

      return {
        payload,
        header: header as JWTHeaderParameters,
        clientId,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
        audience,
      };
    } catch (error) {
      // Re-throw JWT-specific errors as-is
      if (error instanceof InvalidJWTError ||
        error instanceof UnsupportedJWTAlgorithmError ||
        error instanceof ExpiredJWTError ||
        error instanceof InvalidJWTAudienceError) {
        throw error;
      }

      // Check for specific JOSE errors that map to our JWT error types
      if (error instanceof Error) {
        if (error.message.includes('expired') || error.message.includes('exp')) {
          throw new ExpiredJWTError();
        }
        if (error.message.includes('audience') || error.message.includes('aud')) {
          throw new InvalidJWTAudienceError('expected', 'actual');
        }
        if (error.message.includes('algorithm') || error.message.includes('alg')) {
          throw new UnsupportedJWTAlgorithmError('unknown');
        }
      }

      // Wrap other errors as InvalidJWTError
      throw new InvalidJWTError(`JWT validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

/**
 * Utility function to generate a unique JWT ID
 * Uses crypto.randomUUID for better randomness when available
 */
export function generateJwtId(prefix?: string): string {
  try {
    const uuid = randomUUID();
    return prefix ? `${prefix}-${uuid}` : uuid;
  } catch {
    // Fallback to timestamp + random for older environments
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 11);
    return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
  }
}

/**
 * Utility function to check if a JWT algorithm is supported
 * Uses a predefined list of supported algorithms that are compatible with jose library
 */
export function isSupportedJWTAlgorithm(algorithm: string): boolean {
  const supportedAlgorithms = [
    'HS256', 'HS384', 'HS512',
    'RS256', 'RS384', 'RS512',
    'ES256', 'ES384', 'ES512'
  ];
  return supportedAlgorithms.includes(algorithm);
}

/**
 * Utility function to determine the appropriate algorithm based on key material
 */
export function selectJWTAlgorithm(credentials: JWTClientCredentials): string {
  if (credentials.algorithm) {
    return credentials.algorithm;
  }

  // Default algorithm selection
  if (credentials.clientSecret) {
    return 'HS256'; // HMAC with SHA-256
  } else if (credentials.privateKey) {
    return 'RS256'; // RSA with SHA-256
  }

  throw new InvalidJWTError('Cannot determine JWT algorithm: no credentials provided');
}

/**
 * Normalizes audience claims for MCP compliance
 * Ensures proper audience validation for MCP server URLs and resource binding
 * 
 * @param primaryAudience - The primary audience (usually token endpoint or authorization server)
 * @param resource - Optional MCP resource URL for resource binding
 * @returns Normalized audience string or array for JWT claims
 */
export function normalizeMCPAudience(primaryAudience: string, resource?: URL): string | string[] {
  // Always include the primary audience (token endpoint or authorization server)
  const audiences = [primaryAudience];

  // For MCP compliance, if a resource is specified, include it in the audience
  // This ensures the JWT is bound to the specific MCP server resource
  if (resource) {
    const resourceUrl = resource.toString();
    // Only add resource URL if it's different from primary audience
    if (resourceUrl !== primaryAudience) {
      audiences.push(resourceUrl);
    }
  }

  // Return single string if only one audience, array if multiple
  return audiences.length === 1 ? audiences[0] : audiences;
}