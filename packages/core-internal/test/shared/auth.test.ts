import * as z from 'zod/v4';

import {
    OAuthClientMetadataSchema,
    OAuthMetadataSchema,
    OAuthTokenResponseSchema,
    OAuthTokensSchema,
    OpenIdProviderMetadataSchema,
    OptionalSafeUrlSchema,
    SafeUrlSchema
} from '../../src/shared/auth';

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
    it('parses a fully-populated token response unchanged', () => {
        const tokens = OAuthTokensSchema.parse({
            access_token: 'access123',
            id_token: 'id123',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'read write',
            refresh_token: 'refresh123'
        });

        expect(tokens).toEqual({
            access_token: 'access123',
            id_token: 'id123',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'read write',
            refresh_token: 'refresh123'
        });
    });

    it('parses a token response with optional fields absent', () => {
        const tokens = OAuthTokensSchema.parse({
            access_token: 'access123',
            token_type: 'Bearer'
        });

        expect(tokens.access_token).toBe('access123');
        expect(tokens.token_type).toBe('Bearer');
        expect(tokens.id_token).toBeUndefined();
        expect(tokens.expires_in).toBeUndefined();
        expect(tokens.scope).toBeUndefined();
        expect(tokens.refresh_token).toBeUndefined();
    });

    it('rejects null-valued members (null normalization lives in OAuthTokenResponseSchema)', () => {
        expect(
            OAuthTokensSchema.safeParse({
                access_token: 'access123',
                token_type: 'Bearer',
                refresh_token: null
            }).success
        ).toBe(false);
        expect(
            OAuthTokensSchema.safeParse({
                access_token: null,
                token_type: 'Bearer'
            }).success
        ).toBe(false);
    });

    it('remains a plain ZodObject with an introspectable shape (regression pin: consumers use .shape/.extend)', () => {
        expect(OAuthTokensSchema).toBeInstanceOf(z.ZodObject);
        expect(Object.keys(OAuthTokensSchema.shape).sort()).toEqual([
            'access_token',
            'expires_in',
            'id_token',
            'refresh_token',
            'scope',
            'token_type'
        ]);

        const extended = OAuthTokensSchema.extend({ example_extension: z.string() });
        expect(
            extended.parse({
                access_token: 'access123',
                token_type: 'Bearer',
                example_extension: 'ext'
            }).example_extension
        ).toBe('ext');

        // Optional members must stay optional in z.input — a compile-time pin
        // (a schema-level preprocess would degrade these keys to required `unknown`).
        const minimalInput: z.input<typeof OAuthTokensSchema> = {
            access_token: 'access123',
            token_type: 'Bearer'
        };
        expect(OAuthTokensSchema.parse(minimalInput)).toStrictEqual({
            access_token: 'access123',
            token_type: 'Bearer'
        });
    });
});

describe('OAuthTokenResponseSchema', () => {
    it.each(['refresh_token', 'scope', 'id_token'] as const)(
        'treats a null %s as absent (some auth servers serialize absent members as null)',
        field => {
            const tokens = OAuthTokenResponseSchema.parse({
                access_token: 'access123',
                token_type: 'Bearer',
                [field]: null
            });

            expect(field in tokens).toBe(false);
        }
    );

    it('strips all null-valued optional members so the keys are strictly absent', () => {
        const tokens = OAuthTokenResponseSchema.parse({
            access_token: 'access123',
            token_type: 'Bearer',
            expires_in: null,
            scope: null,
            refresh_token: null,
            id_token: null
        });

        // toStrictEqual distinguishes absent keys from present-but-undefined keys.
        // Key absence is load-bearing: refreshAuthorization spreads the parsed
        // response when merging with previously-stored tokens, and a present
        // `refresh_token: undefined` key would clobber the preserved refresh token.
        expect(tokens).toStrictEqual({
            access_token: 'access123',
            token_type: 'Bearer'
        });
    });

    it('treats a null expires_in as absent rather than coercing it to 0 (an instantly-expired token)', () => {
        const tokens = OAuthTokenResponseSchema.parse({
            access_token: 'access123',
            token_type: 'Bearer',
            expires_in: null
        });

        expect('expires_in' in tokens).toBe(false);
        expect(tokens.expires_in).not.toBe(0);
    });

    it('still coerces string expires_in values to numbers', () => {
        const tokens = OAuthTokenResponseSchema.parse({
            access_token: 'access123',
            token_type: 'Bearer',
            expires_in: '3600'
        });

        expect(tokens.expires_in).toBe(3600);
    });

    it('still rejects a null access_token (only optional members are normalized)', () => {
        expect(
            OAuthTokenResponseSchema.safeParse({
                access_token: null,
                token_type: 'Bearer'
            }).success
        ).toBe(false);
    });

    it('still rejects a missing token_type', () => {
        expect(
            OAuthTokenResponseSchema.safeParse({
                access_token: 'access123'
            }).success
        ).toBe(false);
    });

    it('normalizes a null in every optional member of OAuthTokensSchema (drift guard for future members)', () => {
        for (const [key, memberSchema] of Object.entries(OAuthTokensSchema.shape)) {
            if (!memberSchema.safeParse(undefined).success) {
                continue; // Required member — nulls must keep failing, covered above.
            }

            const tokens = OAuthTokenResponseSchema.parse({
                access_token: 'access123',
                token_type: 'Bearer',
                [key]: null
            });

            expect(key in tokens).toBe(false);
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

    it('parses application_type when native or web', () => {
        for (const value of ['native', 'web'] as const) {
            const parsed = OAuthClientMetadataSchema.parse({ redirect_uris: ['https://app.example.com/cb'], application_type: value });
            expect(parsed.application_type).toBe(value);
        }
    });

    it('passes through a non-enum application_type rather than rejecting (tolerant of AS extension values)', () => {
        const parsed = OAuthClientMetadataSchema.parse({
            redirect_uris: ['https://app.example.com/cb'],
            application_type: 'service'
        });
        expect(parsed.application_type).toBe('service');
    });
});
