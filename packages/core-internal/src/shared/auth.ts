// Moved: the OAuth/OpenID schemas + types now live in @modelcontextprotocol/core (packages/core/src/auth.ts).
// This module re-exports them one-to-one so every existing import path keeps working.
//
// Add new schemas in packages/core/src/auth.ts, never here — this file only forwards, and
// core-internal's schemaShims test enforces that it stays free of zod imports and definitions.
export type {
    AuthorizationServerMetadata,
    IdJagTokenExchangeResponse,
    OAuthClientInformation,
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthClientRegistrationError,
    OAuthErrorResponse,
    OAuthMetadata,
    OAuthProtectedResourceMetadata,
    OAuthTokenRevocationRequest,
    OAuthTokens,
    OpenIdProviderDiscoveryMetadata,
    OpenIdProviderMetadata,
    StoredOAuthClientInformation,
    StoredOAuthTokens
} from '@modelcontextprotocol/core/internal';
export {
    IdJagTokenExchangeResponseSchema,
    OAuthClientInformationFullSchema,
    OAuthClientInformationSchema,
    OAuthClientMetadataSchema,
    OAuthClientRegistrationErrorSchema,
    OAuthErrorResponseSchema,
    OAuthMetadataSchema,
    OAuthProtectedResourceMetadataSchema,
    OAuthTokenRevocationRequestSchema,
    OAuthTokensSchema,
    OpenIdProviderDiscoveryMetadataSchema,
    OpenIdProviderMetadataSchema,
    OptionalSafeUrlSchema,
    SafeUrlSchema
} from '@modelcontextprotocol/core/internal';
