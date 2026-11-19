import {
    SafeUrlSchema,
    OAuthMetadataSchema,
    OpenIdProviderMetadataSchema,
    OpenIdProviderDiscoveryMetadataSchema,
    OAuthClientMetadataSchema,
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

describe('OpenIdProviderDiscoveryMetadataSchema', () => {
    const discoveryDocument = {
        issuer: 'https://issuer.example.com',
        authorization_endpoint: 'https://issuer.example.com/oauth2/authorize',
        token_endpoint: 'https://issuer.example.com/oauth2/token',
        jwks_uri: 'https://issuer.example.com/oauth2/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        revocation_endpoint: 'https://issuer.example.com/oauth2/revoke',
        revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
        revocation_endpoint_auth_signing_alg_values_supported: ['RS256']
    };

    it('keeps the OAuth revocation fields an OIDC discovery document publishes', () => {
        const parsed = OpenIdProviderDiscoveryMetadataSchema.parse(discoveryDocument);

        expect(parsed.revocation_endpoint).toBe('https://issuer.example.com/oauth2/revoke');
        expect(parsed.revocation_endpoint_auth_methods_supported).toEqual(['client_secret_basic']);
        expect(parsed.revocation_endpoint_auth_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('rejects a revocation endpoint that is not a safe URL', () => {
        expect(() =>
            OpenIdProviderDiscoveryMetadataSchema.parse({ ...discoveryDocument, revocation_endpoint: 'javascript:alert(1)' })
        ).toThrow('URL cannot use javascript:, data:, or vbscript: scheme');
    });

    it('keeps fields that neither the OIDC nor the OAuth schema declares', () => {
        const parsed = OpenIdProviderDiscoveryMetadataSchema.parse({
            ...discoveryDocument,
            org_alias: 'example-tenant'
        }) as Record<string, unknown>;

        expect(parsed.org_alias).toBe('example-tenant');
    });

    it('still rejects a document missing a required OIDC field', () => {
        const incomplete: Partial<typeof discoveryDocument> = { ...discoveryDocument };
        delete incomplete.response_types_supported;

        expect(() => OpenIdProviderDiscoveryMetadataSchema.parse(incomplete)).toThrow();
    });
});
