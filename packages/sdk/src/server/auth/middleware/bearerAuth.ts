// v1 compat: `@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js`
// Re-exports from server-auth-legacy (not @modelcontextprotocol/express) so that
// `requireBearerAuth`'s `instanceof OAuthError` check matches the error classes
// re-exported by the sibling `server/auth/*` subpaths.
export * from '@modelcontextprotocol/server-auth-legacy';
