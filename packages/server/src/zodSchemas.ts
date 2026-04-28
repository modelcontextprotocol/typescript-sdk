/**
 * v1-compat re-export of all protocol Zod schemas.
 *
 * Prefer `specTypeSchemas` / `isSpecType` (from `@modelcontextprotocol/server`)
 * for runtime validation. These are Zod schemas; their TS type may change with
 * internal Zod upgrades.
 *
 * @deprecated Use `specTypeSchemas` / `isSpecType` for runtime validation.
 * @packageDocumentation
 */

/** @deprecated Use `specTypeSchemas` / `isSpecType` for runtime validation. */
export * from '@modelcontextprotocol/core/schemas';

/** @deprecated Use `specTypeSchemas` / `isSpecType` for runtime validation. */
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
    JSONRPCErrorResponseSchema as JSONRPCErrorSchema,
    /** @deprecated Use {@linkcode ResourceTemplateReferenceSchema}. */
    ResourceTemplateReferenceSchema as ResourceReferenceSchema
} from '@modelcontextprotocol/core/schemas';
