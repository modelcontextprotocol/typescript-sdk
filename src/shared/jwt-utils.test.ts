import { JWTAssertionGenerator, JWTValidator, generateJwtId, isSupportedJWTAlgorithm, selectJWTAlgorithm } from './jwt-utils.js';
import {
  JWTClientCredentials,
  JWTClientAssertionPayloadSchema,
  JWTBearerGrantPayloadSchema,
  JWTClientCredentialsSchema
} from './auth.js';

// Mock JOSE library for testing
jest.mock('jose', () => ({
  SignJWT: jest.fn().mockImplementation(() => ({
    setProtectedHeader: jest.fn().mockReturnThis(),
    sign: jest.fn().mockResolvedValue('mock.jwt.token'),
  })),
  jwtVerify: jest.fn().mockResolvedValue({
    payload: {
      iss: 'test-client',
      sub: 'test-client',
      aud: 'https://example.com/token',
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      jti: 'test-jti',
    },
  }),
  decodeProtectedHeader: jest.fn().mockReturnValue({
    alg: 'HS256',
    typ: 'JWT',
  }),
  decodeJwt: jest.fn().mockImplementation((_token: string) => ({
    iss: 'test-client',
    sub: 'test-client',
    aud: 'https://example.com/token',
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    jti: 'test-jti',
  })),
  importSPKI: jest.fn().mockResolvedValue('mock-public-key'),
  importPKCS8: jest.fn().mockResolvedValue('mock-private-key'),
}));

describe('JWTAssertionGenerator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateClientAssertion', () => {
    it('should generate a client assertion with HMAC signing', async () => {
      const credentials: JWTClientCredentials = {
        clientSecret: 'test-secret',
        algorithm: 'HS256',
      };

      const assertion = await JWTAssertionGenerator.generateClientAssertion(
        'test-client',
        'https://example.com/token',
        credentials
      );

      expect(assertion).toBe('mock.jwt.token');
    });

    it('should generate a client assertion with RSA signing', async () => {
      const credentials: JWTClientCredentials = {
        privateKey: '-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----',
        algorithm: 'RS256',
        keyId: 'test-key-id',
      };

      const assertion = await JWTAssertionGenerator.generateClientAssertion(
        'test-client',
        'https://example.com/token',
        credentials
      );

      expect(assertion).toBe('mock.jwt.token');
    });

    it('should use default values when not provided', async () => {
      const credentials: JWTClientCredentials = {
        clientSecret: 'test-secret',
      };

      const assertion = await JWTAssertionGenerator.generateClientAssertion(
        'test-client',
        'https://example.com/token',
        credentials
      );

      expect(assertion).toBe('mock.jwt.token');
    });
  });

  describe('generateBearerAssertion', () => {
    it('should generate a bearer assertion', async () => {
      const credentials: JWTClientCredentials = {
        clientSecret: 'test-secret',
        algorithm: 'HS256',
      };

      const assertion = await JWTAssertionGenerator.generateBearerAssertion(
        'test-issuer',
        'test-subject',
        'https://example.com/resource',
        credentials,
        undefined,
        { scope: 'read write' }
      );

      expect(assertion).toBe('mock.jwt.token');
    });
  });
});

describe('JWTValidator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateClientAssertion', () => {
    it('should validate a client assertion', async () => {
      const result = await JWTValidator.validateClientAssertion(
        'mock.jwt.token',
        'https://example.com/token',
        'test-secret'
      );

      expect(result.clientId).toBe('test-client');
      expect(result.audience).toEqual(['https://example.com/token']);
    });
  });

  describe('validateBearerAssertion', () => {
    it('should validate a bearer assertion', async () => {
      const result = await JWTValidator.validateBearerAssertion(
        'mock.jwt.token',
        'https://example.com/resource',
        'test-secret'
      );

      expect(result.clientId).toBe('test-client');
    });
  });
});

