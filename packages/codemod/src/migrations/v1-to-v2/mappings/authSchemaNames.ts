// The auth (OAuth / OpenID) Zod schema CONSTANTS that v1 exported from
// `@modelcontextprotocol/sdk/shared/auth.js` and that core still re-exports in v2. The import
// transform routes a `*Schema` symbol imported from that v1 path to core when its name is in this
// set (the corresponding TYPES, e.g. OAuthTokens, resolve by context to @modelcontextprotocol/client |
// /server). This is the v1 auth-schema set — a SUBSET of core's auth exports. v2-only auth schemas
// (e.g. IdJagTokenExchangeResponseSchema) are exported by core but NOT listed here: v1 never had
// them, so there is nothing to migrate. test/v1-to-v2/authSchemaNames.test.ts asserts every name here is
// exported by core (so the rewritten import resolves). Keep alphabetized.
export const AUTH_SCHEMA_NAMES: ReadonlySet<string> = new Set([
    'OAuthClientInformationFullSchema',
    'OAuthClientInformationSchema',
    'OAuthClientMetadataSchema',
    'OAuthClientRegistrationErrorSchema',
    'OAuthErrorResponseSchema',
    'OAuthMetadataSchema',
    'OAuthProtectedResourceMetadataSchema',
    'OAuthTokenRevocationRequestSchema',
    'OAuthTokensSchema',
    'OpenIdProviderDiscoveryMetadataSchema',
    'OpenIdProviderMetadataSchema'
]);

// v1's `@modelcontextprotocol/sdk/shared/auth.js` also exported these as Zod schema CONSTANTS, but they
// are typeless internal URL field-validators (no public spec type), so v2's core deliberately does
// NOT re-export them (see packages/core/src/index.ts) and no other public v2 package exports them.
// They therefore have no v2 home: routed by context they would produce a codemod-introduced "has no
// exported member" error. importPaths emits an actionRequired diagnostic instead of silently breaking.
// test/v1-to-v2/authSchemaNames.test.ts asserts these are NOT in AUTH_SCHEMA_NAMES (and so are not
// claimed to be core exports).
export const AUTH_SCHEMA_NAMES_NO_V2_PUBLIC_EXPORT: ReadonlySet<string> = new Set(['SafeUrlSchema', 'OptionalSafeUrlSchema']);
