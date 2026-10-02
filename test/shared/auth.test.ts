import {
    SafeUrlSchema,
    OAuthMetadataSchema,
    OpenIdProviderMetadataSchema,
    OAuthClientMetadataSchema,
    OAuthTokensSchema,
    OAuthTokenResponseSchema,
    OptionalSafeUrlSchema
} from '../../src/shared/auth.js';
import * as z from 'zod/v4';

describe('SafeUrlSchema', () => {
    it('accepts valid HTTPS URLs', () => {
        expect(SafeUrlSchema.parse('https://example.com')).toBe('https://example.com');
        expect(SafeUrlSchema.parse('https://auth.example.com/oauth/authorize')).toBe('https://auth.example.com/oauth/authorize');
    });

    it('accepts valid HTTP URLs', () => {
        expect(SafeUrlSchema.parse('http://localhost:3000')).toBe('http://localhost:3000');
    });

    it('rejects javascript: scheme URLs', () => {
        expect(() => SafeUrlSchema.parse('javascript:alert(1)')).toThrow('URL cannot use javascript:, data:, or vbscript: scheme');
        expect(() => SafeUrlSchema.parse('JAVASCRIPT:alert(1)')).toThrow('URL cannot use javascript:, data:, or vbscript: scheme');
    });

    it('rejects invalid URLs', () => {
        expect(() => SafeUrlSchema.parse('not-a-url')).toThrow();
        expect(() => SafeUrlSchema.parse('')).toThrow();
    });

    it('works with safeParse', () => {
        expect(() => SafeUrlSchema.safeParse('not-a-url')).not.toThrow();
    });
});

describe('OptionalSafeUrlSchema', () => {
    it('accepts empty string and transforms it to undefined', () => {
        expect(OptionalSafeUrlSchema.parse('')).toBe(undefined);
    });
});

describe('OAuthMetadataSchema', () => {
    it('validates complete OAuth metadata', () => {
        const metadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/oauth/authorize',
            token_endpoint: 'https://auth.example.com/oauth/token',
            response_types_supported: ['code'],
            scopes_supported: ['read', 'write']
        };

        expect(() => OAuthMetadataSchema.parse(metadata)).not.toThrow();
    });

    it('rejects metadata with javascript: URLs', () => {
        const metadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'javascript:alert(1)',
            token_endpoint: 'https://auth.example.com/oauth/token',
            response_types_supported: ['code']
        };

        expect(() => OAuthMetadataSchema.parse(metadata)).toThrow('URL cannot use javascript:, data:, or vbscript: scheme');
    });

    it('requires mandatory fields', () => {
        const incompleteMetadata = {
            issuer: 'https://auth.example.com'
        };

        expect(() => OAuthMetadataSchema.parse(incompleteMetadata)).toThrow();
    });
});

describe('OpenIdProviderMetadataSchema', () => {
    it('validates complete OpenID Provider metadata', () => {
        const metadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/oauth/authorize',
            token_endpoint: 'https://auth.example.com/oauth/token',
            jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256']
        };

        expect(() => OpenIdProviderMetadataSchema.parse(metadata)).not.toThrow();
    });

    it('rejects metadata with javascript: in jwks_uri', () => {
        const metadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/oauth/authorize',
            token_endpoint: 'https://auth.example.com/oauth/token',
            jwks_uri: 'javascript:alert(1)',
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256']
        };

        expect(() => OpenIdProviderMetadataSchema.parse(metadata)).toThrow('URL cannot use javascript:, data:, or vbscript: scheme');
    });
});