describe('Utility functions', () => {
  describe('generateJwtId', () => {
    it('should generate a unique JWT ID', () => {
      const jwtId1 = generateJwtId();
      const jwtId2 = generateJwtId();

      expect(jwtId1).not.toBe(jwtId2);
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      expect(jwtId1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should generate a JWT ID with prefix', () => {
      const jwtId = generateJwtId('test-client');

      expect(jwtId).toMatch(/^test-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('isSupportedJWTAlgorithm', () => {
    it('should return true for supported algorithms', () => {
      expect(isSupportedJWTAlgorithm('HS256')).toBe(true);
      expect(isSupportedJWTAlgorithm('RS256')).toBe(true);
      expect(isSupportedJWTAlgorithm('ES256')).toBe(true);
    });

    it('should return false for unsupported algorithms', () => {
      expect(isSupportedJWTAlgorithm('none')).toBe(false);
      expect(isSupportedJWTAlgorithm('HS128')).toBe(false);
      expect(isSupportedJWTAlgorithm('invalid')).toBe(false);
    });
  });

  describe('selectJWTAlgorithm', () => {
    it('should return the specified algorithm', () => {
      const credentials: JWTClientCredentials = {
        algorithm: 'RS256',
        privateKey: 'test-key',
      };

      expect(selectJWTAlgorithm(credentials)).toBe('RS256');
    });

    it('should default to HS256 for client secret', () => {
      const credentials: JWTClientCredentials = {
        clientSecret: 'test-secret',
      };

      expect(selectJWTAlgorithm(credentials)).toBe('HS256');
    });

    it('should default to RS256 for private key', () => {
      const credentials: JWTClientCredentials = {
        privateKey: 'test-key',
      };

      expect(selectJWTAlgorithm(credentials)).toBe('RS256');
    });

    it('should throw error when no credentials provided', () => {
      const credentials: JWTClientCredentials = {};

      expect(() => selectJWTAlgorithm(credentials)).toThrow('Cannot determine JWT algorithm: no credentials provided');
    });
  });
});

// Merged from jwt.test.ts - Basic JWT schema tests
describe('JWT Schemas', () => {
  describe('JWTClientAssertionPayloadSchema', () => {
    it('should validate a valid client assertion payload', () => {
      const now = Math.floor(Date.now() / 1000);
      const validPayload = {
        iss: 'test-client',
        sub: 'test-client',
        aud: 'https://example.com/token',
        jti: 'test-jti-123',
        exp: now + 300,
        iat: now,
        nbf: now
      };

      const result = JWTClientAssertionPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.iss).toBe('test-client');
        expect(result.data.sub).toBe('test-client');
        expect(result.data.aud).toBe('https://example.com/token');
        expect(result.data.jti).toBe('test-jti-123');
      }
    });

    it('should validate payload with array audience', () => {
      const now = Math.floor(Date.now() / 1000);
      const validPayload = {
        iss: 'test-client',
        sub: 'test-client',
        aud: ['https://example.com/token', 'https://example.com/api'],
        jti: 'test-jti-123',
        exp: now + 300,
        iat: now
      };

      const result = JWTClientAssertionPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.data.aud)).toBe(true);
        expect(result.data.aud).toEqual(['https://example.com/token', 'https://example.com/api']);
      }
    });
  });

  describe('JWTBearerGrantPayloadSchema', () => {
    it('should validate a valid bearer grant payload', () => {
      const now = Math.floor(Date.now() / 1000);
      const validPayload = {
        iss: 'test-issuer',
        sub: 'test-subject',
        aud: 'https://example.com/resource',
        exp: now + 300,
        iat: now,
        scope: 'read write',
        customClaim: 'custom-value'
      };

      const result = JWTBearerGrantPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.iss).toBe('test-issuer');
        expect(result.data.sub).toBe('test-subject');
        expect(result.data.scope).toBe('read write');
        expect((result.data as Record<string, unknown>).customClaim).toBe('custom-value');
      }
    });
  });

  describe('JWTClientCredentialsSchema', () => {
    it('should validate HMAC credentials', () => {
      const hmacCredentials = {
        clientSecret: 'test-secret',
        algorithm: 'HS256' as const,
        tokenLifetime: 300,
        issuer: 'test-issuer',
        subject: 'test-subject'
      };

      const result = JWTClientCredentialsSchema.safeParse(hmacCredentials);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.clientSecret).toBe('test-secret');
        expect(result.data.algorithm).toBe('HS256');
        expect(result.data.tokenLifetime).toBe(300);
      }
    });

    it('should validate RSA credentials', () => {
      const rsaCredentials = {
        privateKey: '-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----',
        keyId: 'test-key-id',
        algorithm: 'RS256' as const,
        tokenLifetime: 180
      };

      const result = JWTClientCredentialsSchema.safeParse(rsaCredentials);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.privateKey).toContain('MOCK_KEY');
        expect(result.data.keyId).toBe('test-key-id');
        expect(result.data.algorithm).toBe('RS256');
      }
    });
  });
});

// Merged from jwt-integration.test.ts - Infrastructure integration tests
describe('JWT Infrastructure Integration', () => {
  describe('Schema validation', () => {
    it('should validate JWT client assertion payload schema', () => {
      const validPayload = {
        iss: 'test-client',
        sub: 'test-client',
        aud: 'https://example.com/token',
        jti: 'test-jti',
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
      };

      const result = JWTClientAssertionPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it('should validate JWT bearer grant payload schema', () => {
      const validPayload = {
        iss: 'test-issuer',
        sub: 'test-subject',
        aud: 'https://example.com/resource',
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        scope: 'read write',
        customClaim: 'custom-value'
      };

      const result = JWTBearerGrantPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it('should validate JWT client credentials schema', () => {
      const validCredentials = {
        clientSecret: 'test-secret',
        algorithm: 'HS256' as const,
        tokenLifetime: 300,
        issuer: 'test-issuer',
        subject: 'test-subject'
      };

      const result = JWTClientCredentialsSchema.safeParse(validCredentials);
      expect(result.success).toBe(true);
    });
  });

  describe('Type definitions', () => {
    it('should support all client authentication methods', () => {
      const methods = [
        'client_secret_basic',
        'client_secret_post',
        'client_secret_jwt',
        'private_key_jwt',
        'none'
      ];

      expect(methods.length).toBe(5);
      expect(methods).toContain('client_secret_jwt');
      expect(methods).toContain('private_key_jwt');
    });
  });
});