/**
 * v1-compat re-export of all protocol Zod schemas.
 *
 * Prefer {@linkcode specTypeSchema} for runtime validation. These are Zod
 * schemas; their TS type may change with internal Zod upgrades.
 *
 * @deprecated Use `specTypeSchema()` for runtime validation.
 * @packageDocumentation
 */

/** @deprecated Use `specTypeSchema()` for runtime validation. */
export * from '@modelcontextprotocol/core/schemas';

/** @deprecated Use `specTypeSchema()` for runtime validation. */
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
} from '@modelcontextprotocol/core';
export {
    /** @deprecated Use {@linkcode JSONRPCErrorResponseSchema}. */
    JSONRPCErrorResponseSchema as JSONRPCErrorSchema
} from '@modelcontextprotocol/core/schemas';