describe('OAuthTokensSchema', () => {
    it('round-trips a fully-populated token response', () => {
        const tokens = OAuthTokensSchema.parse({
            access_token: 'access-123',
            id_token: 'id-456',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'read write',
            refresh_token: 'refresh-789'
        });

        expect(tokens).toEqual({
            access_token: 'access-123',
            id_token: 'id-456',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'read write',
            refresh_token: 'refresh-789'
        });
    });

    it('accepts a token response with optional fields absent', () => {
        const tokens = OAuthTokensSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer'
        });

        expect(tokens.access_token).toBe('access-123');
        expect(tokens.token_type).toBe('Bearer');
        expect(tokens.id_token).toBeUndefined();
        expect(tokens.expires_in).toBeUndefined();
        expect(tokens.scope).toBeUndefined();
        expect(tokens.refresh_token).toBeUndefined();
    });

    // The strict schema is deliberately unchanged: null optional members are
    // only normalized by OAuthTokenResponseSchema below.
    it.each(['refresh_token', 'scope', 'id_token'])('still rejects a null %s', field => {
        expect(() =>
            OAuthTokensSchema.parse({
                access_token: 'access-123',
                token_type: 'Bearer',
                [field]: null
            })
        ).toThrow();
    });

    it('remains an object schema usable with .shape and .extend', () => {
        // Regression test: wrapping the exported schema (e.g. in
        // z.preprocess) would change its class and break downstream
        // consumers that call .extend() or introspect .shape.
        expect(OAuthTokensSchema.shape.access_token).toBeDefined();

        const extended = OAuthTokensSchema.extend({ example: z.string() });
        const parsed = extended.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            example: 'value'
        });
        expect(parsed.example).toBe('value');
    });
});

describe('OAuthTokenResponseSchema', () => {
    it.each(['refresh_token', 'scope', 'id_token'])('treats null %s as absent', field => {
        const tokens = OAuthTokenResponseSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            [field]: null
        });

        expect(field in tokens).toBe(false);
    });

    it('treats null expires_in as absent instead of coercing it to 0', () => {
        const tokens = OAuthTokenResponseSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            expires_in: null
        });

        expect('expires_in' in tokens).toBe(false);
        expect(tokens.expires_in).not.toBe(0);
    });

    it('still coerces a string expires_in to a number', () => {
        const tokens = OAuthTokenResponseSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            expires_in: '3600'
        });

        expect(tokens.expires_in).toBe(3600);
    });

    it('accepts a token response with all optional fields null', () => {
        const tokens = OAuthTokenResponseSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            id_token: null,
            expires_in: null,
            scope: null,
            refresh_token: null
        });

        // toStrictEqual: the null members must be truly absent from the
        // output, not present with an undefined value, so that spreads like
        // `{ ...tokens, refresh_token: tokens.refresh_token ?? previous }`
        // (and plain spreads over defaults) keep the previous value.
        expect(tokens).toStrictEqual({
            access_token: 'access-123',
            token_type: 'Bearer'
        });
    });

    it('still rejects a null access_token', () => {
        expect(() =>
            OAuthTokenResponseSchema.parse({
                access_token: null,
                token_type: 'Bearer'
            })
        ).toThrow();
    });

    it('still rejects a missing token_type', () => {
        expect(() =>
            OAuthTokenResponseSchema.parse({
                access_token: 'access-123'
            })
        ).toThrow();
    });

    it('treats null as absent for every optional member of OAuthTokensSchema', () => {
        // Drift guard: if a new optional member is added to
        // OAuthTokensSchema, it is automatically covered by the
        // null-normalization without updating any field list.
        const optionalFields = Object.entries(OAuthTokensSchema.shape)
            .filter(([, fieldSchema]) => fieldSchema.safeParse(undefined).success)
            .map(([field]) => field);

        expect(optionalFields.length).toBeGreaterThan(0);

        for (const field of optionalFields) {
            const tokens = OAuthTokenResponseSchema.parse({
                access_token: 'access-123',
                token_type: 'Bearer',
                [field]: null
            });

            expect(field in tokens).toBe(false);
        }
    });
});

describe('OAuthClientMetadataSchema', () => {
    it('validates client metadata with safe URLs', () => {
        const metadata = {
            redirect_uris: ['https://app.example.com/callback'],
            client_name: 'Test App',
            client_uri: 'https://app.example.com'
        };

        expect(() => OAuthClientMetadataSchema.parse(metadata)).not.toThrow();
    });

    it('rejects client metadata with javascript: redirect URIs', () => {
        const metadata = {
            redirect_uris: ['javascript:alert(1)'],
            client_name: 'Test App'
        };

        expect(() => OAuthClientMetadataSchema.parse(metadata)).toThrow('URL cannot use javascript:, data:, or vbscript: scheme');
    });
});
