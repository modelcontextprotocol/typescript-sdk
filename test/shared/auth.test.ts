import {
    SafeUrlSchema,
    OAuthMetadataSchema,
    OpenIdProviderMetadataSchema,
    OAuthClientMetadataSchema,
    OAuthTokensSchema,
    OptionalSafeUrlSchema
} from '../../src/shared/auth.js';

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

    it('treats null refresh_token as absent', () => {
        const tokens = OAuthTokensSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            refresh_token: null
        });

        expect(tokens.refresh_token).toBeUndefined();
    });

    it('treats null scope as absent', () => {
        const tokens = OAuthTokensSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            scope: null
        });

        expect(tokens.scope).toBeUndefined();
    });

    it('treats null id_token as absent', () => {
        const tokens = OAuthTokensSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            id_token: null
        });

        expect(tokens.id_token).toBeUndefined();
    });

    it('treats null expires_in as absent instead of coercing it to 0', () => {
        const tokens = OAuthTokensSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            expires_in: null
        });

        expect(tokens.expires_in).toBeUndefined();
        expect(tokens.expires_in).not.toBe(0);
    });

    it('accepts a token response with all optional fields null', () => {
        const tokens = OAuthTokensSchema.parse({
            access_token: 'access-123',
            token_type: 'Bearer',
            id_token: null,
            expires_in: null,
            scope: null,
            refresh_token: null
        });

        // toStrictEqual: the null members must be truly absent from the
        // output, not present with an undefined value, so that spreads like
        // `{ refresh_token: previous, ...tokens }` keep the previous value.
        expect(tokens).toStrictEqual({
            access_token: 'access-123',
            token_type: 'Bearer'
        });
    });

    it('still rejects a null access_token', () => {
        expect(() =>
            OAuthTokensSchema.parse({
                access_token: null,
                token_type: 'Bearer'
            })
        ).toThrow();
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
